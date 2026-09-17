import { DomainError, Money, type TradeEconomics } from '@inrp2p/kernel';
import type { DirectionValue, ExecutionMode, FixedSideValue, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { postJournal, tradeAcceptJournal } from '@inrp2p/ledger';
import { openRouteObligation } from '@inrp2p/routes';

/** The accepted quote's frozen terms, exactly as stored on the quote row. */
export interface AcceptedQuoteTerms {
  readonly quoteId: string;
  readonly tradeRequestId: string;
  readonly clientId: string;
  readonly direction: DirectionValue;
  readonly fixedSide: FixedSideValue;
  readonly baseMinor: bigint;
  readonly quoteInrMinor: bigint;
  readonly clientRateMicro: bigint;
  readonly routeRateMicro: bigint;
  readonly routeValueInrMinor: bigint;
  readonly grossMarginInrMinor: bigint;
  readonly routeId: string;
  readonly routeRateSnapshotId: string;
  readonly network: 'TRON';
  readonly bankAccountId: string | null;
  readonly cryptoWalletId: string | null;
}

export interface OpenedTrade {
  readonly tradeId: string;
  readonly ref: string;
  readonly routeObligationId: string;
  readonly acceptJournalId: string;
  readonly executionMode: ExecutionMode;
}

/**
 * T1 (STATE_MACHINES §3): inside the acceptance transaction, after the quote row is ACCEPTED. Creates the trade in
 * AWAITING_FIRST_LEG, its insert-once economics (with the route execution mode frozen from the route now), the route
 * obligation (OPEN) and the `trade:{t}:accept` journal (FINANCIAL_INVARIANTS §3.3). The database re-checks that
 * economics equal the quote and that the obligation equals the economics.
 */
export async function openTradeFromAcceptedQuote(ctx: TxContext, terms: AcceptedQuoteTerms, executionMode: ExecutionMode): Promise<OpenedTrade> {
  if (terms.direction === 'SELL_USDT' && terms.grossMarginInrMinor !== terms.routeValueInrMinor - terms.quoteInrMinor) {
    throw new DomainError('INVALID_ARGUMENT', 'quote margin is inconsistent');
  }
  if (terms.direction === 'BUY_USDT' && terms.grossMarginInrMinor !== terms.quoteInrMinor - terms.routeValueInrMinor) {
    throw new DomainError('INVALID_ARGUMENT', 'quote margin is inconsistent');
  }
  const actor = ctx.actor.id ?? 'SYSTEM';
  const trade = await ctx.tx
    .insertInto('trade')
    .values({ quote_id: terms.quoteId, trade_request_id: terms.tradeRequestId, client_id: terms.clientId, direction: terms.direction, lifecycle_state: 'AWAITING_FIRST_LEG', created_by: actor })
    .returning(['id', 'ref', 'opened_at'])
    .executeTakeFirstOrThrow();
  await ctx.tx
    .insertInto('trade_economics')
    .values({
      trade_id: trade.id,
      direction: terms.direction,
      fixed_side: terms.fixedSide,
      base_minor: terms.baseMinor,
      quote_inr_minor: terms.quoteInrMinor,
      client_rate_micro: terms.clientRateMicro,
      route_rate_micro: terms.routeRateMicro,
      route_value_inr_minor: terms.routeValueInrMinor,
      gross_margin_inr_minor: terms.grossMarginInrMinor,
      route_id: terms.routeId,
      route_rate_snapshot_id: terms.routeRateSnapshotId,
      route_execution_mode: executionMode,
      network: terms.network,
      bank_account_id: terms.bankAccountId,
      crypto_wallet_id: terms.cryptoWalletId,
    })
    .execute();
  await ctx.tx
    .insertInto('trade_transition')
    .values({ trade_id: trade.id, from_state: null, to_state: 'AWAITING_FIRST_LEG', command: ctx.commandName, actor, correlation_id: ctx.correlationId })
    .execute();

  const base = Money.ofMinor(terms.baseMinor, 'USDT');
  const clientInr = Money.ofMinor(terms.quoteInrMinor, 'INR');
  const routeInr = Money.ofMinor(terms.routeValueInrMinor, 'INR');
  const obligation = await openRouteObligation(ctx, { tradeId: trade.id, routeId: terms.routeId, direction: terms.direction, executionMode, base, routeValueInr: routeInr });

  const econ: TradeEconomics = { direction: terms.direction, fixedSide: terms.fixedSide, base, clientInr, routeInr, grossMargin: Money.ofMinor(terms.grossMarginInrMinor, 'INR') };
  const journal = await postJournal(ctx, tradeAcceptJournal(econ, { tradeId: trade.id, clientId: terms.clientId, routeId: terms.routeId, routeObligationId: obligation.routeObligationId }));

  await appendAudit(ctx, {
    action: 'trade.opened', entityType: 'trade', entityId: trade.id,
    after: { ref: trade.ref, quote_id: terms.quoteId, direction: terms.direction, state: 'AWAITING_FIRST_LEG', route_execution_mode: executionMode, route_obligation_id: obligation.routeObligationId, journal: journal.postingKey },
  });
  return { tradeId: trade.id, ref: trade.ref, routeObligationId: obligation.routeObligationId, acceptJournalId: journal.id, executionMode };
}
