import { DomainError, Money } from '@inrp2p/kernel';
import { Accounts, type AccountRef } from '../accounts.ts';
import type { EntryInput, JournalInput } from '../posting.ts';

export interface AdjustmentDeltas {
  /** Signed minor-unit deltas on the frozen economics; the margin delta is derived (FI-02, FI-12). */
  readonly baseMinor: bigint;
  readonly clientInrMinor: bigint;
  readonly routeInrMinor: bigint;
  readonly marginInrMinor: bigint;
}

export interface AdjustmentRefs {
  readonly adjustmentId: string;
  readonly tradeId: string;
  readonly clientId: string;
  readonly routeId: string;
  readonly routeObligationId: string;
  readonly direction: 'SELL_USDT' | 'BUY_USDT';
  /** A completed trade has already realized its margin, so a margin delta lands in revenue (FI-43). */
  readonly marginRealized: boolean;
}

function line(account: AccountRef, nominal: 'DR' | 'CR', delta: bigint, routeObligationId?: string): EntryInput[] {
  if (delta === 0n) return [];
  const flipped = delta < 0n;
  const amount = Money.ofMinor(flipped ? -delta : delta, account.currency);
  const direction = flipped ? (nominal === 'DR' ? 'CR' : 'DR') : nominal;
  return [{ account, direction, amount, ...(routeObligationId ? { routeObligationId } : {}) }];
}

/**
 * `adj:{id}` (FINANCIAL_INVARIANTS §3.3). The original economics and their accept journal are never touched:
 * the adjustment posts the difference on the same accounts, so effective terms = original ⊕ posted adjustments.
 */
export function adjustmentJournal(deltas: AdjustmentDeltas, refs: AdjustmentRefs): JournalInput {
  const marginAccount = refs.marginRealized ? Accounts.grossMargin() : Accounts.deferredMargin();
  const entries =
    refs.direction === 'SELL_USDT'
      ? [
          ...line(Accounts.clientReceivable(refs.clientId, 'USDT'), 'DR', deltas.baseMinor),
          ...line(Accounts.routePayable(refs.routeId, 'USDT'), 'CR', deltas.baseMinor, refs.routeObligationId),
          ...line(Accounts.routeReceivable(refs.routeId, 'INR'), 'DR', deltas.routeInrMinor, refs.routeObligationId),
          ...line(Accounts.clientPayable(refs.clientId, 'INR'), 'CR', deltas.clientInrMinor),
          ...line(marginAccount, 'CR', deltas.marginInrMinor),
        ]
      : [
          ...line(Accounts.clientReceivable(refs.clientId, 'INR'), 'DR', deltas.clientInrMinor),
          ...line(Accounts.routePayable(refs.routeId, 'INR'), 'CR', deltas.routeInrMinor, refs.routeObligationId),
          ...line(marginAccount, 'CR', deltas.marginInrMinor),
          ...line(Accounts.routeReceivable(refs.routeId, 'USDT'), 'DR', deltas.baseMinor, refs.routeObligationId),
          ...line(Accounts.clientPayable(refs.clientId, 'USDT'), 'CR', deltas.baseMinor),
        ];
  if (entries.length < 2) throw new DomainError('EMPTY_JOURNAL', 'an adjustment must move at least two accounts');
  return { postingKey: `adj:${refs.adjustmentId}`, eventType: 'adjustment.posted', tradeId: refs.tradeId, entries };
}
