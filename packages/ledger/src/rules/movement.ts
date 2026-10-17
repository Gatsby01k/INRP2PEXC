import { DomainError, type Money } from '@inrp2p/kernel';
import { Accounts } from '../accounts.ts';
import type { EntryInput, JournalInput } from '../posting.ts';

/**
 * One real movement of value, as the evidence row records it. The ledger accounts are chosen from the
 * (payer, payee) pair alone (FINANCIAL_INVARIANTS §3.1), so the same movement can never be posted twice
 * under two different readings of what it satisfied.
 */
export type MovementParty =
  | { readonly kind: 'CLIENT'; readonly clientId: string }
  | { readonly kind: 'EXCHANGE_ACCOUNT'; readonly inrAccountId: string }
  | { readonly kind: 'EXCHANGE_TREASURY'; readonly walletId: string }
  | { readonly kind: 'ROUTE'; readonly routeId: string; readonly routeObligationId?: string | null }
  | { readonly kind: 'TRADER'; readonly traderId: string }
  | { readonly kind: 'SUSPENSE' };

export interface MovementJournalInput {
  readonly kind: 'FIAT' | 'CRYPTO';
  /** Evidence row id: the journal key is `fiat:{id}:confirm` / `crypto:{id}:confirm` (FI-27, FI-42). */
  readonly movementId: string;
  readonly amount: Money;
  readonly from: MovementParty;
  readonly to: MovementParty;
  readonly tradeId?: string | null;
  /**
   * `CLIENT_FIRST_LEG` and `REFUND` move the client receivable; `CLIENT_PAYOUT` moves the client payable.
   * `ROUTE_SETTLEMENT` moves the route side. `UNALLOCATED` parks funds in suspense until an operator decides.
   * `TRADER_RESERVE` moves a trader's Security Reserve in (deposit) or out (withdrawal); `TRADER_REWARD_PAYOUT`
   * pays accrued rewards to the trader. `TRADER_RESERVE_APPLIED` is a trader's reserve delivering the USDT its route
   * owes (TD-21): from the trader, to the route obligation, moved by custody between two exchange wallets.
   * `ESCROW_RETURN` gives a P2P trader its own USDT back from the escrow of a deal its client never paid (ADR 0019).
   */
  readonly purpose: 'CLIENT_FIRST_LEG' | 'CLIENT_PAYOUT' | 'ROUTE_SETTLEMENT' | 'REFUND' | 'UNALLOCATED' | 'TRADER_RESERVE' | 'TRADER_REWARD_PAYOUT' | 'TRADER_RESERVE_APPLIED' | 'ESCROW_RETURN';
  /** `TRADER_RESERVE_APPLIED` only: the treasury wallets the USDT left and reached (the same wallet moves nothing). */
  readonly custody?: { readonly fromWalletId: string; readonly toWalletId: string } | null;
}

const exchangeAsset = (p: MovementParty, amount: Money) => {
  if (p.kind === 'EXCHANGE_ACCOUNT') return Accounts.inrSettlement(p.inrAccountId);
  if (p.kind === 'EXCHANGE_TREASURY') return Accounts.treasuryUsdt(p.walletId);
  throw new DomainError('INVALID_ARGUMENT', `party ${p.kind} has no exchange asset account for ${amount.currency}`);
};

const routeLines = (p: MovementParty) => {
  if (p.kind !== 'ROUTE') throw new DomainError('INVALID_ARGUMENT', 'expected a route party');
  return p;
};

/**
 * The movement posting table (FINANCIAL_INVARIANTS §3.4). Every case is listed explicitly: an unlisted
 * (payer, payee, purpose) combination is a bug and is refused rather than posted "as close as possible".
 */
