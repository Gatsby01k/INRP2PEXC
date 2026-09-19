import { Money } from '@inrp2p/kernel';
import type { Db } from '@inrp2p/db';
import type { OutboxEvent, OutboxHandler } from '@inrp2p/outbox';
import { recordNotification } from './inbox.ts';
import { type NotificationFacts, draftFor } from './messages.ts';

/**
 * Turns the events the domain already emits into the client's in-app inbox.
 *
 * It emits nothing of its own and decides nothing: every notification exists because a command wrote a state
 * change and enqueued an event in the same transaction. The handler's only judgement is which of those events a
 * client should hear about, and how to say it.
 */
const HANDLED = new Set([
  'quote.sent',
  'client.quote_expired',
  'client.request_declined',
  'trade.opened',
  'client.payout_confirmed',
  'client.trade_cancelled',
  'client.destination_added',
  'client.destination_archived',
]);

type Payload = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** Resolves the references and figures a message needs — from the rows, never from the event's own wording. */
async function facts(db: Db, event: OutboxEvent): Promise<{ clientId: string; facts: NotificationFacts } | null> {
  const p = (event.payload ?? {}) as Payload;
  const clientId = str(p.clientId);
  if (!clientId) return null;

  const quoteId = str(p.quoteId);
  const tradeId = str(p.tradeId);
  const requestId = str(p.requestId);
  const out: { -readonly [K in keyof NotificationFacts]: NotificationFacts[K] } = {};

  if (quoteId) {
    const q = await db
      .selectFrom('quote as q')
      .innerJoin('trade_request as r', 'r.id', 'q.trade_request_id')
      .select(['q.ref', 'q.quote_inr_minor', 'q.base_minor', 'q.direction'])
      .where('q.id', '=', quoteId)
      .executeTakeFirst();
    if (q) {
      out.quoteRef = q.ref;
      out.inr = Money.ofMinor(q.quote_inr_minor, 'INR').toDecimalString();
      out.base = Money.ofMinor(q.base_minor, 'USDT').toDecimalString();
      out.direction = q.direction;
    }
  }
  if (tradeId) {
    const t = await db
      .selectFrom('trade as t')
      .innerJoin('trade_economics as e', 'e.trade_id', 't.id')
      .select(['t.ref', 't.direction', 'e.base_minor', 'e.quote_inr_minor'])
      .where('t.id', '=', tradeId)
      .executeTakeFirst();
    if (t) {
      out.tradeRef = t.ref;
      out.direction = t.direction;
      out.base = Money.ofMinor(t.base_minor, 'USDT').toDecimalString();
      out.inr = Money.ofMinor(t.quote_inr_minor, 'INR').toDecimalString();
    }
  }
  if (requestId) {
    // The reason an operator typed lives on the request, not in the event: the payload is a pointer, and the
    // row is the record.
    const r = await db.selectFrom('trade_request').select('status_reason').where('id', '=', requestId).executeTakeFirst();
    if (r?.status_reason) out.reason = r.status_reason;
  }
  const reason = str(p.reason);
  const label = str(p.label);
  const paid = str(p.paid);
  const of = str(p.of);
  if (reason) out.reason = reason;
  if (label) out.label = label;
  if (paid) out.paid = paid;
  if (of) out.of = of;
  return { clientId, facts: out };
}

/** A confirmed payout that settles the trade in full is told as completion, which is what the client cares about. */
function kindFor(event: OutboxEvent, f: NotificationFacts): Parameters<typeof draftFor>[0] | null {
  switch (event.type) {
    case 'quote.sent':
      return 'QUOTE_SENT';
    case 'client.quote_expired':
      return 'QUOTE_EXPIRED';
    case 'client.request_declined':
      return 'REQUEST_DECLINED';
    case 'trade.opened':
      return 'TRADE_OPENED';
    case 'client.payout_confirmed':
      return f.paid !== undefined && f.of !== undefined && f.paid === f.of ? 'TRADE_COMPLETED' : 'PAYOUT_CONFIRMED';
    case 'client.trade_cancelled':
      return 'TRADE_CANCELLED';
    case 'client.destination_added':
      return 'DESTINATION_ADDED';
    case 'client.destination_archived':
      return 'DESTINATION_ARCHIVED';
    default:
      return null;
  }
}

export function clientNotificationHandler(db: Db): OutboxHandler {
  return {
    name: 'client_notification_inbox',
    handles: (type) => HANDLED.has(type),
    run: async (event) => {
      const resolved = await facts(db, event);
      if (!resolved) return;
      const kind = kindFor(event, resolved.facts);
      if (!kind) return;
      const draft = draftFor(kind, resolved.facts);
      await recordNotification(db, { ...draft, clientId: resolved.clientId, outboxEventId: event.id });
    },
  };
}
