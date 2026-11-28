import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { Db } from '@inrp2p/db';
import { type NotificationAdapter, type TelegramAdapter, type WebPushAdapter, deliveryFailureOf } from '@inrp2p/adapters';
import type { OutboxEvent, OutboxHandler } from '@inrp2p/outbox';
import { queuePush, queueTelegram, recordNotification, sendPushDeliveries, sendTelegramDeliveries } from '@inrp2p/notifications';
import { TELEGRAM_PROVIDER, isTelegramPlaceholderEmail } from '@inrp2p/identity';
import { quietTokenHash } from './preference.ts';

/**
 * Delivering what the robot decided to say (ADR 0034 §2.4). A member gets the note in their inbox — the channel of record,
 * written once per event — and on the one channel outside the app the touch was given: their Telegram, their browser, or
 * their email. Someone with no account yet has no inbox; the touch reaches them on its channel or not at all.
 *
 * Each external send is made once: a linked Telegram or a browser through their delivery tables (keyed by the touch), an
 * email or an account's own Telegram under the touch's row lock with its attempts counted. A message older than six
 * hours by the time it could go is not sent — it would arrive as news when it no longer is. The person's consent is read
 * again just before anything leaves.
 */
export interface RobotChannels {
  readonly telegram?: TelegramAdapter | null;
  readonly push?: WebPushAdapter | null;
  readonly email?: NotificationAdapter | null;
  /** Origin of the client product: links in messages open it. No link is sent without it. */
  readonly linkBase?: string | undefined;
}

export const ROBOT_STALE_HOURS = 6;
const MAX_ATTEMPTS = 6;

