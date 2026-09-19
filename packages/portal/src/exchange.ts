import { DomainError } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';
import { type ClientQuoteView, toClientQuoteView } from '@inrp2p/quotes';
import { clientSafe } from './access.ts';
import { type ClientDestinations, clientDestinations } from './destinations.ts';

/**
 * The Exchange screen (UX_FLOWS F1): what the client can ask for, and what the desk has said back.
 *
 * A client has at most one live conversation at a time — a request being priced, or a quote counting down.
 * Anything else is history. The quote is the desk's own client projection (`ClientQuoteView`), so the figures
 * here are the figures the quote was sent with, not a recomputation that could disagree with it.
 */
export interface OpenRequest {
  readonly ref: string;
  readonly direction: 'SELL_USDT' | 'BUY_USDT';
  readonly fixedSide: 'BASE' | 'QUOTE';
  readonly amount: string;
  readonly currency: 'USDT' | 'INR';
  readonly targetRate: string | null;
  readonly destination: string;
  readonly status: 'OPEN' | 'QUOTED' | 'DECLINED' | 'EXPIRED' | 'WITHDRAWN';
  readonly statusReason: string | null;
  readonly createdAt: string;
}

export interface ExchangeView {
  readonly destinations: ClientDestinations;
  /** The request the desk is working on, if any. */
  readonly request: OpenRequest | null;
  /** The live quote for that request: SENT and not yet expired, or the one that just expired, so the screen can say so. */
  readonly quote: ClientQuoteView | null;
  /** The trade a just-accepted quote became, so the screen can take the client straight to it. */
  readonly openTradeRef: string | null;
}

export async function exchangeView(ex: Executor, clientId: string): Promise<ExchangeView> {
  const destinations = await clientDestinations(ex, clientId);

  const request = await ex
    .selectFrom('trade_request')
    .select([
      'id', 'ref', 'direction', 'fixed_side', 'requested_base_minor', 'requested_quote_minor', 'target_rate_micro',
      'bank_account_id', 'crypto_wallet_id', 'status', 'status_reason', 'created_at',
    ])
    .where('client_id', '=', clientId)
    .where('status', 'in', ['OPEN', 'QUOTED', 'DECLINED'])
    .orderBy('created_at', 'desc')
    // Two rows can share a timestamp; the id breaks the tie, so "the latest" is one row and always the same one.
    .orderBy('id', 'desc')
    .executeTakeFirst();

  const quoteRow = request
    ? await ex
        .selectFrom('quote')
        .select(['id', 'status'])
        .where('trade_request_id', '=', request.id)
        .where('status', 'in', ['SENT', 'EXPIRED', 'ACCEPTED'])
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .executeTakeFirst()
    : undefined;

  const quote = quoteRow ? await toClientQuoteView(ex, quoteRow.id) : null;

  const openTrade =
    quoteRow?.status === 'ACCEPTED'
      ? await ex.selectFrom('trade').select('ref').where('quote_id', '=', quoteRow.id).executeTakeFirst()
      : undefined;

  return clientSafe({
    destinations,
    request: request
      ? {
          ref: request.ref,
          direction: request.direction,
          fixedSide: request.fixed_side,
          amount: amountOf(request),
          currency: request.fixed_side === 'BASE' ? ('USDT' as const) : ('INR' as const),
          targetRate: request.target_rate_micro === null ? null : micro(request.target_rate_micro),
          destination: destinationLabel(destinations, request),
          status: request.status as OpenRequest['status'],
          statusReason: request.status_reason,
          createdAt: request.created_at.toISOString(),
        }
      : null,
    quote,
    openTradeRef: openTrade?.ref ?? null,
  });
}

/**
 * Turns a reference the client can read into the id a command needs, scoped to their own client.
 *
 * The client projections carry no internal ids, so a quote's page identifies it the way the client does — by its
 * reference. Resolving it here, filtered by the client the session resolved to, means a reference from another
 * client's quote is simply not found; the command then authorizes the membership again for itself.
 */
export async function quoteIdForRef(ex: Executor, clientId: string, ref: string): Promise<string> {
  const row = await ex.selectFrom('quote').select(['id']).where('ref', '=', ref).where('client_id', '=', clientId).where('status', '!=', 'DRAFT').executeTakeFirst();
  if (!row) throw new DomainError('NOT_FOUND', 'quote not found');
  return row.id;
}

export async function requestIdForRef(ex: Executor, clientId: string, ref: string): Promise<string> {
  const row = await ex.selectFrom('trade_request').select(['id']).where('ref', '=', ref).where('client_id', '=', clientId).executeTakeFirst();
  if (!row) throw new DomainError('NOT_FOUND', 'request not found');
  return row.id;
}

/** Minor units and micro rates as decimal strings, never through a float (FINANCIAL_INVARIANTS §1.1). */
const fixed = (value: bigint, scale: number): string => {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  return `${negative ? '-' : ''}${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
};
const micro = (value: bigint): string => fixed(value, 6);

const amountOf = (r: { fixed_side: 'BASE' | 'QUOTE'; requested_base_minor: bigint | null; requested_quote_minor: bigint | null }): string =>
  r.fixed_side === 'BASE' ? fixed(r.requested_base_minor ?? 0n, 6) : fixed(r.requested_quote_minor ?? 0n, 2);

function destinationLabel(destinations: ClientDestinations, r: { bank_account_id: string | null; crypto_wallet_id: string | null }): string {
  if (r.bank_account_id) {
    const bank = destinations.banks.find((b) => b.id === r.bank_account_id);
    return bank ? `${bank.bankName} •••• ${bank.last4}` : 'a bank account';
  }
  if (r.crypto_wallet_id) {
    const wallet = destinations.wallets.find((w) => w.id === r.crypto_wallet_id);
    return wallet ? `TRC20 · ${wallet.address.slice(0, 3)}…${wallet.address.slice(-4)}` : 'a wallet';
  }
  return 'no destination';
}
