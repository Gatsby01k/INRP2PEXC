import { sql } from 'kysely';
import { Money, Rate, requireP2pTiming } from '@inrp2p/kernel';
import type { Db, NotificationKind } from '@inrp2p/db';
import type { OutboxEvent, OutboxHandler } from '@inrp2p/outbox';
import { chatAlreadyTold } from './handler.ts';
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
    case 'RESERVE_HELD':
      return `The INR for order ${str(p.orderRef) ?? 'of yours'} did not arrive, so the desk is holding ${str(p.amount) ?? 'part'} USDT of your Security Reserve against it. Nothing is taken or converted: the amount cannot be withdrawn until the hold is released.`;
    case 'RESERVE_APPLIED':
      return `The USDT for order ${str(p.orderRef) ?? 'of yours'} did not arrive, so the desk is applying ${str(p.amount) ?? 'part'} USDT of your Security Reserve to it as your delivery. If your reserve falls below the requirement, new orders pause until you top it up.`;
    default:
      return 'Open Traders to see what is needed.';
  }
}

async function orderFacts(db: Db, orderId: string): Promise<{ clientId: string; deskDeal: boolean; personal: boolean; started: boolean; facts: NotificationFacts } | null> {
  const o = await db
    .selectFrom('trader_order as o')
    .innerJoin('trader_profile as t', 't.id', 'o.trader_id')
    .innerJoin('trade_request as r', 'r.id', 'o.trade_request_id')
    .innerJoin('liquidity_route as lr', 'lr.id', 'o.route_id')
    .select(['o.ref', 'o.side', 'o.base_minor', 'o.inr_minor', 'o.rate_micro', 'o.close_reason', 'o.trade_id', 't.client_id', 't.status as trader_status', 'r.desk_id', 'lr.execution_mode'])
    .where('o.id', '=', orderId)
    .executeTakeFirst();
  if (!o) return null;
  // On a P2P deal (ADR 0019) the seller of the USDT moves first, within the programme's escrow time.
  const escrowMinutes = o.execution_mode === 'P2P' ? requireP2pTiming((await db.selectFrom('trader_program').select('p2p_timing').where('id', '=', 1).executeTakeFirstOrThrow()).p2p_timing).escrowMinutes : null;
  return {
    clientId: o.client_id,
    deskDeal: o.desk_id !== null,
    // ADR 0033: a client's personal side of a meeting — its deal opens on the client's own deal page.
    personal: o.trader_status === 'PERSONAL',
    started: o.trade_id !== null,
    facts: {
      ...(o.trader_status === 'PERSONAL' ? { personal: true } : {}),
      orderRef: o.ref,
      side: o.side,
      base: Money.ofMinor(o.base_minor, 'USDT').toDecimalString(),
      inr: Money.ofMinor(o.inr_minor, 'INR').toDecimalString(),
      rate: Rate.ofMicro(o.rate_micro, 'ROUTE').toDecimalString(),
      ...(o.close_reason ? { reason: o.close_reason } : {}),
      ...(escrowMinutes !== null ? { escrow: { minutes: escrowMinutes } } : {}),
    },
  };
}

/**
 * A client buying USDT says it paid (`fiat_in.claim`): its trader — the seller — is told at once, in its inbox and by
 * email, to look in its own bank and confirm. Until migration 0049 only a linked Telegram chat heard of it.
 */
async function buyerPaid(db: Db, event: OutboxEvent): Promise<{ clientId: string; kind: NotificationKind; facts: NotificationFacts } | null> {
  const p = (event.payload ?? {}) as Payload;
  const tradeId = str(p.tradeId);
  if (!tradeId) return null;
  const o = await db.selectFrom('trader_order').select(['id', 'side']).where('trade_id', '=', tradeId).where('status', '=', 'IN_PROGRESS').executeTakeFirst();
  if (!o || o.side !== 'SELL_USDT') return null;
  const resolved = await orderFacts(db, o.id);
  if (!resolved || !resolved.facts.escrow) return null;
  const legId = str(p.legId);
  const filed = legId
    ? await db.selectFrom('transfer_allocation as a').innerJoin('fiat_transfer as f', 'f.id', 'a.fiat_transfer_id').select('f.rail').where('a.settlement_leg_id', '=', legId).where('a.voided_at', 'is', null).executeTakeFirst()
    : undefined;
  return {
    clientId: resolved.clientId,
    kind: 'P2P_PAYMENT_SENT',
    facts: { ...resolved.facts, p2p: { audience: 'TRADER', payee: true, deskDeal: resolved.deskDeal, ...(filed?.rail ? { rail: filed.rail } : {}) } },
  };
}

