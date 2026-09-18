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
   */
  readonly purpose: 'CLIENT_FIRST_LEG' | 'CLIENT_PAYOUT' | 'ROUTE_SETTLEMENT' | 'REFUND' | 'UNALLOCATED';
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
        { account: exchangeAsset(to, amount), direction: 'DR', amount },
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
  }

  return {
    postingKey: `${input.kind === 'FIAT' ? 'fiat' : 'crypto'}:${input.movementId}:confirm`,
    eventType: input.kind === 'FIAT' ? 'fiat_transfer.confirmed' : 'crypto_transfer.confirmed',
    tradeId: input.tradeId ?? null,
    entries,
  };
}
