import { Money, Rate } from '@inrp2p/kernel';
import type { Db, NotificationKind } from '@inrp2p/db';
import type { OutboxEvent, OutboxHandler } from '@inrp2p/outbox';
import { recordNotification } from './inbox.ts';
import { type NotificationFacts, draftFor } from './messages.ts';

/**
 * Turns the trader programme's events into the trader's inbox. A trader is a client, so its messages land in that
 * client's inbox like any other, pointing into its Traders screens. As everywhere, the handler composes from the
 * rows, never from the event's wording, and says nothing about the client on the other side of an order.
 */
type Payload = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

const ORDER_EVENTS: Readonly<Record<string, NotificationKind>> = {
  'trader.order_offered': 'TRADER_ORDER_NEW',
  'trader.order_started': 'TRADER_ORDER_ACCEPTED',
  'trader.payment_confirmed': 'TRADER_PAYMENT_CONFIRMED',
  'trader.order_completed': 'TRADER_ORDER_COMPLETED',
  'trader.order_expired': 'TRADER_ORDER_CLOSED',
  'trader.order_released': 'TRADER_ORDER_CLOSED',
  'trader.order_withdrawn': 'TRADER_ORDER_CLOSED',
  'trader.order_cancelled': 'TRADER_ORDER_CLOSED',
};

const PROFILE_EVENTS: Readonly<Record<string, NotificationKind>> = {
  'trader.approved': 'TRADER_APPROVED',
  'trader.rejected': 'TRADER_REJECTED',
  'trader.paused': 'TRADER_PAUSED',
  'trader.resumed': 'TRADER_RESUMED',
  'trader.reserve_issue': 'TRADER_RESERVE_ISSUE',
};

/** Withdrawn offers the trader caused itself (switching off, changing its rate) need no message; the rest do. */
const TOLD_WHEN_WITHDRAWN = new Set(['REQUEST_CLOSED', 'DESK_RELEASED']);

function reserveIssueText(p: Payload): string {
  switch (str(p.reason)) {
    case 'UNREGISTERED_SENDER':
      return 'USDT reached your reserve address from a wallet that is not your registered wallet, so it was not credited. The desk is reviewing it.';
    case 'REQUIREMENT_CHANGED':
      return `The Security Reserve for your account is now ${str(p.amount) ?? 'changed'} USDT. If your reserve is below that, new orders pause until you top it up.`;
    case 'WITHDRAWAL_REJECTED':
      return `Your reserve withdrawal was not sent${str(p.note) ? `: ${str(p.note)}` : ''}. The amount is available again.`;
    default:
      return 'Open Traders to see what is needed.';
  }
}

async function orderFacts(db: Db, orderId: string): Promise<{ clientId: string; facts: NotificationFacts } | null> {
  const o = await db
    .selectFrom('trader_order as o')
    .innerJoin('trader_profile as t', 't.id', 'o.trader_id')
    .select(['o.ref', 'o.side', 'o.base_minor', 'o.inr_minor', 'o.rate_micro', 'o.reward_inr_minor', 'o.close_reason', 't.client_id'])
    .where('o.id', '=', orderId)
    .executeTakeFirst();
  if (!o) return null;
  return {
    clientId: o.client_id,
    facts: {
      orderRef: o.ref,
      side: o.side,
      base: Money.ofMinor(o.base_minor, 'USDT').toDecimalString(),
      inr: Money.ofMinor(o.inr_minor, 'INR').toDecimalString(),
      rate: Rate.ofMicro(o.rate_micro, 'ROUTE').toDecimalString(),
      ...(o.reward_inr_minor !== null && o.reward_inr_minor > 0n ? { reward: Money.ofMinor(o.reward_inr_minor, 'INR').toDecimalString() } : {}),
      ...(o.close_reason ? { reason: o.close_reason } : {}),
    },
  };
}

async function resolve(db: Db, event: OutboxEvent): Promise<{ clientId: string; kind: NotificationKind; facts: NotificationFacts } | null> {
  const p = (event.payload ?? {}) as Payload;
  if (event.type === 'desk.payout_actionable') {
    // The other side's funds are confirmed: if a trader's order stands behind this trade, it is now the trader's turn.
    const tradeId = str(p.tradeId);
    if (!tradeId) return null;
    const o = await db.selectFrom('trader_order').select('id').where('trade_id', '=', tradeId).where('status', '=', 'IN_PROGRESS').executeTakeFirst();
    if (!o) return null;
    const resolved = await orderFacts(db, o.id);
    return resolved ? { ...resolved, kind: 'TRADER_ACTION_REQUIRED' } : null;
  }
  const orderKind = ORDER_EVENTS[event.type];
  if (orderKind) {
    if (event.type === 'trader.order_withdrawn' && !TOLD_WHEN_WITHDRAWN.has(str(p.reason) ?? '')) return null;
    const orderId = str(p.orderId);
    if (!orderId) return null;
    const resolved = await orderFacts(db, orderId);
    return resolved ? { ...resolved, kind: orderKind } : null;
  }
  const profileKind = PROFILE_EVENTS[event.type];
  if (profileKind) {
    const traderId = str(p.traderId);
    if (!traderId) return null;
    const t = await db.selectFrom('trader_profile').select('client_id').where('id', '=', traderId).executeTakeFirst();
    if (!t) return null;
    const reason = profileKind === 'TRADER_RESERVE_ISSUE' ? reserveIssueText(p) : str(p.reason);
    return { clientId: t.client_id, kind: profileKind, facts: reason ? { reason } : {} };
  }
  return null;
}

/** Outbox handler for the trader inbox. Handles every `trader.*` event (most need no message) and the payout signal. */
export function traderNotificationHandler(db: Db): OutboxHandler {
  return {
    name: 'trader_notification_inbox',
    handles: (type) => type.startsWith('trader.') || type === 'desk.payout_actionable',
    run: async (event) => {
      const resolved = await resolve(db, event);
      if (!resolved) return;
      const draft = draftFor(resolved.kind, resolved.facts);
      await recordNotification(db, { ...draft, clientId: resolved.clientId, outboxEventId: event.id });
    },
  };
}
