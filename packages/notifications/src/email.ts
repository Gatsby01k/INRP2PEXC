import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { Db } from '@inrp2p/db';
import { type NotificationAdapter, deliveryFailureOf } from '@inrp2p/adapters';
import type { OutboxHandler } from '@inrp2p/outbox';

/**
 * The second channel: the same message, by email.
 *
 * The in-app inbox is the channel of record — it is written from the event, inside the outbox, and it is what the
 * client product reads. Email is a copy of that row, sent to the people who would otherwise have to be looking at
 * the product to know. So this handler never composes anything of its own: it reads the notification the inbox
 * handler already wrote for the same event and sends that text. If the two channels could word things
 * differently, one of them would eventually be wrong.
 *
 * Not every notification earns an email. A client who has just accepted a quote is looking at the trade; a client
 * whose quote is ready, whose request was declined, whose trade settled, or whose payout destinations changed, is
 * probably not. The quiet kinds stay in the inbox.
 */
const EMAILED = new Set([
  'QUOTE_SENT', 'REQUEST_DECLINED', 'TRADE_COMPLETED', 'TRADE_CANCELLED', 'DESTINATION_ADDED', 'DESTINATION_ARCHIVED',
  // A trader is often not looking at the product when an order arrives or its turn comes.
  'TRADER_APPROVED', 'TRADER_REJECTED', 'TRADER_PAUSED', 'TRADER_ORDER_NEW', 'TRADER_ACTION_REQUIRED', 'TRADER_ORDER_COMPLETED', 'TRADER_RESERVE_ISSUE',
]);

export interface EmailChannelOptions {
  /** Origin of the client product, so a link in an email opens the right deployment. No link is sent without it. */
  readonly linkBase?: string | undefined;
}

