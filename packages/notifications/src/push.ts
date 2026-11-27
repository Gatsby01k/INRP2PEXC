import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { NotificationDeliveryError, type WebPushAdapter } from '@inrp2p/adapters';
import type { Db } from '@inrp2p/db';
import type { OutboxHandler } from '@inrp2p/outbox';
import { TELEGRAM_INBOX_EVENTS, TELEGRAMMED } from './telegram.ts';

/**
 * Web Push (ADR 0033 §2.6): the inbox notes a person would get on Telegram, pushed to the browsers that person turned
 * notifications on in. It composes nothing of its own — it sends the note the inbox handlers wrote for the event — so it
 * is registered after them. Each push to each browser is one `push_delivery` row whose id is derived from what it is
 * about, so a redelivered event pushes nothing twice; a browser the push service says is gone is dropped.
 */
export const MAX_PUSH_ATTEMPTS = 5;

export function pushDeliveryId(dedupeKey: string, subscriptionId: string): string {
  const b = createHash('sha256').update(`inrp2p.push:${dedupeKey}:${subscriptionId}`).digest().subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface PushAlert {
  readonly clientId: string;
  /** Narrowed to one person, when the note was. */
  readonly userId: string | null;
  readonly dedupeKey: string;
  readonly title: string;
  readonly body: string;
  readonly url: string | null;
}

/** One delivery per active browser of the client's active people (or of the one person); returns those still to send. */
export async function queuePush(db: Db, alert: PushAlert): Promise<string[]> {
  let q = db.selectFrom('push_subscription as s')
    .innerJoin('client_user as cu', 'cu.id', 's.client_user_id')
    .innerJoin('auth_user as u', 'u.id', 'cu.user_id')
    .select('s.id')
    .where('cu.client_id', '=', alert.clientId).where('s.status', '=', 'ACTIVE').where('cu.status', '=', 'ACTIVE').where('u.status', '=', 'ACTIVE');
  if (alert.userId) q = q.where('cu.user_id', '=', alert.userId);
  const subs = await q.execute();
  if (subs.length === 0) return [];
  const rows = subs.map((s) => ({
    id: pushDeliveryId(alert.dedupeKey, s.id), push_subscription_id: s.id, dedupe_key: alert.dedupeKey.slice(0, 200),
    title: alert.title.slice(0, 120), body: alert.body.slice(0, 400), url: alert.url?.slice(0, 500) ?? null,
  }));
  await db.insertInto('push_delivery').values(rows).onConflict((oc) => oc.doNothing()).execute();
  const open = await db.selectFrom('push_delivery').select('id').where('id', 'in', rows.map((r) => r.id)).where('status', '=', 'PENDING').execute();
  return open.map((r) => r.id);
}

/** Sends deliveries, each under its row's lock; throws while any is still pending so the caller's retry tries again. */
export async function sendPushDeliveries(db: Db, adapter: WebPushAdapter, ids: readonly string[]): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  let pending = 0;
  for (const id of ids) {
    const outcome = await db.transaction().execute(async (tx) => {
      const d = await tx.selectFrom('push_delivery as d').innerJoin('push_subscription as s', 's.id', 'd.push_subscription_id')
        .select(['d.id', 'd.status', 'd.attempts', 'd.title', 'd.body', 'd.url', 'd.dedupe_key', 's.id as sub_id', 's.endpoint', 's.p256dh', 's.auth', 's.status as sub_status', 's.failures'])
        .where('d.id', '=', id).forUpdate('d').executeTakeFirst();
      if (!d || d.status !== 'PENDING') return d?.status === 'SENT' ? 'SENT' : 'FAILED';
      if (d.sub_status !== 'ACTIVE') {
        await tx.updateTable('push_delivery').set({ status: 'FAILED', last_error: 'SUBSCRIPTION_REVOKED' }).where('id', '=', d.id).execute();
        return 'FAILED';
      }
      try {
        await adapter.send({ endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth }, { title: d.title, body: d.body, url: d.url, tag: d.dedupe_key.slice(0, 60) });
        await tx.updateTable('push_delivery').set({ status: 'SENT', attempts: d.attempts + 1, sent_at: sql<Date>`inrp2p_now()`, last_error: null }).where('id', '=', d.id).execute();
        await tx.updateTable('push_subscription').set({ failures: 0, last_sent_at: sql<Date>`inrp2p_now()` }).where('id', '=', d.sub_id).execute();
        return 'SENT';
      } catch (e) {
        const failure = e instanceof NotificationDeliveryError ? e : new NotificationDeliveryError('PUSH_FAILED', true);
        const attempts = d.attempts + 1;
        const final = !failure.retryable || attempts >= MAX_PUSH_ATTEMPTS;
        await tx.updateTable('push_delivery').set({ attempts, last_error: failure.code.slice(0, 80), ...(final ? { status: 'FAILED' as const } : {}) }).where('id', '=', d.id).execute();
        // The browser unsubscribed, or its subscription expired: nothing reaches it again until it subscribes anew.
        if (failure.code === 'PUSH_GONE' || failure.code === 'PUSH_BAD_KEY' || failure.code === 'PUSH_BAD_AUTH' || d.failures + 1 >= 20) {
          await tx.updateTable('push_subscription').set({ status: 'REVOKED', revoked_at: sql<Date>`inrp2p_now()`, revoke_reason: `the push service said ${failure.code}` }).where('id', '=', d.sub_id).where('status', '=', 'ACTIVE').execute();
        } else {
          await tx.updateTable('push_subscription').set({ failures: d.failures + 1 }).where('id', '=', d.sub_id).execute();
        }
        return final ? 'FAILED' : 'PENDING';
      }
    });
    if (outcome === 'SENT') sent += 1;
    else if (outcome === 'FAILED') failed += 1;
    else pending += 1;
  }
  if (pending > 0) throw new Error(`${pending} push deliveries still pending`);
  return { sent, failed };
}

/** The pushed copy of the inbox notes Telegram copies, with their one link. */
export function pushInboxHandler(db: Db, adapter: WebPushAdapter): OutboxHandler {
  return {
    name: 'push_inbox_alerts',
    handles: (type) => TELEGRAM_INBOX_EVENTS.has(type),
    run: async (event) => {
      const notes = await db.selectFrom('client_notification').select(['id', 'client_id', 'user_id', 'title', 'body', 'href'])
        .where('outbox_event_id', '=', event.id).where('kind', 'in', TELEGRAMMED).execute();
      for (const n of notes) {
        const ids = await queuePush(db, { clientId: n.client_id, userId: n.user_id, dedupeKey: `inbox:${n.id}`, title: n.title, body: n.body, url: n.href });
        if (ids.length > 0) await sendPushDeliveries(db, adapter, ids);
      }
    },
  };
}
