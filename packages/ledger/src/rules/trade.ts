import { DomainError, type Money, type TradeEconomics } from '@inrp2p/kernel';
import { Accounts } from '../accounts.ts';
import type { EntryInput, JournalInput } from '../posting.ts';

export interface TradeLedgerRefs {
  readonly tradeId: string;
  readonly clientId: string;
  readonly routeId: string;
  readonly routeObligationId: string;
}

/**
 * `trade:{t}:accept` (FINANCIAL_INVARIANTS §3.3). Client obligation, route obligation and deferred
 * margin are recognized together. A negative margin (permitted quote) debits deferred margin.
 */
export function tradeAcceptJournal(econ: TradeEconomics, refs: TradeLedgerRefs): JournalInput {
  const { tradeId, clientId, routeId, routeObligationId: ro } = refs;
  const margin = econ.grossMargin;
  const marginLine = (sideForPositive: 'CR'): EntryInput[] =>
    margin.isZero()
      ? []
      : [{ account: Accounts.deferredMargin(), direction: margin.isPositive() ? sideForPositive : 'DR', amount: margin.isNegative() ? margin.negate() : margin }];

  let entries: EntryInput[];
  if (econ.routeBase && econ.grossMarginBase) return p2pAcceptJournal(econ as P2pEconomics, refs);
  if (econ.direction === 'SELL_USDT') {
    entries = [
      { account: Accounts.clientReceivable(clientId, 'USDT'), direction: 'DR', amount: econ.base },
      { account: Accounts.routePayable(routeId, 'USDT'), direction: 'CR', amount: econ.base, routeObligationId: ro },
      { account: Accounts.routeReceivable(routeId, 'INR'), direction: 'DR', amount: econ.routeInr, routeObligationId: ro },
      { account: Accounts.clientPayable(clientId, 'INR'), direction: 'CR', amount: econ.clientInr },
      ...marginLine('CR'),
    ];
  } else {
    entries = [
      { account: Accounts.clientReceivable(clientId, 'INR'), direction: 'DR', amount: econ.clientInr },
      { account: Accounts.routePayable(routeId, 'INR'), direction: 'CR', amount: econ.routeInr, routeObligationId: ro },
      ...marginLine('CR'),
      { account: Accounts.routeReceivable(routeId, 'USDT'), direction: 'DR', amount: econ.base, routeObligationId: ro },
      { account: Accounts.clientPayable(clientId, 'USDT'), direction: 'CR', amount: econ.base },
    ];
  }
  return { postingKey: `trade:${tradeId}:accept`, eventType: 'trade.accepted', tradeId, entries };
}

type P2pEconomics = TradeEconomics & { readonly routeBase: Money<'USDT'>; readonly grossMarginBase: Money<'USDT'> };

/**
 * `trade:{t}:accept` of a P2P trade (ADR 0019 §2.5): the rupees are one amount the client owes the route (client buys)
 * or the route owes the client (client sells) — no exchange account will ever hold them — and the margin is the USDT
 * between the client's amount and the trader's.
 */