/** A side that can no longer take its smallest order (migration 0049): which, and what is left of it. */
async function sideEmpty(db: Db, event: OutboxEvent): Promise<{ clientId: string; kind: NotificationKind; facts: NotificationFacts } | null> {
  const p = (event.payload ?? {}) as Payload;
  const blockId = str(p.blockId);
  if (!blockId) return null;
  const b = await db
    .selectFrom('trader_block as b')
    .innerJoin('trader_profile as t', 't.id', 'b.trader_id')
    .select(['b.side', 'b.capacity_minor', 'b.reserved_minor', 't.client_id'])
    .where('b.id', '=', blockId)
    .executeTakeFirst();
  if (!b) return null;
  const currency = b.side === 'BUY_USDT' ? 'INR' : 'USDT';
  const left = b.capacity_minor - b.reserved_minor;
  return { clientId: b.client_id, kind: 'TRADER_SIDE_EMPTY', facts: { side: b.side, sideEmpty: { currency, left: Money.ofMinor(left > 0n ? left : 0n, currency).toDecimalString() } } };
}

/**
 * A trader's side of a P2P dispute or unwind (block 9): told when the client says the trader's rupees did not arrive,
 * when INRP2P decides, and when the trader let the time to pay run out.
 */
async function p2pResolve(db: Db, event: OutboxEvent): Promise<{ clientId: string; kind: NotificationKind; facts: NotificationFacts } | null> {
  const p = (event.payload ?? {}) as Payload;
  const tradeId = str(p.tradeId);
  if (!tradeId) return null;
  const o = await db
    .selectFrom('trader_order as o')
    .innerJoin('trade_request as r', 'r.id', 'o.trade_request_id')
    .select(['o.id', 'o.side', 'r.desk_id'])
    .where('o.trade_id', '=', tradeId)
    .orderBy('o.offered_at', 'desc')
    .executeTakeFirst();
  if (!o) return null;
  // The trader sells USDT on a client's BUY: then it receives the rupees.
  const payee = o.side === 'SELL_USDT';
  let kind: NotificationKind;
  let decision: 'PAID' | 'NOT_PAID' | undefined;
  if (event.type === 'trader.p2p_dispute_opened') {
    if (p.payee !== 'CLIENT') return null;
    kind = 'P2P_DISPUTE_OPENED';
  } else if (event.type === 'trader.p2p_dispute_decided') {
    if (p.via !== 'INRP2P' || (p.decision !== 'PAID' && p.decision !== 'NOT_PAID')) return null;
    kind = 'P2P_DISPUTE_DECIDED';
    decision = p.decision;
  } else if (event.type === 'trader.p2p_unwind_started') {
    if (p.reason !== 'PAY_WINDOW_MISSED') return null;
    kind = 'P2P_REFUND';
  } else if (event.type === 'trader.p2p_message_posted') {
    // ADR 0023: what the client or INRP2P wrote in the deal's chat — never the trader's own.
    if (p.from === 'TRADER') return null;
    kind = 'DEAL_MESSAGE';
  } else if (event.type === 'trader.p2p_pay_final_call') {
    kind = 'P2P_PAY_FINAL';
  } else if (event.type === 'trader.p2p_receipt_late') {
    kind = 'P2P_RECEIPT_LATE';
  } else return null;
  const resolved = await orderFacts(db, o.id);
  if (!resolved) return null;
  const extra = {
    ...(kind === 'DEAL_MESSAGE' ? { from: p.from === 'INRP2P' ? ('INRP2P' as const) : payee ? ('BUYER' as const) : ('SELLER' as const) } : {}),
    ...(kind === 'P2P_PAY_FINAL' && typeof p.finalUntil === 'string' ? { until: new Date(p.finalUntil) } : {}),
    ...(kind === 'P2P_RECEIPT_LATE' && typeof p.rail === 'string' ? { rail: p.rail } : {}),
  };
  return { clientId: resolved.clientId, kind, facts: { ...resolved.facts, p2p: { audience: 'TRADER', payee, ...(decision ? { decision } : {}), deskDeal: o.desk_id !== null, ...extra } } };
}

