import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import type { Db, NotificationKind } from '@inrp2p/db';
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
  'client.destination_rejected',
  'client.destination_paused',
  'client.trade_destination_changed',
  'client.payment_third_party',
  'client.team_changed',
  'p2p.dispute_opened',
  'p2p.dispute_decided',
  'p2p.unwind_started',
  'p2p.message_posted',
  'p2p.pay_final_call',
  'p2p.receipt_late',
  // Migration 0049: the hand-offs of a deal — the client's time to pay has started; its trader says it paid.
  'p2p.pay_window_opened',
  'client.p2p_payment_sent',
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
  // ADR 0030: a UPI ID added is live at once — with its full limits only when the desk looked it up.
  if (p.destination === 'UPI_ID' && typeof p.confirmed === 'boolean') out.upiConfirmed = p.confirmed;
  // Team changes carry only enumerated values; anything else is ignored.
  if (p.change === 'JOINED' || p.change === 'ROLE_CHANGED' || p.change === 'REMOVED') out.teamChange = p.change;
  if (p.role === 'ADMIN' || p.role === 'OPERATOR') out.teamRole = p.role;
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
    case 'client.destination_rejected':
      return 'DESTINATION_REJECTED';
    case 'client.destination_paused':
      return 'DESTINATION_PAUSED';
    case 'client.trade_destination_changed':
      return 'TRADE_DESTINATION_CHANGED';
    case 'client.payment_third_party':
      return 'PAYMENT_RETURNED';
    case 'client.team_changed':
      return 'TEAM_CHANGED';
    default:
      return null;
  }
}

/**
 * The client's side of a P2P dispute or unwind (block 9): told when the seller says its payment did not arrive (it
 * paid), when INRP2P decides, and when the buyer let the time run out on its SELL. Not told what it did itself — opening
 * a dispute, or confirming the rupees after all.
 */
function p2pKindFor(event: OutboxEvent, direction: NotificationFacts['direction']): { kind: NotificationKind; facts: NonNullable<NotificationFacts['p2p']> } | null {
  const p = (event.payload ?? {}) as Payload;
  const payee = direction === 'SELL_USDT';
  switch (event.type) {
    case 'p2p.dispute_opened':
      return p.payee === 'TRADER' ? { kind: 'P2P_DISPUTE_OPENED', facts: { audience: 'CLIENT', payee: false } } : null;
    case 'p2p.dispute_decided':
      if (p.via !== 'INRP2P' || (p.decision !== 'PAID' && p.decision !== 'NOT_PAID')) return null;
      return { kind: 'P2P_DISPUTE_DECIDED', facts: { audience: 'CLIENT', payee, decision: p.decision } };
    case 'p2p.unwind_started':
      return p.reason === 'PAY_WINDOW_MISSED' ? { kind: 'P2P_REFUND', facts: { audience: 'CLIENT', payee: true } } : null;
    // ADR 0023: the deal's chat and its clock. The client is told of what the other side or INRP2P wrote, never its own.
    case 'p2p.message_posted':
      if (p.from === 'CLIENT') return null;
      return { kind: 'DEAL_MESSAGE', facts: { audience: 'CLIENT', payee, from: p.from === 'INRP2P' ? 'INRP2P' : payee ? 'BUYER' : 'SELLER' } };
    case 'p2p.pay_final_call':
      return { kind: 'P2P_PAY_FINAL', facts: { audience: 'CLIENT', payee, ...(typeof p.finalUntil === 'string' ? { until: new Date(p.finalUntil) } : {}) } };
    case 'p2p.receipt_late':
      return { kind: 'P2P_RECEIPT_LATE', facts: { audience: 'CLIENT', payee, ...(typeof p.rail === 'string' ? { rail: p.rail } : {}) } };
    // The seller's USDT is locked and the client is the one who pays: its time runs from now. A client selling is paid by
    // its trader, who is told on its own order.
    case 'p2p.pay_window_opened':
      return p.payer === 'CLIENT' && !payee ? { kind: 'P2P_PAY_NOW', facts: { audience: 'CLIENT', payee: false, ...(typeof p.dueAt === 'string' ? { until: new Date(p.dueAt) } : {}) } } : null;
    default:
      return null;
  }
}

