import { sql } from 'kysely';
import { DomainError, Money, requireUuid } from '@inrp2p/kernel';
import type { ActorRef, Db, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { executeCommand } from '@inrp2p/commands';
import type { ClientActor } from '@inrp2p/identity';
import { assertNewBusinessOpen, openTradeFromAcceptedQuote, tradeFundingModel } from '@inrp2p/trades';
import { getClientTradeView, type ClientTradeView } from '@inrp2p/trades';
import { allocateDepositAddress, assertSellAcceptanceSupported, assignTradeCollection } from '@inrp2p/treasury';
import { startOrderForTrade } from '@inrp2p/trader-core';
import { holdNetworkBudget, quoteNetworkFee } from '@inrp2p/network';
import { lockRow, requireQuoteDecider } from './actors.ts';
import { consumeChallengeInCommand, hitDecisionRateLimit, resolveLink, verifyChallengeCode } from './challenges.ts';
import { closePendingChallenges } from './challenges.ts';
import { type QuoteDeps, policyOf } from './policy.ts';
import { reopenRequest } from './quotes.ts';
import { businessNow } from './security.ts';

export interface AcceptResult {
  readonly tradeId: string;
  readonly tradeRef: string;
  readonly quoteRef: string;
  readonly trade: ClientTradeView;
}

interface DecisionContext {
  readonly quote: {
    id: string; ref: string; trade_request_id: string; client_id: string; direction: 'SELL_USDT' | 'BUY_USDT'; fixed_side: 'BASE' | 'QUOTE';
    base_minor: bigint; quote_inr_minor: bigint; client_rate_micro: bigint; route_rate_micro: bigint; route_rate_snapshot_id: string; route_id: string;
    route_value_inr_minor: bigint; gross_margin_inr_minor: bigint; network: 'TRON'; bank_account_id: string | null; crypto_wallet_id: string | null;
    status: string; expires_at: Date | null;
  };
}

/** Locks request → quote (global lock order) and validates everything both decision paths share. */
async function loadDecidableQuote(ctx: TxContext, quoteId: string): Promise<DecisionContext['quote']> {
  const q0 = await ctx.tx.selectFrom('quote').select(['trade_request_id']).where('id', '=', requireUuid(quoteId, 'quoteId')).executeTakeFirst();
  if (!q0) throw new DomainError('NOT_FOUND', 'quote not found');
  await lockRow(ctx.tx, 'trade_request', 'trade_request', q0.trade_request_id);
  await lockRow(ctx.tx, 'quote', 'quote', quoteId);
  const quote = await ctx.tx.selectFrom('quote').selectAll().where('id', '=', quoteId).executeTakeFirstOrThrow();
  if (quote.status === 'ACCEPTED') throw new DomainError('QUOTE_ALREADY_ACCEPTED', 'this quote was already accepted');
  if (quote.status !== 'SENT') throw new DomainError('QUOTE_NOT_SENT', `quote is ${quote.status}`);
  const now = await businessNow(ctx.tx);
  // FI-04: judged at the database's statement time, never a client or app-server clock.
  if (!quote.expires_at || now >= quote.expires_at) throw new DomainError('QUOTE_EXPIRED', 'quote has expired');
  return quote as DecisionContext['quote'];
}

async function assertAcceptable(ctx: TxContext, deps: QuoteDeps, quote: DecisionContext['quote']): Promise<void> {
  const policy = policyOf(deps);
  // While new business is paused a quote is not turned into a trade, whoever accepts it (migration 0033, IX098).
  await assertNewBusinessOpen(ctx.tx);
  const client = await ctx.tx.selectFrom('client').select(['status', 'kyc_status']).where('id', '=', quote.client_id).forShare().executeTakeFirstOrThrow();
  if (client.status !== 'ACTIVE') throw new DomainError('CLIENT_NOT_ACTIVE', 'client is suspended');
  if (policy.requireKycVerified && client.kyc_status !== 'VERIFIED') throw new DomainError('KYC_NOT_VERIFIED', 'client KYC is not verified');
  const request = await ctx.tx.selectFrom('trade_request').select(['status']).where('id', '=', quote.trade_request_id).executeTakeFirstOrThrow();
  if (request.status !== 'QUOTED') throw new DomainError('REQUEST_NOT_OPEN', `request is ${request.status}`);
  // S8: the destination captured on the quote must still be the active one (archive-not-edit makes this detectable).
  if (quote.bank_account_id) {
    const b = await ctx.tx.selectFrom('bank_account').select(['status']).where('id', '=', quote.bank_account_id).forShare().executeTakeFirstOrThrow();
    if (b.status !== 'ACTIVE') throw new DomainError('DESTINATION_CHANGED', 'the payout bank account changed; ask the desk for a new quote');
  }
  if (quote.crypto_wallet_id) {
    const w = await ctx.tx.selectFrom('crypto_wallet').select(['status']).where('id', '=', quote.crypto_wallet_id).forShare().executeTakeFirstOrThrow();
    if (w.status !== 'ACTIVE') throw new DomainError('DESTINATION_CHANGED', 'the destination wallet changed; ask the desk for a new quote');
  }
  if (quote.direction === 'SELL_USDT') await assertSellAcceptanceSupported(ctx.tx, 'TRON');
}

/**
 * The single acceptance body shared by the in-app and OTP-verified link paths (STATE_MACHINES §2, T1):
 * quote → ACCEPTED, request → ACCEPTED, trade + frozen economics + route obligation + accept journal, the trader's
 * order started with its capacity hold (on a trader route), and the SELL deposit address assignment (D-02).
 *
 * Acceptance binds commitments, never money (D-16): the trade is counterparty-funded, so nothing of the exchange's
 * own treasury is reserved for a BUY — the client's USDT will come from what the counterparty delivers, and until it
 * has, no payout can be created (FI-71, FI-72). Acceptance therefore works with zero platform USDT and INR.
 */
async function acceptCore(ctx: TxContext, deps: QuoteDeps, input: { quote: DecisionContext['quote']; decider: { clientUserId: string; userId: string }; via: 'APP' | 'LINK'; challengeId: string | null }): Promise<AcceptResult> {
  const { quote, decider } = input;
  const now = await businessNow(ctx.tx);
  await ctx.tx
    .updateTable('quote')
    .set({ status: 'ACCEPTED', accepted_by_user_id: decider.userId, accepted_via: input.via, acceptance_challenge_id: input.challengeId, accepted_at: now, closed_at: now })
    .where('id', '=', quote.id)
    .execute();
  const request = await ctx.tx.selectFrom('trade_request').select(['version']).where('id', '=', quote.trade_request_id).executeTakeFirstOrThrow();
  await ctx.tx
    .updateTable('trade_request')
    .set({ status: 'ACCEPTED', closed_at: now, last_activity_at: now, version: request.version + 1 })
    .where('id', '=', quote.trade_request_id)
    .execute();

  const route = await ctx.tx.selectFrom('liquidity_route').select(['execution_mode', 'trader_id']).where('id', '=', quote.route_id).forShare().executeTakeFirstOrThrow();
  // A trader filling a client's BUY delivers its USDT to an address of the order's own (D-02): without a confirmed
  // deposit-address capability that delivery could not be attributed, so the trade is not opened at all.
  if (route.trader_id && quote.direction === 'BUY_USDT') await assertSellAcceptanceSupported(ctx.tx, 'TRON');
  const trade = await openTradeFromAcceptedQuote(ctx, {
    quoteId: quote.id,
    tradeRequestId: quote.trade_request_id,
    clientId: quote.client_id,
    direction: quote.direction,
    fixedSide: quote.fixed_side,
    baseMinor: quote.base_minor,
    quoteInrMinor: quote.quote_inr_minor,
    clientRateMicro: quote.client_rate_micro,
    routeRateMicro: quote.route_rate_micro,
    routeValueInrMinor: quote.route_value_inr_minor,
    grossMarginInrMinor: quote.gross_margin_inr_minor,
    routeId: quote.route_id,
    routeRateSnapshotId: quote.route_rate_snapshot_id,
    network: quote.network,
    bankAccountId: quote.bank_account_id,
    cryptoWalletId: quote.crypto_wallet_id,
  }, route.execution_mode);
  // A quote on a trader's route starts that trader's accepted order, bound to this trade and its obligation.
  if (route.trader_id) {
    await startOrderForTrade(ctx, { requestId: quote.trade_request_id, routeId: quote.route_id, quoteId: quote.id, tradeId: trade.tradeId, routeObligationId: trade.routeObligationId });
  }

  // The database made this trade counterparty-funded when it was inserted (migration 0025); acceptance relies on it.
  const funding = await tradeFundingModel(ctx.tx, trade.tradeId);
  if (funding !== 'COUNTERPARTY_FUNDED') throw new DomainError('INVALID_TRANSITION', `a new trade must be counterparty-funded (it is ${funding})`);
  if (quote.direction === 'SELL_USDT') {
    await allocateDepositAddress(ctx, deps.custody, { network: 'TRON', tradeId: trade.tradeId, tradeRef: trade.ref, expectedAmount: Money.ofMinor(quote.base_minor, 'USDT') });
  } else {
    // ADR 0018: a BUY names the account its client pays, the trade's own payment reference and the time to pay.
    await assignTradeCollection(ctx, { tradeId: trade.tradeId });
  }
  // ADR 0017 §2: the trade's transfers are paid for before it exists. Its funder — the trader of its route, or the
  // platform for a desk route — holds the worst case of them (its transfer and, for a SELL, a return of the client's
  // USDT) from now on; a funder without that much free TRX does not get the trade.
  const network = await quoteNetworkFee(ctx.tx, quote.id);
  if (!network) throw new DomainError('QUOTE_NETWORK_FEE_MISSING', 'this quote carries no network fee; ask the desk for a new quote');
  await holdNetworkBudget(ctx, {
    tradeId: trade.tradeId, funder: network.funderTraderId, perSendSun: network.reserveSun / BigInt(network.reserveSends), sends: network.reserveSends, snapshotId: network.snapshotId,
  });

  await closePendingChallenges(ctx, quote.id, 'SUPERSEDED');
  await appendAudit(ctx, {
    action: 'quote.accepted', entityType: 'quote', entityId: quote.id,
    before: { status: 'SENT' },
    after: { status: 'ACCEPTED', via: input.via, accepted_by: decider.userId, trade_id: trade.tradeId, trade_ref: trade.ref, challenge_id: input.challengeId, funding: funding },
  });
  await enqueueOutbox(ctx, { type: 'trade.opened', aggregateType: 'trade', aggregateId: trade.tradeId, payload: { tradeId: trade.tradeId, quoteId: quote.id, clientId: quote.client_id, direction: quote.direction } });
  return { tradeId: trade.tradeId, tradeRef: trade.ref, quoteRef: quote.ref, trade: await getClientTradeView(ctx.tx, trade.tradeId, quote.client_id) };
}

async function rejectCore(ctx: TxContext, input: { quote: DecisionContext['quote']; decider: { userId: string }; via: 'APP' | 'LINK'; challengeId: string | null }): Promise<{ status: 'REJECTED' }> {
  const now = await businessNow(ctx.tx);
  await ctx.tx
    .updateTable('quote')
    .set({ status: 'REJECTED', rejected_by_user_id: input.decider.userId, rejected_via: input.via, acceptance_challenge_id: input.challengeId, rejected_at: now, closed_at: now })
    .where('id', '=', input.quote.id)
    .execute();
  await closePendingChallenges(ctx, input.quote.id, 'SUPERSEDED');
  await reopenRequest(ctx, input.quote.trade_request_id);
  await appendAudit(ctx, { action: 'quote.rejected', entityType: 'quote', entityId: input.quote.id, before: { status: 'SENT' }, after: { status: 'REJECTED', via: input.via, rejected_by: input.decider.userId } });
  await enqueueOutbox(ctx, { type: 'desk.quote_rejected', aggregateType: 'quote', aggregateId: input.quote.id, payload: { quoteId: input.quote.id, clientId: input.quote.client_id } });
  return { status: 'REJECTED' };
}

/**
 * `quote.accept` (in-app) — authenticated client user of the quote's client holding `can_accept_quotes` (D-01).
 * A client session never bypasses the link OTP: that is a different command.
 */
export function acceptQuote(actor: ClientActor, deps: QuoteDeps) {
  return {
    authorize: async (ctx: TxContext, p: { quoteId: string }) => {
      if (ctx.actor.surface !== 'CLIENT') throw new DomainError('SESSION_SURFACE_MISMATCH');
      const q = await ctx.tx.selectFrom('quote').select(['client_id']).where('id', '=', requireUuid(p.quoteId, 'quoteId')).executeTakeFirst();
      if (!q) throw new DomainError('NOT_FOUND', 'quote not found');
      await requireQuoteDecider(ctx.tx, actor.userId, q.client_id, { requireVerifiedEmail: false });
    },
    handle: async (ctx: TxContext, p: { quoteId: string }): Promise<AcceptResult> => {
      const quote = await loadDecidableQuote(ctx, p.quoteId);
      const decider = await requireQuoteDecider(ctx.tx, actor.userId, quote.client_id, { requireVerifiedEmail: false });
      await assertAcceptable(ctx, deps, quote);
      return acceptCore(ctx, deps, { quote, decider, via: 'APP', challengeId: null });
    },
  };
}

/** `quote.reject` (in-app) — same authority as acceptance (D-15). The request returns to OPEN. */
export function rejectQuote(actor: ClientActor) {
  return {
    authorize: async (ctx: TxContext, p: { quoteId: string }) => {
      if (ctx.actor.surface !== 'CLIENT') throw new DomainError('SESSION_SURFACE_MISMATCH');
      const q = await ctx.tx.selectFrom('quote').select(['client_id']).where('id', '=', requireUuid(p.quoteId, 'quoteId')).executeTakeFirst();
      if (!q) throw new DomainError('NOT_FOUND', 'quote not found');
      await requireQuoteDecider(ctx.tx, actor.userId, q.client_id, { requireVerifiedEmail: false });
    },
    handle: async (ctx: TxContext, p: { quoteId: string }) => {
      const quote = await loadDecidableQuote(ctx, p.quoteId);
      const decider = await requireQuoteDecider(ctx.tx, actor.userId, quote.client_id, { requireVerifiedEmail: false });
      return rejectCore(ctx, { quote, decider, via: 'APP', challengeId: null });
    },
  };
}

export interface LinkDecisionInput {
  readonly token: string;
  readonly challengeId: string;
  readonly code: string;
  readonly idempotencyKey: string;
}

/**
 * `quote.accept_via_link` (D-01, FI-07). Three steps: rate limit per token → verify the code in its own committed
 * transaction (attempt accounting) → one command that re-verifies under the locks, consumes the challenge and accepts.
 * Viewing the link can never reach this path, and no session bypasses the code.
 */
export async function acceptQuoteViaLink(db: Db, deps: QuoteDeps, input: LinkDecisionInput): Promise<AcceptResult> {
  return decideViaLink(db, deps, input, 'ACCEPT') as Promise<AcceptResult>;
}

/** `quote.reject_via_link` (D-15): formal rejection also requires a consumed OTP challenge. */
export async function rejectQuoteViaLink(db: Db, deps: QuoteDeps, input: LinkDecisionInput): Promise<{ status: 'REJECTED' }> {
  return decideViaLink(db, deps, input, 'REJECT') as Promise<{ status: 'REJECTED' }>;
}

async function decideViaLink(db: Db, deps: QuoteDeps, input: LinkDecisionInput, purpose: 'ACCEPT' | 'REJECT'): Promise<AcceptResult | { status: 'REJECTED' }> {
  await hitDecisionRateLimit(db, deps, input.token);
  const link = await resolveLink(db, input.token);
  const verified = await verifyChallengeCode(db, deps, { link, challengeId: input.challengeId, code: input.code });
  const actorRef: ActorRef = { type: 'CLIENT_LINK', id: verified.userId, surface: 'PUBLIC' };
  const out = await executeCommand(db, {
    authorize: async () => {},
    handle: async (ctx) => {
      const quote = await loadDecidableQuote(ctx, link.quoteId);
      const decider = await requireQuoteDecider(ctx.tx, verified.userId, quote.client_id, { requireVerifiedEmail: true });
      const consumed = await consumeChallengeInCommand(ctx, deps, { challengeId: input.challengeId, quoteId: quote.id, linkId: link.linkId, code: input.code, purpose });
      if (consumed.clientUserId !== decider.clientUserId) throw new DomainError('OTP_INVALID', 'The code is invalid or has expired.');
      if (purpose === 'REJECT') return rejectCore(ctx, { quote, decider, via: 'LINK', challengeId: input.challengeId });
      await assertAcceptable(ctx, deps, quote);
      return acceptCore(ctx, deps, { quote, decider, via: 'LINK', challengeId: input.challengeId });
    },
  }, {
    name: purpose === 'ACCEPT' ? 'quote.accept_via_link' : 'quote.reject_via_link',
    actor: actorRef,
    payload: { linkHash: link.tokenHash, challengeId: input.challengeId, codeHash: deps.protector.lookupHash(input.code, `link_decision:${input.challengeId}`) },
    idempotencyKey: input.idempotencyKey,
    financial: purpose === 'ACCEPT',
  });
  return out.result;
}

/** Records a clean acceptance failure for the desk after the acceptance transaction rolled back (STATE_MACHINES §2). */
export async function recordAcceptanceFailure(db: Db, input: { quoteId: string; code: string; via: 'APP' | 'LINK' }): Promise<void> {
  await executeCommand(db, {
    authorize: async () => {},
    handle: async (ctx) => {
      await appendAudit(ctx, { action: 'quote.acceptance_failed', entityType: 'quote', entityId: input.quoteId, after: { code: input.code, via: input.via } });
      await enqueueOutbox(ctx, { type: 'desk.acceptance_failed', aggregateType: 'quote', aggregateId: input.quoteId, payload: { quoteId: input.quoteId, code: input.code } });
      await sql`select 1`.execute(ctx.tx);
    },
  }, { name: 'quote.acceptance_failed', actor: { type: 'SYSTEM', id: null, surface: 'SYSTEM' }, payload: input, financial: false });
}
