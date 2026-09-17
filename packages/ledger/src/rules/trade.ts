import type { TradeEconomics } from '@inrp2p/kernel';
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

/** `trade:{t}:complete`: moves deferred margin to realized gross margin. Zero margin posts nothing. */
export function tradeCompleteJournal(econ: TradeEconomics, refs: Pick<TradeLedgerRefs, 'tradeId'>): JournalInput | null {
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