/** How a payment of the trade was said to be sent, by the reference its payer filed it under. */
async function railOfPayment(db: Db, legRef: string | undefined): Promise<string | null> {
  if (!legRef) return null;
  const r = await db
    .selectFrom('settlement_leg as l')
    .innerJoin('transfer_allocation as a', 'a.settlement_leg_id', 'l.id')
    .innerJoin('fiat_transfer as f', 'f.id', 'a.fiat_transfer_id')
    .select('f.rail')
    .where('l.ref', '=', legRef)
    .where('a.voided_at', 'is', null)
    .executeTakeFirst();
  return r?.rail ?? null;
}

/**
 * A conversation is told once, not message by message: while the side still has an unread note of the deal's chat from
 * the last few minutes, another message adds nothing to it.
 */
export async function chatAlreadyTold(db: Db, clientId: string, subjectRef: string | null): Promise<boolean> {
  if (!subjectRef) return false;
  const r = await sql<{ told: boolean }>`
    select exists (select 1 from client_notification
                    where client_id = ${clientId}::uuid and kind = 'DEAL_MESSAGE' and subject_ref = ${subjectRef} and read_at is null
                      and created_at > inrp2p_now() - interval '15 minutes') as told`.execute(db);
  return r.rows[0]!.told;
}

/**
 * A desk's price (ADR 0020) is asked for and decided on its own page, in the minute it is held: telling the client it is
 * ready — or that it lapsed — would only be noise. Its trade is told like any other.
 */
async function isDeskQuoteEvent(db: Db, event: OutboxEvent): Promise<boolean> {
  if (event.type !== 'quote.sent' && event.type !== 'client.quote_expired') return false;
  const quoteId = str(((event.payload ?? {}) as Payload).quoteId);
  if (!quoteId) return false;
  const row = await db.selectFrom('quote as q').innerJoin('trade_request as r', 'r.id', 'q.trade_request_id').select('r.desk_id').where('q.id', '=', quoteId).executeTakeFirst();
  return row !== undefined && row.desk_id !== null;
}

export function clientNotificationHandler(db: Db): OutboxHandler {
  return {
    name: 'client_notification_inbox',
    handles: (type) => HANDLED.has(type),
    run: async (event) => {
      if (await isDeskQuoteEvent(db, event)) return;
      const resolved = await facts(db, event);
      if (!resolved) return;
      if (event.type.startsWith('p2p.')) {
        const p2p = p2pKindFor(event, resolved.facts.direction);
        if (!p2p) return;
        const draft = draftFor(p2p.kind, { ...resolved.facts, p2p: p2p.facts });
        if (p2p.kind === 'DEAL_MESSAGE' && (await chatAlreadyTold(db, resolved.clientId, draft.subjectRef))) return;
        await recordNotification(db, { ...draft, clientId: resolved.clientId, outboxEventId: event.id });
        return;
      }
      if (event.type === 'client.p2p_payment_sent') {
        // A client selling USDT: its trader says the rupees are sent. The client looks in its own bank, then confirms.
        const rail = await railOfPayment(db, str(((event.payload ?? {}) as Payload).legRef));
        const draft = draftFor('P2P_PAYMENT_SENT', { ...resolved.facts, p2p: { audience: 'CLIENT', payee: true, ...(rail ? { rail } : {}) } });
        await recordNotification(db, { ...draft, clientId: resolved.clientId, outboxEventId: event.id });
        return;
      }
      const kind = kindFor(event, resolved.facts);
      if (!kind) return;
      const draft = draftFor(kind, resolved.facts);
      await recordNotification(db, { ...draft, clientId: resolved.clientId, outboxEventId: event.id });
    },
  };
}