export function movementJournal(input: MovementJournalInput): JournalInput {
  const { amount, from, to } = input;
  const key = `${from.kind}->${to.kind}`;
  let entries: readonly EntryInput[];

  switch (input.purpose) {
    case 'CLIENT_FIRST_LEG': {
      if (from.kind !== 'CLIENT') throw new DomainError('INVALID_ARGUMENT', `first-leg movement must come from the client (${key})`);
      entries = [
        // P2P (ADR 0019): the client pays the route directly — what the client owes and what the exchange owes the route
        // fall together, and no exchange account moves.
        to.kind === 'ROUTE'
          ? { account: Accounts.routePayable(to.routeId, amount.currency), direction: 'DR', amount, routeObligationId: to.routeObligationId ?? null }
          : { account: exchangeAsset(to, amount), direction: 'DR', amount },
        { account: Accounts.clientReceivable(from.clientId, amount.currency), direction: 'CR', amount },
      ];
      break;
    }
    case 'CLIENT_PAYOUT': {
      if (to.kind !== 'CLIENT') throw new DomainError('INVALID_ARGUMENT', `payout movement must go to the client (${key})`);
      const credit: EntryInput =
        from.kind === 'ROUTE'
          ? { account: Accounts.routeReceivable(routeLines(from).routeId, amount.currency), direction: 'CR', amount, routeObligationId: from.routeObligationId ?? null }
          : { account: exchangeAsset(from, amount), direction: 'CR', amount };
      entries = [{ account: Accounts.clientPayable(to.clientId, amount.currency), direction: 'DR', amount }, credit];
      break;
    }
    case 'ROUTE_SETTLEMENT': {
      if (from.kind === 'ROUTE') {
        // Route delivers to the exchange: the exchange asset grows, the route receivable shrinks.
        entries = [
          { account: exchangeAsset(to, amount), direction: 'DR', amount },
          { account: Accounts.routeReceivable(from.routeId, amount.currency), direction: 'CR', amount, routeObligationId: from.routeObligationId ?? null },
        ];
      } else if (to.kind === 'ROUTE') {
        entries = [
          { account: Accounts.routePayable(to.routeId, amount.currency), direction: 'DR', amount, routeObligationId: to.routeObligationId ?? null },
          { account: exchangeAsset(from, amount), direction: 'CR', amount },
        ];
      } else {
        throw new DomainError('INVALID_ARGUMENT', `route settlement movement must involve a route (${key})`);
      }
      break;
    }
    case 'ESCROW_RETURN': {
      // The cancellation reversed what the route owed; its delivery is still credited to it. Sending the USDT back closes
      // that: the route receivable is debited, the escrow's treasury asset credited.
      if (from.kind !== 'EXCHANGE_TREASURY' || to.kind !== 'ROUTE' || amount.currency !== 'USDT') {
        throw new DomainError('INVALID_ARGUMENT', `an escrow return is USDT from the exchange to the route (${key})`);
      }
      entries = [
        { account: Accounts.routeReceivable(to.routeId, 'USDT'), direction: 'DR', amount, routeObligationId: to.routeObligationId ?? null },
        { account: exchangeAsset(from, amount), direction: 'CR', amount },
      ];
      break;
    }
    case 'REFUND': {
      if (to.kind !== 'CLIENT') throw new DomainError('INVALID_ARGUMENT', `a refund must go to the client (${key})`);
      entries = [
        { account: Accounts.clientReceivable(to.clientId, amount.currency), direction: 'DR', amount },
        { account: exchangeAsset(from, amount), direction: 'CR', amount },
      ];
      break;
    }
    case 'UNALLOCATED': {
      entries = [
        { account: exchangeAsset(to, amount), direction: 'DR', amount },
        { account: Accounts.suspenseUnallocated(amount.currency), direction: 'CR', amount },
      ];
      break;
    }
    case 'TRADER_RESERVE': {
      if (amount.currency !== 'USDT') throw new DomainError('INVALID_ARGUMENT', 'a Security Reserve moves USDT only');
      if (from.kind === 'TRADER') {
        // Deposit: the treasury grows by USDT the exchange now owes back to the trader.
        entries = [
          { account: exchangeAsset(to, amount), direction: 'DR', amount },
          { account: Accounts.traderReserve(from.traderId), direction: 'CR', amount },
        ];
      } else if (to.kind === 'TRADER') {
        // Withdrawal: the debt to the trader shrinks by what left the treasury.
        entries = [
          { account: Accounts.traderReserve(to.traderId), direction: 'DR', amount },
          { account: exchangeAsset(from, amount), direction: 'CR', amount },
        ];
      } else {
        throw new DomainError('INVALID_ARGUMENT', `a reserve movement must involve the trader (${key})`);
      }
      break;
    }
    case 'TRADER_RESERVE_APPLIED': {
      // The USDT was already the exchange's to hold — the trader's reserve — so the treasury does not grow: the debt to
      // the trader and the route's debt to the exchange shrink together. Custody moved it between exchange wallets.
      if (from.kind !== 'TRADER' || to.kind !== 'ROUTE' || amount.currency !== 'USDT' || !input.custody) {
        throw new DomainError('INVALID_ARGUMENT', `an applied reserve is USDT from the trader to its route obligation, moved between exchange wallets (${key})`);
      }
      const custody = input.custody;
      entries = [
        { account: Accounts.traderReserve(from.traderId), direction: 'DR', amount },
        { account: Accounts.routeReceivable(to.routeId, 'USDT'), direction: 'CR', amount, routeObligationId: to.routeObligationId ?? null },
        ...(custody.fromWalletId === custody.toWalletId
          ? []
          : ([
              { account: Accounts.treasuryUsdt(custody.toWalletId), direction: 'DR', amount },
              { account: Accounts.treasuryUsdt(custody.fromWalletId), direction: 'CR', amount },
            ] as const)),
      ];
      break;
    }
    case 'TRADER_REWARD_PAYOUT': {
      if (to.kind !== 'TRADER' || amount.currency !== 'INR') throw new DomainError('INVALID_ARGUMENT', `a reward payout pays INR to the trader (${key})`);
      entries = [
        { account: Accounts.traderRewardPayable(to.traderId), direction: 'DR', amount },
        { account: exchangeAsset(from, amount), direction: 'CR', amount },
      ];
      break;
    }
  }

  return {
    postingKey: `${input.kind === 'FIAT' ? 'fiat' : 'crypto'}:${input.movementId}:confirm`,
    eventType: input.kind === 'FIAT' ? 'fiat_transfer.confirmed' : 'crypto_transfer.confirmed',
    tradeId: input.tradeId ?? null,
    entries,
  };
}
