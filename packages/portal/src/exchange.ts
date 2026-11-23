import { DomainError } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';
import { type ClientQuoteView, type WaitingFacts, automaticPricingOf, toClientQuoteView, waitingFactsOf } from '@inrp2p/quotes';
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
  /**
   * ADR 0028: declined by the system, not a person — nothing priced it honestly when it was asked. `statusReason` then says
   * what happened and what the client can do; asking again is a new request.
   */
  readonly noPrice: boolean;
  /**
   * ADR 0032: nothing priced it yet and the exchange is looking for a trader, until this time — the client is told by message
   * the moment one prices it, and the price is held for it. Null when it is not waiting.
   */
  readonly waitingUntil: string | null;
  /** While it waits: the amounts a trader takes right now, in the client's words, when there are any — asked for, priced at once. */
  readonly readyNow: string | null;
  /** ADR 0032: the wait itself — since when, on what, how many traders know, how many are ahead, what is ready now. */
  readonly waiting: WaitingFacts | null;
  readonly createdAt: string;
  /** ADR 0025: when the best price for this amount is being gathered, until when; and whether the client can ask for a new price itself. */
  readonly gatheringUntil: string | null;
  readonly canReprice: boolean;
}

export interface ExchangeView {
  readonly destinations: ClientDestinations;
  /** The request the desk is working on, if any. */
  readonly request: OpenRequest | null;
  /** The live quote for that request: SENT and not yet expired, or the one that just expired, so the screen can say so. */
  readonly quote: ClientQuoteView | null;
  /** The trade the latest request became, when it was accepted, so the screen can point the client at it. */
  readonly openTradeRef: string | null;
}

/** The request states the screen has something to say about. Anything else is history, and the screen offers a new request. */
const SHOWN: readonly string[] = ['OPEN', 'QUOTED', 'DECLINED'];

export async function exchangeView(ex: Executor, clientId: string): Promise<ExchangeView> {
  // The client's destinations, and — read alongside, since neither needs the other — the latest request of any status,
  // and only then whether it is one to show: filtering first would reach past a request that was accepted or withdrawn
  // to an older decline, and tell the client about it as if it were news.
  const [destinations, latest] = await Promise.all([
    clientDestinations(ex, clientId),
    ex
      .selectFrom('trade_request')
      .select([
        'id', 'ref', 'direction', 'fixed_side', 'requested_base_minor', 'requested_quote_minor', 'target_rate_micro',
        'bank_account_id', 'crypto_wallet_id', 'status', 'status_reason', 'no_price_reason', 'created_at',
      ])
      .where('client_id', '=', clientId)
      // A deal with an independent desk (ADR 0020) has its own page; the Exchange is the INRP2P desk's conversation.
      .where('desk_id', 'is', null)
      .orderBy('created_at', 'desc')
      // Two rows can share a timestamp; the id breaks the tie, so "the latest" is one row and always the same one.
      .orderBy('id', 'desc')
      .executeTakeFirst(),
  ]);
  const request = latest && SHOWN.includes(latest.status) ? latest : undefined;

  // Likewise the latest quote the client was sent for it, and only then whether it is live or just ran out: an
  // older expired quote must not resurface after a newer one was declined or withdrawn by the desk.
  const latestQuote = request
    ? await ex
        .selectFrom('quote')
        .select(['id', 'status'])
        .where('trade_request_id', '=', request.id)
        .where('status', '!=', 'DRAFT')
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .executeTakeFirst()
    : undefined;
  const quoteRow = latestQuote && (latestQuote.status === 'SENT' || latestQuote.status === 'EXPIRED') ? latestQuote : undefined;

  const quote = quoteRow ? await toClientQuoteView(ex, quoteRow.id) : null;
  const automatic = request && request.status === 'OPEN' ? await automaticPricingOf(ex, request.id) : { rfqClosesAt: null, waitingUntil: null, canReprice: false };
  const waiting = request && automatic.waitingUntil ? await waitingFactsOf(ex, request.id) : null;

  // An accepted request became a trade: the one its accepted quote opened.
  const openTrade =
    latest?.status === 'ACCEPTED'
      ? await ex
          .selectFrom('trade as t')
          .innerJoin('quote as q', 'q.id', 't.quote_id')
          .select('t.ref')
          .where('q.trade_request_id', '=', latest.id)
          .where('q.status', '=', 'ACCEPTED')
          .executeTakeFirst()
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
          noPrice: request.status === 'DECLINED' && request.no_price_reason !== null,
          waitingUntil: automatic.waitingUntil,
          readyNow: automatic.waitingUntil ? request.status_reason : null,
          waiting,
          createdAt: request.created_at.toISOString(),
          gatheringUntil: automatic.rfqClosesAt,
          canReprice: automatic.canReprice,
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