const DESK_ACTIONS = new Set(['SUSPENDED', 'RESUMED', 'PAGE_HIDDEN', 'PAGE_SHOWN', 'RENAMED']);

const SETTLEMENT_CHANGE: Readonly<Record<string, 'PROPOSED' | 'CANCELLED' | 'APPLIED'>> = {
  'trader.settlement_change_proposed': 'PROPOSED',
  'trader.settlement_change_cancelled': 'CANCELLED',
  'trader.settlement_change_applied': 'APPLIED',
};

async function resolve(db: Db, event: OutboxEvent): Promise<{ clientId: string; kind: NotificationKind; facts: NotificationFacts } | null> {
  const p = (event.payload ?? {}) as Payload;
  if (event.type.startsWith('trader.p2p_')) return p2pResolve(db, event);
  if (event.type === 'desk.client_payment_claimed') return buyerPaid(db, event);
  if (event.type === 'trader.side_empty') return sideEmpty(db, event);
  if (event.type === 'trader.desk_moderated') {
    // INRP2P's decision about the trader's desk (block 11): the action from its enumerated values, the reason as written.
    const traderId = str(p.traderId);
    const action = str(p.action);
    if (!traderId || !action || !DESK_ACTIONS.has(action)) return null;
    const t = await db.selectFrom('trader_profile').select('client_id').where('id', '=', traderId).executeTakeFirst();
    if (!t) return null;
    const reason = str(p.reason);
    return { clientId: t.client_id, kind: 'DESK_NOTICE', facts: { deskAction: action as NonNullable<NotificationFacts['deskAction']>, ...(reason ? { reason } : {}) } };
  }
  if (event.type === 'trader.clients_waiting') return clientsWaiting(db, event);
  if (event.type === 'trader.rfq_opened') {
    // ADR 0025: a price request put to this trader — its side, the amount and its time; never who asks.
    const rfqId = str(p.rfqId);
    const traderId = str(p.traderId);
    if (!rfqId || !traderId) return null;
    const row = await db
      .selectFrom('rfq as q')
      .innerJoin('trade_request as r', 'r.id', 'q.trade_request_id')
      .innerJoin('rfq_invite as i', (j) => j.onRef('i.rfq_id', '=', 'q.id').on('i.trader_id', '=', traderId))
      .innerJoin('trader_profile as t', 't.id', 'i.trader_id')
      .select(['q.ref', 'q.direction', 'q.closes_at', 'r.fixed_side', 'r.requested_base_minor', 'r.requested_quote_minor', 't.client_id'])
      .where('q.id', '=', rfqId)
      .executeTakeFirst();
    if (!row) return null;
    const usdtFixed = row.fixed_side === 'BASE';
    return {
      clientId: row.client_id,
      kind: 'TRADER_PRICE_REQUEST',
      facts: {
        side: row.direction === 'SELL_USDT' ? 'BUY_USDT' : 'SELL_USDT',
        priceAsk: {
          ref: row.ref,
          amount: usdtFixed ? Money.ofMinor(row.requested_base_minor!, 'USDT').toDecimalString() : Money.ofMinor(row.requested_quote_minor!, 'INR').toDecimalString(),
          currency: usdtFixed ? 'USDT' : 'INR',
          closesAt: row.closes_at,
        },
      },
    };
  }
  const change = SETTLEMENT_CHANGE[event.type];
  if (change) {
    // ADR 0024: every member of the account hears of a change of where it is paid — the inbox addresses the whole client.
    const traderId = str(p.traderId);
    if (!traderId) return null;
    const t = await db.selectFrom('trader_profile').select('client_id').where('id', '=', traderId).executeTakeFirst();
    if (!t) return null;
    const what = p.what === 'BANK' || p.what === 'WALLET' || p.what === 'BOTH' ? p.what : 'BOTH';
    const at = str(p.effectiveAt);
    return { clientId: t.client_id, kind: 'TRADER_SETTLEMENT_CHANGE', facts: { settlementChange: { action: change, what, ...(at ? { effectiveAt: new Date(at) } : {}) } } };
  }
  if (event.type === 'desk.payout_actionable') {
    // The other side's funds are confirmed: if a trader's order stands behind this trade, it is now the trader's turn.
    const tradeId = str(p.tradeId);
    if (!tradeId) return null;
    const o = await db.selectFrom('trader_order').select('id').where('trade_id', '=', tradeId).where('status', '=', 'IN_PROGRESS').executeTakeFirst();
    if (!o) return null;
    const resolved = await orderFacts(db, o.id);
    return resolved ? { clientId: resolved.clientId, facts: resolved.facts, kind: 'TRADER_ACTION_REQUIRED' } : null;
  }
  const orderKind = ORDER_EVENTS[event.type];
  if (orderKind) {
    if (event.type === 'trader.order_withdrawn' && !TOLD_WHEN_WITHDRAWN.has(str(p.reason) ?? '')) return null;
    const orderId = str(p.orderId);
    if (!orderId) return null;
    const resolved = await orderFacts(db, orderId);
    // ADR 0033: a meeting's maker hears of its meeting from the meeting itself (offered, started, ended): of its order
    // only once the deal is under way.
    if (resolved?.personal && (orderKind === 'TRADER_ORDER_NEW' || orderKind === 'TRADER_ORDER_ACCEPTED' || !resolved.started)) return null;
    return resolved ? { clientId: resolved.clientId, facts: resolved.facts, kind: orderKind } : null;
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
/** ADR 0032: a trader hears that clients are waiting at most this often — the first such client in that time, and how many wait. */
export const CLIENTS_WAITING_NOTICE_MINUTES = 30;

/**
 * ADR 0032: a client is waiting for a trader and this trader could take it. Told with the side in the trader's own words,
 * the amount as it was asked, and how many clients wait on that side now — never who asks. Not told when the request no
 * longer waits by the time this runs, nor when the trader already heard of waiting clients in the last
 * `CLIENTS_WAITING_NOTICE_MINUTES`: one nudge brings it back; a stream of them would only be noise.
 */
async function clientsWaiting(db: Db, event: OutboxEvent): Promise<{ clientId: string; kind: NotificationKind; facts: NotificationFacts } | null> {
  const p = (event.payload ?? {}) as Payload;
  const requestId = str(p.requestId);
  const traderId = str(p.traderId);
  if (!requestId || !traderId) return null;
  const [request, trader] = await Promise.all([
    db.selectFrom('trade_request').select(['direction', 'fixed_side', 'requested_base_minor', 'requested_quote_minor', 'waiting_until']).where('id', '=', requestId).executeTakeFirst(),
    db.selectFrom('trader_profile').select(['client_id', 'status']).where('id', '=', traderId).executeTakeFirst(),
  ]);
  if (!request || !trader || request.waiting_until === null || trader.status !== 'APPROVED') return null;
  const told = await sql<{ told: boolean }>`
    select exists (select 1 from client_notification where client_id = ${trader.client_id}::uuid and kind = 'TRADER_CLIENTS_WAITING'
                     and created_at > inrp2p_now() - make_interval(mins => ${CLIENTS_WAITING_NOTICE_MINUTES})) as told`.execute(db);
  if (told.rows[0]!.told) return null;
  const waiting = await db.selectFrom('trade_request').select((eb) => eb.fn.countAll<string>().as('n'))
    .where('status', '=', 'OPEN').where('waiting_until', 'is not', null).where('direction', '=', request.direction).executeTakeFirst();
  const usdt = request.fixed_side === 'BASE';
  return {
    clientId: trader.client_id,
    kind: 'TRADER_CLIENTS_WAITING',
    facts: {
      side: request.direction === 'SELL_USDT' ? 'BUY_USDT' : 'SELL_USDT',
      waiting: {
        amount: usdt ? Money.ofMinor(request.requested_base_minor!, 'USDT').toDecimalString() : Money.ofMinor(request.requested_quote_minor!, 'INR').toDecimalString(),
        currency: usdt ? 'USDT' : 'INR',
        clients: Number.parseInt(waiting?.n ?? '1', 10),
      },
    },
  };
}

export function traderNotificationHandler(db: Db): OutboxHandler {
  return {
    name: 'trader_notification_inbox',
    handles: (type) => type.startsWith('trader.') || type === 'desk.payout_actionable' || type === 'desk.client_payment_claimed',
    run: async (event) => {
      const resolved = await resolve(db, event);
      if (!resolved) return;
      const draft = draftFor(resolved.kind, resolved.facts);
      if (resolved.kind === 'DEAL_MESSAGE' && (await chatAlreadyTold(db, resolved.clientId, draft.subjectRef))) return;
      await recordNotification(db, { ...draft, clientId: resolved.clientId, outboxEventId: event.id });
    },
  };
}