const absolute = (base: string | undefined, href: string | null): string | null => {
  if (!base || !href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
};

/** A reference worth showing as the note's subject; a playbook's own subjects ("account", "destination") are not. */
const refLike = (subject: string): string | null => (/^[A-Z]{2}-\d{6}-\d{4,}$/.test(subject) ? subject : null);

type Outcome = 'SENT' | 'FAILED' | 'PENDING';

async function markDelivery(db: Db, touchId: string, outcome: Outcome, info: { ref?: string | null; error?: string | null; attempts?: number }): Promise<void> {
  await db.updateTable('robot_touch')
    .set({
      delivery: outcome,
      ...(info.attempts !== undefined ? { delivery_attempts: info.attempts } : {}),
      ...(info.ref ? { delivery_ref: info.ref.slice(0, 200) } : {}),
      delivery_error: info.error ? info.error.slice(0, 80) : null,
      ...(outcome === 'SENT' ? { delivered_at: sql<Date>`inrp2p_now()` } : {}),
    })
    .where('id', '=', touchId).where('delivery', '=', 'PENDING')
    .execute();
}

/** One direct send under the touch's row lock: an email, or a message to the Telegram an account signed in with. */
async function sendDirect(db: Db, touchId: string, send: (row: { id: string; attempts: number }, tx: Db) => Promise<string>): Promise<Outcome> {
  return db.transaction().execute(async (tx) => {
    const t = await tx.selectFrom('robot_touch').select(['id', 'delivery', 'delivery_attempts']).where('id', '=', touchId).forUpdate().executeTakeFirst();
    if (!t || t.delivery !== 'PENDING') return t?.delivery === 'SENT' ? 'SENT' : 'FAILED';
    const attempts = t.delivery_attempts + 1;
    try {
      const ref = await send({ id: t.id, attempts }, tx as unknown as Db);
      await tx.updateTable('robot_touch').set({ delivery: 'SENT', delivery_attempts: attempts, delivery_ref: ref.slice(0, 200), delivery_error: null, delivered_at: sql<Date>`inrp2p_now()` }).where('id', '=', t.id).execute();
      return 'SENT';
    } catch (e) {
      const failure = deliveryFailureOf(e);
      const final = !failure.retryable || attempts >= MAX_ATTEMPTS;
      await tx.updateTable('robot_touch').set({ delivery_attempts: attempts, delivery_error: failure.code.slice(0, 80), ...(final ? { delivery: 'FAILED' as const } : {}) }).where('id', '=', t.id).execute();
      return final ? 'FAILED' : 'PENDING';
    }
  });
}

export async function deliverTouch(db: Db, ch: RobotChannels, event: OutboxEvent, touchId: string): Promise<Outcome | 'NONE'> {
  const t = await db.selectFrom('robot_touch as t')
    .innerJoin('auth_user as u', 'u.id', 't.user_id')
    .leftJoin('robot_preference as p', 'p.user_id', 't.user_id')
    .select(['t.id', 't.user_id', 't.client_id', 't.playbook', 't.subject', 't.mode', 't.channel', 't.title', 't.body', 't.href', 't.delivery', 'u.email', 'u.email_verified', 'p.outreach'])
    .select(sql<boolean>`t.created_at < inrp2p_now() - make_interval(hours => ${ROBOT_STALE_HOURS})`.as('stale'))
    .where('t.id', '=', touchId)
    .executeTakeFirst();
  if (!t || t.mode !== 'LIVE') return 'NONE';
  if (t.client_id) {
    await recordNotification(db, { clientId: t.client_id, userId: t.user_id, kind: 'ROBOT_NOTE', title: t.title, body: t.body, subjectRef: refLike(t.subject), href: t.href, outboxEventId: event.id });
  }
  if (t.delivery !== 'PENDING' || !t.channel) return t.delivery === 'SENT' ? 'SENT' : 'NONE';
  if (t.stale) {
    await markDelivery(db, t.id, 'FAILED', { error: 'STALE' });
    return 'FAILED';
  }
  // The person may have said "nothing outside the app" in the minute since the robot decided.
  if (t.outreach === 'NONE') {
    await markDelivery(db, t.id, 'FAILED', { error: 'CONSENT_WITHDRAWN' });
    return 'FAILED';
  }
  const link = absolute(ch.linkBase, t.href);
  switch (t.channel) {
    case 'TELEGRAM': {
      if (!ch.telegram) return fail(db, t.id, 'CHANNEL_UNCONFIGURED');
      const text = `${t.title}\n\n${t.body}\n\nReply /quiet and Bhai stops these.`;
      if (t.client_id) {
        const ids = await queueTelegram(db, { clientId: t.client_id, userId: t.user_id, dedupeKey: `robot:${t.id}`, body: text, buttonUrl: link });
        if (ids.length === 0) {
          const any = await db.selectFrom('telegram_delivery').select('status').where('dedupe_key', '=', `robot:${t.id}`).where('status', '=', 'SENT').executeTakeFirst();
          return any ? (await markDelivery(db, t.id, 'SENT', { ref: 'telegram_delivery' }), 'SENT') : fail(db, t.id, 'NO_CHAT');
        }
        const out = await sendTelegramDeliveries(db, ch.telegram, ids);
        if (out.sent > 0) await markDelivery(db, t.id, 'SENT', { ref: 'telegram_delivery' });
        else await markDelivery(db, t.id, 'FAILED', { error: 'TELEGRAM_FAILED' });
        return out.sent > 0 ? 'SENT' : 'FAILED';
      }
      const account = await db.selectFrom('auth_account').select('account_id').where('user_id', '=', t.user_id).where('provider_id', '=', TELEGRAM_PROVIDER).executeTakeFirst();
      if (!account) return fail(db, t.id, 'NO_CHAT');
      const bot = ch.telegram;
      return pending(await sendDirect(db, t.id, async () => (await bot.send({ chatId: account.account_id, text, ...(link ? { button: { text: 'Open in INRP2P', url: link } } : {}) })).messageId));
    }
    case 'PUSH': {
      if (!ch.push || !t.client_id) return fail(db, t.id, 'CHANNEL_UNCONFIGURED');
      const ids = await queuePush(db, { clientId: t.client_id, userId: t.user_id, dedupeKey: `robot:${t.id}`, title: t.title, body: t.body, url: t.href });
      if (ids.length === 0) return fail(db, t.id, 'NO_BROWSER');
      const out = await sendPushDeliveries(db, ch.push, ids);
      if (out.sent > 0) await markDelivery(db, t.id, 'SENT', { ref: 'push_delivery' });
      else await markDelivery(db, t.id, 'FAILED', { error: 'PUSH_FAILED' });
      return out.sent > 0 ? 'SENT' : 'FAILED';
    }
    case 'EMAIL': {
      if (!ch.email) return fail(db, t.id, 'CHANNEL_UNCONFIGURED');
      if (!t.email_verified || isTelegramPlaceholderEmail(t.email)) return fail(db, t.id, 'NO_EMAIL');
      const adapter = ch.email;
      const address = t.email;
      return pending(await sendDirect(db, t.id, async (row, tx) => {
        // A fresh opt-out token for this email, its hash kept on the touch; a retry replaces one that was never sent.
        const token = randomBytes(24).toString('base64url');
        await tx.updateTable('robot_touch').set({ quiet_token_hash: quietTokenHash(token) }).where('id', '=', row.id).execute();
        const stop = absolute(ch.linkBase, `/robot-quiet/${row.id}.${token}`);
        const footer = stop ? `\n\n—\nYou get this because you signed in at INRP2P. Stop Bhai's messages: ${stop}` : '';
        const { providerMessageId } = await adapter.sendClientNotification({ deliveryId: row.id, to: address, subject: t.title, body: `${t.body}${footer}`, link });
        return providerMessageId;
      }));
    }
    default:
      return 'NONE';
  }
}

async function fail(db: Db, touchId: string, error: string): Promise<'FAILED'> {
  await markDelivery(db, touchId, 'FAILED', { error });
  return 'FAILED';
}

/** A send that is still pending throws, so the outbox tries the event again; its attempts are counted on the touch. */
function pending(o: Outcome): Outcome {
  if (o === 'PENDING') throw new Error('ROBOT_DELIVERY_PENDING: the channel did not take it yet');
  return o;
}

/**
 * The desk's answer to a question the robot passed on reaches the person who asked: in the inbox when they have one, and
 * where they asked — the Telegram chat — or, asked in the app, on their linked Telegram or by email. Sent once.
 */
export async function deliverCaseAnswer(db: Db, ch: RobotChannels, event: OutboxEvent, caseId: string): Promise<void> {
  const c = await db.selectFrom('robot_case as c')
    .leftJoin('auth_user as u', 'u.id', 'c.user_id')
    .select(['c.id', 'c.ref', 'c.user_id', 'c.client_id', 'c.channel', 'c.telegram_chat_id', 'c.question', 'c.answer', 'c.status', 'c.reply_sent_at', 'u.email', 'u.email_verified'])
    .where('c.id', '=', caseId).executeTakeFirst();
  if (!c || c.status !== 'ANSWERED' || !c.answer) return;
  const title = 'INRP2P answered your question';
  const asked = c.question.length > 140 ? `${c.question.slice(0, 137)}…` : c.question;
  const body = `You asked: “${asked}”\n\n${c.answer}`;
  if (c.client_id && c.user_id) {
    // The inbox holds 400 characters; the whole answer is on the robot's page.
    const note = body.length > 400 ? `${body.slice(0, 380)}… (continued)` : body;
    await recordNotification(db, { clientId: c.client_id, userId: c.user_id, kind: 'ROBOT_REPLY', title, body: note, subjectRef: null, href: '/robot', outboxEventId: event.id });
  }
  if (c.reply_sent_at) return;
  const text = `${title}\n\n${body}`.slice(0, 1000);
  let sent = false;
  if (ch.telegram && c.telegram_chat_id !== null) {
    await ch.telegram.send({ chatId: c.telegram_chat_id.toString(), text });
    sent = true;
  } else if (ch.telegram && c.client_id && c.user_id) {
    const ids = await queueTelegram(db, { clientId: c.client_id, userId: c.user_id, dedupeKey: `robot-case:${c.id}`, body: text, buttonUrl: absolute(ch.linkBase, '/robot') });
    if (ids.length > 0) sent = (await sendTelegramDeliveries(db, ch.telegram, ids)).sent > 0;
  }
  if (!sent && !c.client_id && ch.email && c.email && c.email_verified && !isTelegramPlaceholderEmail(c.email)) {
    await ch.email.sendClientNotification({ deliveryId: c.id, to: c.email, subject: title, body, link: absolute(ch.linkBase, '/exchange') });
    sent = true;
  }
  if (sent) await db.updateTable('robot_case').set({ reply_sent_at: sql<Date>`inrp2p_now()` }).where('id', '=', c.id).where('reply_sent_at', 'is', null).execute();
}

export function robotDeliveryHandler(db: Db, channels: RobotChannels): OutboxHandler {
  return {
    name: 'robot_delivery',
    handles: (type) => type === 'robot.note' || type === 'robot.case_answered',
    run: async (event) => {
      const p = (event.payload ?? {}) as Record<string, unknown>;
      if (event.type === 'robot.note' && typeof p.touchId === 'string') await deliverTouch(db, channels, event, p.touchId);
      if (event.type === 'robot.case_answered' && typeof p.caseId === 'string') await deliverCaseAnswer(db, channels, event, p.caseId);
    },
  };
}