function absolute(base: string | undefined, href: string | null): string | null {
  if (!base || !href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/**
 * One recipient's delivery id — and so the provider's idempotency key — derived from the event and the person, never
 * drawn at random (E4). A database restored to before the email was recorded still holds the event, delivers it again,
 * and asks the provider with the same key, which the provider recognises within its idempotency window instead of
 * sending a second email. A name-based UUID (version 8, RFC 9562): the first 16 bytes of a SHA-256.
 */
export function emailDeliveryId(outboxEventId: string, userId: string): string {
  const b = createHash('sha256').update(`inrp2p.client-notification-email:${outboxEventId}:${userId}`).digest().subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Attempts per recipient before a delivery is given up as FAILED; the outbox's own retries run alongside. */
export const MAX_EMAIL_ATTEMPTS = 8;

export interface EmailReport {
  readonly sent: number;
  readonly failed: number;
  readonly pending: number;
}

/**
 * An email is news. One about something that happened more than this long before the worker could send it — a
 * worker that was down, or a backlog an earlier release left with no worker at all (D-18: production's first worker
 * found events weeks old) — would arrive as if it were news, and mislead: "your quote is ready" for a quote long
 * closed. The inbox entry is written as always; the email is withheld. What happened stays readable from the rows —
 * an emailed kind with no delivery and an event dispatched more than this long after it was written — and the worker
 * says so in its log. Codes that confirm a quote are not notifications and are not affected.
 */
export const EMAIL_STALE_AFTER_HOURS = 24;

/**
 * Sends one notification row by email to each recipient, once each. Returns what became of the recipients, or `null`
 * when the row was not eligible (an inbox-only kind, nobody verified to send it to, or an event too old to be news —
 * `EMAIL_STALE_AFTER_HOURS`, judged once, before any delivery exists, so a send already under way is never dropped).
 *
 * Each recipient is a `client_notification_email` row (migration 0031), created once; its id — derived from the event
 * and the person (`emailDeliveryId`) — is the provider's idempotency key, so a redelivered event, a crash after the
 * provider answered, a retry after a timeout, or the same event delivered again by a restored database sends the same
 * email, never another. A row is SENT only with the provider's message id; a refusal makes it FAILED; an outage
 * leaves it PENDING with the attempt counted and an error code, and the handler then throws so the outbox tries again
 * — after `MAX_EMAIL_ATTEMPTS` it is FAILED and visible (`email_deliveries_failing`). Nothing here is ever marked as
 * sent because it was attempted. `email_sent_at` is written when every recipient has it.
 */
export async function emailNotification(db: Db, adapter: NotificationAdapter, input: { outboxEventId: string } & EmailChannelOptions): Promise<EmailReport | null> {
  const row = await db
    .selectFrom('client_notification')
    .select(['id', 'client_id', 'user_id', 'kind', 'title', 'body', 'href', 'email_sent_at'])
    .where('outbox_event_id', '=', input.outboxEventId)
    .executeTakeFirst();
  if (!row || !EMAILED.has(row.kind)) return null;

  const existing = await db.selectFrom('client_notification_email').select('id').where('notification_id', '=', row.id).limit(1).executeTakeFirst();
  if (!existing) {
    const age = (await sql<{ stale: boolean; hours: number }>`
      select inrp2p_now() - created_at > make_interval(hours => ${EMAIL_STALE_AFTER_HOURS}) as stale,
             floor(extract(epoch from (inrp2p_now() - created_at)) / 3600)::int as hours
        from outbox_event where id = ${input.outboxEventId}`.execute(db)).rows[0];
    if (age?.stale) {
      console.warn(JSON.stringify({ level: 'warn', event: 'client_email.withheld_stale', notification: row.id, kind: row.kind, event_age_hours: age.hours }));
      return null;
    }
    let recipients = db
      .selectFrom('client_user as cu')
      .innerJoin('auth_user as u', 'u.id', 'cu.user_id')
      .select(['u.id as user_id', 'u.email'])
      .where('cu.client_id', '=', row.client_id)
      .where('cu.status', '=', 'ACTIVE')
      .where('u.status', '=', 'ACTIVE')
      .where('u.kind', '=', 'CLIENT')
      // An unverified address is not this client's address yet; a notification is not the way to find that out.
      .where('u.email_verified', '=', true);
    if (row.user_id) recipients = recipients.where('cu.user_id', '=', row.user_id);
    const to = await recipients.execute();
    if (to.length === 0) return null;
    await db
      .insertInto('client_notification_email')
      .values(to.map((r) => ({ id: emailDeliveryId(input.outboxEventId, r.user_id), notification_id: row.id, user_id: r.user_id, address: r.email })))
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  const link = absolute(input.linkBase, row.href);
  const open = await db.selectFrom('client_notification_email').select('id').where('notification_id', '=', row.id).where('status', '=', 'PENDING').orderBy('id').execute();
  for (const d of open) await sendOne(db, adapter, d.id, { subject: row.title, body: row.body, link });

  const states = await db.selectFrom('client_notification_email').select('status').where('notification_id', '=', row.id).execute();
  const report = {
    sent: states.filter((x) => x.status === 'SENT').length,
    failed: states.filter((x) => x.status === 'FAILED').length,
    pending: states.filter((x) => x.status === 'PENDING').length,
  };
  if (report.sent === states.length) {
    await db.updateTable('client_notification').set({ email_sent_at: sql<Date>`inrp2p_now()` }).where('id', '=', row.id).where('email_sent_at', 'is', null).execute();
  }
  if (report.pending > 0) throw new Error(`EMAIL_DELIVERY_PENDING: ${report.pending} of ${states.length} recipients not reached yet`);
  return report;
}

/** One recipient, under its row's lock for the length of the send, so two runs never send it at once. */
async function sendOne(db: Db, adapter: NotificationAdapter, deliveryId: string, message: { subject: string; body: string; link: string | null }): Promise<void> {
  await db.transaction().execute(async (tx) => {
    const d = await tx.selectFrom('client_notification_email').select(['id', 'address', 'status', 'attempts']).where('id', '=', deliveryId).forUpdate().executeTakeFirstOrThrow();
    if (d.status !== 'PENDING') return;
    try {
      const { providerMessageId } = await adapter.sendClientNotification({ deliveryId: d.id, to: d.address, ...message });
      await tx
        .updateTable('client_notification_email')
        .set({ status: 'SENT', attempts: d.attempts + 1, provider_message_id: providerMessageId.slice(0, 200), sent_at: sql<Date>`inrp2p_now()`, last_error: null })
        .where('id', '=', d.id)
        .execute();
    } catch (e) {
      const failure = deliveryFailureOf(e);
      const attempts = d.attempts + 1;
      const final = !failure.retryable || attempts >= MAX_EMAIL_ATTEMPTS;
      await tx
        .updateTable('client_notification_email')
        .set({ attempts, last_error: failure.code.slice(0, 80), ...(final ? { status: 'FAILED' as const, failed_at: sql<Date>`inrp2p_now()` } : {}) })
        .where('id', '=', d.id)
        .execute();
    }
  });
}

/**
 * Outbox handler for the email channel. Register it **after** the inbox handler: they run in order within one
 * dispatch, so the row this one reads is the row that one just wrote.
 *
 * Register it only when an email provider exists. With none configured every send throws, and because a throwing
 * handler fails its event, an unconfigured deployment would retry — and eventually fail — every client event it
 * emits, taking the working in-app channel down with it.
 */
export function clientNotificationEmailHandler(db: Db, adapter: NotificationAdapter, opts: EmailChannelOptions = {}): OutboxHandler {
  return {
    name: 'client_notification_email',
    handles: (type) => type.startsWith('client.') || type.startsWith('trader.') || type === 'quote.sent' || type === 'trade.opened' || type === 'desk.payout_actionable',
    run: async (event) => {
      await emailNotification(db, adapter, { outboxEventId: event.id, ...opts });
    },
  };
}
