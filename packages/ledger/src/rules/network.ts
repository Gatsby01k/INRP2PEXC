import { DomainError, type Money } from '@inrp2p/kernel';
import { type AccountRef, Accounts } from '../accounts.ts';
import type { JournalInput } from '../posting.ts';

/** Who bears the network of one GasFree transfer (ADR 0022 §2.3), out of the USDT it leaves. */
export type NetworkFeeBearer =
  /** A payout or a sweep: the deal's allowance pays it — booked as network expense, recovered when the trade settles. */
  | { readonly kind: 'ALLOWANCE' }
  /** A client's USDT refunded: the refund goes back less its own network — the two close the client receivable together. */
  | { readonly kind: 'CLIENT'; readonly clientId: string }
  /** A trader's escrow returned: the return goes back less its own network, out of what the exchange owed the trader. */
  | { readonly kind: 'ROUTE'; readonly routeId: string; readonly routeObligationId: string };

/**
 * `gasfree:{permit}:fee` (ADR 0022 §2.5) — what the GasFree controller charged one transfer, out of the deal address it
 * left, in the same transaction as the transfer itself: an asset of the exchange at that wallet gone to the provider, borne
 * by the deal's allowance, the refunded client or the returning trader.
 */
export function networkFeeJournal(input: { readonly permitId: string; readonly tradeId: string | null; readonly walletId: string; readonly fee: Money<'USDT'>; readonly bearer: NetworkFeeBearer }): JournalInput | null {
  if (input.fee.isNegative()) throw new DomainError('INVALID_AMOUNT', 'a network fee is never negative');
  if (input.fee.isZero()) return null;
  const b = input.bearer;
  const debit: AccountRef = b.kind === 'CLIENT' ? Accounts.clientReceivable(b.clientId, 'USDT') : b.kind === 'ROUTE' ? Accounts.routeReceivable(b.routeId, 'USDT') : Accounts.networkFeesUsdt();
  return {
    postingKey: `gasfree:${input.permitId}:fee`,
    eventType: 'network.fee_charged',
    tradeId: input.tradeId,
    entries: [
      { account: debit, direction: 'DR', amount: input.fee, ...(b.kind === 'ROUTE' ? { routeObligationId: b.routeObligationId } : {}) },
      { account: Accounts.treasuryUsdt(input.walletId), direction: 'CR', amount: input.fee },
    ],
  };
}

/**
 * `network:{trade}:settle` (ADR 0022 §2.5) — a completed trade's network allowance, settled at cost once its own transfers
 * are done: what they cost is realized as `REVENUE:NETWORK_RECOVERED` (against the expense each transfer booked), what they
 * did not is INRP2P's margin (the sweep's own network, paid later, is part of it). A rise of the fees beyond the allowance
 * stays INRP2P's expense, already booked. Nothing is posted for an empty allowance.
 */
export function networkSettleJournal(input: { readonly tradeId: string; readonly allowance: Money<'USDT'>; readonly spent: Money<'USDT'> }): JournalInput | null {
  const { allowance, spent } = input;
  if (allowance.isNegative() || spent.isNegative()) throw new DomainError('INVALID_ARGUMENT', 'a settlement never moves less than nothing');
  if (allowance.isZero()) return null;
  const recovered = spent.compare(allowance) > 0 ? allowance : spent;
  const unused = allowance.sub(recovered);
  return {
    postingKey: `network:${input.tradeId}:settle`,
    eventType: 'network.settled',
    tradeId: input.tradeId,
    entries: [
      { account: Accounts.networkAllowance(), direction: 'DR', amount: allowance },
      ...(recovered.isZero() ? [] : [{ account: Accounts.networkRecovered(), direction: 'CR' as const, amount: recovered }]),
      ...(unused.isZero() ? [] : [{ account: Accounts.grossMargin('USDT'), direction: 'CR' as const, amount: unused }]),
    ],
  };
}