function p2pAcceptJournal(econ: P2pEconomics, refs: TradeLedgerRefs): JournalInput {
  const { tradeId, clientId, routeId, routeObligationId: ro } = refs;
  const m = econ.grossMarginBase;
  const margin: EntryInput[] = m.isZero() ? [] : [{ account: Accounts.deferredMargin('USDT'), direction: m.isPositive() ? 'CR' : 'DR', amount: m.isNegative() ? m.negate() : m }];
  const entries: EntryInput[] =
    econ.direction === 'BUY_USDT'
      ? [
          { account: Accounts.routeReceivable(routeId, 'USDT'), direction: 'DR', amount: econ.routeBase, routeObligationId: ro },
          { account: Accounts.clientPayable(clientId, 'USDT'), direction: 'CR', amount: econ.base },
          ...margin,
          { account: Accounts.clientReceivable(clientId, 'INR'), direction: 'DR', amount: econ.clientInr },
          { account: Accounts.routePayable(routeId, 'INR'), direction: 'CR', amount: econ.routeInr, routeObligationId: ro },
        ]
      : [
          { account: Accounts.clientReceivable(clientId, 'USDT'), direction: 'DR', amount: econ.base },
          { account: Accounts.routePayable(routeId, 'USDT'), direction: 'CR', amount: econ.routeBase, routeObligationId: ro },
          ...margin,
          { account: Accounts.routeReceivable(routeId, 'INR'), direction: 'DR', amount: econ.routeInr, routeObligationId: ro },
          { account: Accounts.clientPayable(clientId, 'INR'), direction: 'CR', amount: econ.clientInr },
        ];
  return { postingKey: `trade:${tradeId}:accept`, eventType: 'trade.accepted', tradeId, entries };
}

/**
 * `trade:{t}:complete`: moves deferred margin to realized revenue — USDT on a P2P trade. On a desk's deal (ADR 0020) the
 * platform's fee is realized as `REVENUE:PLATFORM_FEE` and only what is left of the margin (none on a deal the desk fills
 * itself) as gross margin. Zero margin posts nothing.
 */
export function tradeCompleteJournal(econ: TradeEconomics, refs: Pick<TradeLedgerRefs, 'tradeId'>): JournalInput | null {
  if (econ.grossMarginBase && econ.platformFeeBase) {
    const fee = econ.platformFeeBase;
    const rest = econ.grossMarginBase.sub(fee);
    if (fee.isNegative() || rest.isNegative()) throw new DomainError('INVALID_ARGUMENT', 'a desk deal\'s fee is part of its margin');
    if (econ.grossMarginBase.isZero()) return null;
    return {
      postingKey: `trade:${refs.tradeId}:complete`,
      eventType: 'trade.completed',
      tradeId: refs.tradeId,
      entries: [
        { account: Accounts.deferredMargin('USDT'), direction: 'DR', amount: econ.grossMarginBase },
        ...(fee.isZero() ? [] : [{ account: Accounts.platformFee(), direction: 'CR' as const, amount: fee }]),
        ...(rest.isZero() ? [] : [{ account: Accounts.grossMargin('USDT'), direction: 'CR' as const, amount: rest }]),
      ],
    };
  }
  if (econ.grossMarginBase) {
    const m = econ.grossMarginBase;
    if (m.isZero()) return null;
    const abs = m.isNegative() ? m.negate() : m;
    return {
      postingKey: `trade:${refs.tradeId}:complete`,
      eventType: 'trade.completed',
      tradeId: refs.tradeId,
      entries: [
        { account: Accounts.deferredMargin('USDT'), direction: m.isPositive() ? 'DR' : 'CR', amount: abs },
        { account: Accounts.grossMargin('USDT'), direction: m.isPositive() ? 'CR' : 'DR', amount: abs },
      ],
    };
  }
  const m = econ.grossMargin;
  if (m.isZero()) return null;
  const abs = m.isNegative() ? m.negate() : m;
  const positive = m.isPositive();
  return {
    postingKey: `trade:${refs.tradeId}:complete`,
    eventType: 'trade.completed',
    tradeId: refs.tradeId,
    entries: [
      { account: Accounts.deferredMargin(), direction: positive ? 'DR' : 'CR', amount: abs },
      { account: Accounts.grossMargin(), direction: positive ? 'CR' : 'DR', amount: abs },
    ],
  };
}

/** Posting keys used for cancellation: always an exact reversal of the accept journal. */
export function tradeCancelReversal(tradeId: string): { originalPostingKey: string; postingKey: string; eventType: string } {
  return { originalPostingKey: `trade:${tradeId}:accept`, postingKey: `trade:${tradeId}:cancel`, eventType: 'trade.cancelled' };
}
