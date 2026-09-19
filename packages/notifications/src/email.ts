import { sql } from 'kysely';
import type { Db } from '@inrp2p/db';
import type { NotificationAdapter } from '@inrp2p/adapters';
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
const EMAILED = new Set(['QUOTE_SENT', 'REQUEST_DECLINED', 'TRADE_COMPLETED', 'TRADE_CANCELLED', 'DESTINATION_ADDED', 'DESTINATION_ARCHIVED']);

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
 * Sends one notification row by email, once. Returns the number of recipients it reached, or `null` when the row
 * was not eligible (already sent, or a kind that is inbox-only).
 *
 * At-least-once delivery applies here as everywhere at the outbox boundary, so `email_sent_at` is claimed with a
 * conditional update before anything is sent: a redelivered event finds the claim taken and sends nothing. A
 * provider failure after the claim is a lost email, never a duplicated one — the inbox row is still there, and
 * that is the copy that matters.
 */
export async function emailNotification(db: Db, adapter: NotificationAdapter, input: { outboxEventId: string } & EmailChannelOptions): Promise<number | null> {
  const row = await db
    .selectFrom('client_notification')
    .select(['id', 'client_id', 'user_id', 'kind', 'title', 'body', 'href', 'email_sent_at'])
    .where('outbox_event_id', '=', input.outboxEventId)
    .executeTakeFirst();
  if (!row || row.email_sent_at || !EMAILED.has(row.kind)) return null;

  let recipients = db
    .selectFrom('client_user as cu')
    .innerJoin('auth_user as u', 'u.id', 'cu.user_id')
    .select(['u.email'])
    .where('cu.client_id', '=', row.client_id)
    .where('cu.status', '=', 'ACTIVE')
    .where('u.status', '=', 'ACTIVE')
    .where('u.kind', '=', 'CLIENT')
    // An unverified address is not this client's address yet; a notification is not the way to find that out.
    .where('u.email_verified', '=', true);
  if (row.user_id) recipients = recipients.where('cu.user_id', '=', row.user_id);
  const to = (await recipients.execute()).map((r) => r.email);
  if (to.length === 0) return null;

  const claimed = await db
    .updateTable('client_notification')
    .set({ email_sent_at: sql<Date>`inrp2p_now()` })
    .where('id', '=', row.id)
    .where('email_sent_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  if (!claimed) return null;

  const link = absolute(input.linkBase, row.href);
  for (const address of to) {
    await adapter.sendClientNotification({ to: address, subject: row.title, body: row.body, link });
  }
  return to.length;
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
    handles: (type) => type.startsWith('client.') || type === 'quote.sent' || type === 'trade.opened',
    run: async (event) => {
      await emailNotification(db, adapter, { outboxEventId: event.id, ...opts });
    },
  };
}
