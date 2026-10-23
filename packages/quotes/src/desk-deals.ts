import { sql } from 'kysely';
import { DomainError, Money, Rate, requireText, requireUuid } from '@inrp2p/kernel';
import { type DirectionValue, type Executor, type FixedSideValue, type TraderSide, type TxContext, assertLockOrder } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import type { ClientActor, DomainCommand } from '@inrp2p/identity';
import { publishTraderRate } from '@inrp2p/pricing';
import {
  attachDeskClientInTx, closeUnstartedOrder, currentDeskPrices, currentFeePolicy, deskByHandle, deskById, deskClient, freeCapacity, lockBlock, lockTrader,
  priceDeskDeal, readBlocks, readOrder, readStanding, switchOnIssues, traderProgram,
} from '@inrp2p/trader-core';
import { assertProfitable, currentNetworkCosts, networkAvailable, priceNetworkP2p, recordQuoteNetworkFee, reservePerSendSun } from '@inrp2p/network';
import { lockRow } from './actors.ts';
import { type QuoteDeps, policyOf } from './policy.ts';
import { type CreateRequestPayload, cancelSentQuoteOfRequest, closeRequest, openRequestInTx } from './requests.ts';
import { businessNow } from './security.ts';

/**
 * A deal a desk fills with its own liquidity (docs/adr/0020-desks.md, FI-99): the firm quote its client accepts. No
 * person at INRP2P prices it. The desk committed to it in advance — by its live price (a client asking on the desk's
 * page) or by the rate it put on a deal link — so, in one step, its own order is opened and accepted at the client's rate
 * with the deal's capacity held, and the quote is created and sent:
 *
 * - the rupees are one amount, straight between the client and the desk (ADR 0019 P2P); the desk's USDT differs from the
 *   client's only by the platform's fee, the policy's basis points of the client's USDT, rounded up (`priceDeskDeal`);
 * - the desk must be in standing (approved, its Security Reserve funded, its registered bank account and wallet active —
 *   the same standing a trader switches on with, TD-38), within the limits INRP2P set on it, and its network deposit must
 *   cover the deal's transfers (migration 0040);
 * - the capacity it holds is held only as long as the quote can be accepted, and a minute more;
 * - the database re-checks the desk, its client, the route and the fee (IX123–IX125), a link's rate (IX126), and that the
 *   order and the quote price the same amounts (IX075).
 *
 * The client then accepts it like any quote (`quote.accept`): acceptance opens the trade and starts the order.
 */
export interface DeskDealInput {
  readonly requestId: string;
  /** The rate of a deal link; null prices the deal on the desk's live price for the request's direction. */
  readonly clientRateMicro: bigint | null;
  readonly validitySeconds: number;
  /** The desk's person whose commitment this is: who set the live price, or who made the deal link. */
  readonly committedBy: string;
}

export interface DeskDealQuote {
  readonly quoteId: string;
  readonly ref: string;
  readonly requestId: string;
  readonly orderId: string;
  readonly orderRef: string;
  readonly direction: DirectionValue;
  readonly clientRate: string;
  readonly base: string;
  readonly clientInr: string;
  /** The desk's USDT: what it receives (client sells) or delivers (client buys). */
  readonly deskBase: string;
  readonly platformFee: string;
  readonly expiresAt: string;
}

/** How long a desk's instant price can be accepted: long enough to read and tap, short enough to hold nothing idle. */
export const DESK_INSTANT_QUOTE_SECONDS = 60;
/** The desk's capacity outlives its quote by this much, then the trader sweep gives it back. */
const HOLD_GRACE_SECONDS = 60;

const sideFor = (direction: DirectionValue): TraderSide => (direction === 'SELL_USDT' ? 'BUY_USDT' : 'SELL_USDT');
const usdt = (m: bigint) => Money.ofMinor(m, 'USDT').toDecimalString();

/** `quoteDeskDealInTx` with the request locked first (ARCHITECTURE §4). */
export async function quoteDeskDealInTx(ctx: TxContext, deps: Pick<QuoteDeps, 'policy'>, input: DeskDealInput): Promise<DeskDealQuote> {
  await lockRow(ctx.tx, 'trade_request', 'trade_request', requireUuid(input.requestId, 'requestId'));
  return quoteLockedDeskDealInTx(ctx, deps, input, []);
}

/**
 * The deal itself, for a caller that already holds the request lock (and the locks of the requests it supersedes, whose
 * sent quotes it has cancelled): the superseded requests' orders give their capacity back and the requests close as
 * withdrawn in the same transaction, before the new order holds any.
 */
export async function quoteLockedDeskDealInTx(ctx: TxContext, deps: Pick<QuoteDeps, 'policy'>, input: DeskDealInput, supersede: readonly string[] = []): Promise<DeskDealQuote> {
  const policy = policyOf(deps);
  const validity = input.validitySeconds;
  if (!Number.isInteger(validity) || validity < policy.minValiditySeconds || validity > policy.maxValiditySeconds) {
    throw new DomainError('QUOTE_VALIDITY_INVALID', `validity must be a whole number of seconds between ${policy.minValiditySeconds} and ${policy.maxValiditySeconds}`);
  }
  const committedBy = requireUuid(input.committedBy, 'committedBy');
  const request = await ctx.tx.selectFrom('trade_request').selectAll().where('id', '=', requireUuid(input.requestId, 'requestId')).executeTakeFirstOrThrow();
  if (!request.desk_id) throw new DomainError('INVALID_ARGUMENT', `request ${request.ref} was not placed with a desk`);
  if (request.status !== 'OPEN') throw new DomainError('REQUEST_NOT_OPEN', `request is ${request.status}`);
  const client = await ctx.tx.selectFrom('client').select('status').where('id', '=', request.client_id).executeTakeFirstOrThrow();
  if (client.status !== 'ACTIVE') throw new DomainError('CLIENT_NOT_ACTIVE', 'client is suspended');
  const desk = await deskById(ctx.tx, request.desk_id);
  if (!desk || desk.status !== 'LIVE') throw new DomainError('DESK_NOT_LIVE', 'this desk is not taking deals right now');
  const relation = await deskClient(ctx.tx, desk.id, request.client_id);
  if (!relation || relation.status !== 'ACTIVE') throw new DomainError('DESK_CLIENT_BLOCKED', 'this desk is not dealing with this client');

  // The desk's standing is a trader's (TD-38): what switching on needs. The client is told only that it cannot deal now.
  const trader = await lockTrader(ctx, desk.traderId);
  const { standing } = await readStanding(ctx.tx, trader.id);
  if (switchOnIssues(standing).length > 0) throw new DomainError('DESK_NOT_LIVE', 'this desk is not taking deals right now');
  const side = sideFor(request.direction);
  const facts = (await readBlocks(ctx.tx, trader.id)).find((b) => b.side === side);
  if (!facts) throw new DomainError('INVALID_ARGUMENT', request.direction === 'SELL_USDT' ? 'this desk does not buy USDT' : 'this desk does not sell USDT');
  const route = await ctx.tx.selectFrom('liquidity_route').select(['execution_mode']).where('id', '=', facts.routeId).executeTakeFirstOrThrow();
  if (route.execution_mode !== 'P2P') throw new DomainError('INVALID_ARGUMENT', 'a desk deals P2P: its rupees go straight to and from its client');

  // The desk's rate: the deal link's, or its live price — with that price's limits.
  let rateMicro = input.clientRateMicro;
  let limits: { min: bigint; max: bigint } | null = null;
  if (rateMicro === null) {
    const price = (await currentDeskPrices(ctx.tx, desk.id))[request.direction];
    if (!price || !price.offered) throw new DomainError('DESK_NOT_LIVE', 'this desk has no live price for this right now');
    rateMicro = price.rateMicro;
    limits = { min: price.minBaseMinor, max: price.maxBaseMinor };
  }
  if (rateMicro <= 0n) throw new DomainError('INVALID_RATE', 'the rate must be positive');
  const clientRate = Rate.ofMicro(rateMicro, 'CLIENT');
  const fees = await currentFeePolicy(ctx.tx);
  const requested = (request.fixed_side === 'BASE' ? request.requested_base_minor : request.requested_quote_minor)!;
  const econ = priceDeskDeal({ direction: request.direction, fixedSide: request.fixed_side, amountMinor: requested, clientRate, policy: fees });
  if (limits && (econ.base.minor < limits.min || econ.base.minor > limits.max)) {
    throw new DomainError('INVALID_AMOUNT', `this desk deals ${usdt(limits.min)} to ${usdt(limits.max)} USDT at its live price`, { min: usdt(limits.min), max: usdt(limits.max) });
  }
  if (relation.maxDealBaseMinor !== null && econ.base.minor > relation.maxDealBaseMinor) {
    throw new DomainError('INVALID_AMOUNT', `this desk deals up to ${usdt(relation.maxDealBaseMinor)} USDT with you`, { max: usdt(relation.maxDealBaseMinor) });
  }
  // INRP2P's own ceiling on this trader's single order binds its desk deals too; its capacity ceiling is in `freeCapacity`.
  const capacityMinor = side === 'BUY_USDT' ? econ.clientInr.minor : econ.routeBase.minor;
  if (facts.operatorMaxOrderMinor !== null && capacityMinor > facts.operatorMaxOrderMinor) {
    throw new DomainError('INVALID_AMOUNT', 'this deal is larger than this desk can take in one deal');
  }

  // Its transfers are the desk's to fund: it holds its transfer and a return of the escrow from its network deposit.
  const costs = await currentNetworkCosts(ctx.tx);
  const need = reservePerSendSun(costs.snapshot, costs.policy) * BigInt(1 + costs.policy.refundSendsSell);
  if ((await networkAvailable(ctx.tx, trader.id)) < need) throw new DomainError('NETWORK_BUDGET_INSUFFICIENT', "the desk's network deposit cannot cover this deal's transfers");

  // What the client asked before gives its capacity back first: a lapsed quote of this request, or the client's earlier
  // requests this one supersedes.
  assertLockOrder(ctx.tx, 'trader_order');
  const stale = await ctx.tx.selectFrom('trader_order').select(['id', 'status']).where('trade_request_id', 'in', [request.id, ...supersede]).where('status', 'in', ['OFFERED', 'ACCEPTED']).orderBy('id').forUpdate().execute();
  for (const s of stale) {
    const order = await readOrder(ctx, s.id);
    await closeUnstartedOrder(ctx, order, s.status === 'OFFERED' ? 'WITHDRAWN' : 'RELEASED', 'REQUEST_CLOSED', 'A new quote replaced it.');
  }
  for (const id of supersede) {
    const old = await ctx.tx.selectFrom('trade_request').select(['status', 'version']).where('id', '=', id).executeTakeFirstOrThrow();
    if (old.status !== 'OPEN' && old.status !== 'QUOTED') continue;
    await closeRequest(ctx.tx, id, 'WITHDRAWN', 'replaced by a new price', old.version);
    await appendAudit(ctx, { action: 'request.withdrawn', entityType: 'trade_request', entityId: id, before: { status: old.status }, after: { status: 'WITHDRAWN', reason: 'replaced by a new price', by: 'CLIENT' } });
  }

  // The quote can be accepted until `expiresAt`; the desk's capacity is held until a minute after that.
  const now = await businessNow(ctx.tx);
  const expiresAt = new Date(now.getTime() + validity * 1000);
  const holdUntil = new Date(expiresAt.getTime() + HOLD_GRACE_SECONDS * 1000);

  // The desk's own order: its USDT side at the client's rate, accepted at once on its standing commitment.
  const program = await traderProgram(ctx.tx);
  const order = await ctx.tx.insertInto('trader_order')
    .values({
      trader_id: trader.id, block_id: facts.id, route_id: facts.routeId, trade_request_id: request.id, side,
      base_minor: econ.routeBase.minor, inr_minor: econ.clientInr.minor, rate_micro: rateMicro, capacity_minor: capacityMinor,
      planned_client_rate_micro: rateMicro, offered_by: `DESK:${desk.handle}`,
      offer_expires_at: sql<Date>`inrp2p_now() + make_interval(secs => ${program.offerTtlSeconds})`,
    })
    .returning(['id', 'ref'])
    .executeTakeFirstOrThrow();
  const block = await lockBlock(ctx, facts.id);
  const offered = await ctx.tx.selectFrom('trader_order').select(({ fn }) => fn.sum<string>('capacity_minor').as('n'))
    .where('block_id', '=', block.id).where('status', '=', 'OFFERED').where('id', '<>', order.id).where('offer_expires_at', '>', sql<Date>`inrp2p_now()`).executeTakeFirst();
  const free = freeCapacity({ ...facts, capacityMinor: block.capacity_minor, reservedMinor: block.reserved_minor, offeredMinor: BigInt(offered?.n ?? '0') });
  if (capacityMinor > free) throw new DomainError('CAPACITY_INSUFFICIENT', 'this desk does not have that much available right now');
  await ctx.tx.updateTable('trader_block').set({ reserved_minor: block.reserved_minor + capacityMinor, updated_at: sql<Date>`inrp2p_now()`, version: block.version + 1 }).where('id', '=', block.id).execute();
  const snapshot = await publishTraderRate(ctx, { routeId: facts.routeId, direction: request.direction, rate: Rate.ofMicro(rateMicro, 'ROUTE') });
  await ctx.tx.updateTable('trader_order')
    .set({
      status: 'ACCEPTED', accepted_at: now, accepted_by: committedBy, route_rate_snapshot_id: snapshot.snapshotId, version: 2, hold_until: holdUntil,
    })
    .where('id', '=', order.id)
    .execute();

  const quote = await ctx.tx.insertInto('quote')
    .values({
      trade_request_id: request.id, client_id: request.client_id, direction: request.direction, fixed_side: request.fixed_side,
      base_minor: econ.base.minor, quote_inr_minor: econ.clientInr.minor, client_rate_micro: rateMicro, route_rate_micro: rateMicro,
      route_rate_snapshot_id: snapshot.snapshotId, route_id: facts.routeId, route_value_inr_minor: econ.routeInr.minor, gross_margin_inr_minor: 0n,
      route_base_minor: econ.routeBase.minor, gross_margin_base_minor: econ.grossMarginBase.minor,
      platform_fee_bps: fees.ownDealBps, platform_fee_base_minor: econ.platformFeeBase.minor,
      network: request.network, bank_account_id: request.bank_account_id, crypto_wallet_id: request.crypto_wallet_id,
      valid_for_seconds: validity, is_counter: false, negative_margin_reason: null, created_by: committedBy,
    })
    .returning(['id', 'ref'])
    .executeTakeFirstOrThrow();
  const network = await priceNetworkP2p(ctx.tx, { direction: request.direction, clientRateMicro: rateMicro, grossMarginBaseMinor: econ.grossMarginBase.minor, traderOrderId: order.id });
  assertProfitable(network);
  await recordQuoteNetworkFee(ctx, quote.id, network);

  await ctx.tx.updateTable('quote').set({ status: 'SENT', sent_at: now, expires_at: expiresAt, sent_by: committedBy }).where('id', '=', quote.id).execute();
  await ctx.tx.updateTable('trade_request').set({ status: 'QUOTED', last_activity_at: sql<Date>`inrp2p_now()`, version: request.version + 1 }).where('id', '=', request.id).execute();

  await appendAudit(ctx, {
    action: 'desk_deal.quoted', entityType: 'quote', entityId: quote.id,
    after: {
      ref: quote.ref, desk_id: desk.id, order_id: order.id, request_id: request.id, direction: request.direction, client_rate: clientRate,
      priced_on: limits ? 'LIVE_PRICE' : 'DEAL_RATE', superseded: supersede,
      base: econ.base, client_inr: econ.clientInr, desk_base: econ.routeBase, platform_fee: econ.platformFeeBase, fee_bps: fees.ownDealBps, network_funder: trader.id, expires_at: expiresAt,
    },
  });
  await enqueueOutbox(ctx, { type: 'quote.sent', aggregateType: 'quote', aggregateId: quote.id, payload: { quoteId: quote.id, expiresAt: expiresAt.toISOString(), clientId: request.client_id } });
  return {
    quoteId: quote.id, ref: quote.ref, requestId: request.id, orderId: order.id, orderRef: order.ref, direction: request.direction, clientRate: clientRate.toDecimalString(),
    base: econ.base.toDecimalString(), clientInr: econ.clientInr.toDecimalString(), deskBase: econ.routeBase.toDecimalString(),
    platformFee: econ.platformFeeBase.toDecimalString(), expiresAt: expiresAt.toISOString(),
  };
}

// ---- the client's side ---------------------------------------------------------------------------------------------

/** The client a signed-in client user acts for: its one active membership (D-17), never a client named in a payload. */
export async function clientOfMember(ex: Executor, userId: string): Promise<{ clientId: string; canAcceptQuotes: boolean }> {
  const row = await ex
    .selectFrom('client_user as cu')
    .innerJoin('auth_user as u', 'u.id', 'cu.user_id')
    .select(['cu.client_id', 'cu.can_accept_quotes', 'cu.status', 'u.status as user_status', 'u.kind'])
    .where('cu.user_id', '=', requireUuid(userId, 'userId'))
    .executeTakeFirst();
  if (!row || row.kind !== 'CLIENT' || row.status !== 'ACTIVE' || row.user_status !== 'ACTIVE') throw new DomainError('FORBIDDEN', 'this account is not linked to a client');
  return { clientId: row.client_id, canAcceptQuotes: row.can_accept_quotes };
}

/** A client command that acts for the signed-in user's own client. */
export function memberClientCommand<P, R>(actor: ClientActor, handle: (ctx: TxContext, payload: P, clientId: string) => Promise<R>): DomainCommand<P, R> {
  let clientId: string | undefined;
  return {
    authorize: async (ctx) => {
      if (ctx.actor.surface !== 'CLIENT') throw new DomainError('SESSION_SURFACE_MISMATCH');
      clientId = (await clientOfMember(ctx.tx, actor.userId)).clientId;
    },
    handle: async (ctx, payload) => {
      if (!clientId) throw new Error('client command executed without authorization');
      return handle(ctx, payload, clientId);
    },
  };
}

export interface DeskQuotePayload {
  /** The desk's page: inrp2p.com/<handle>. */
  readonly handle: string;
  readonly direction: DirectionValue;
  readonly fixedSide: FixedSideValue;
  readonly amount: string;
  /** Client sells: the client's own bank account the desk pays. */
  readonly bankAccountId?: string | null;
  /** Client buys: the client's own wallet the USDT goes to. */
  readonly walletId?: string | null;
  readonly sourceWalletId?: string | null;
}

/**
 * `desk_deal.request_quote` — a client on a desk's page asks for a price and gets a firm one at once, on the desk's live
 * price, valid for a minute (`DESK_INSTANT_QUOTE_SECONDS`). The client becomes the desk's client the first time (unless
 * the desk blocked it). A client holds one price per desk at a time: asking again — a new amount, the other direction —
 * replaces the earlier one and its capacity in the same step, so nobody can hold a desk's liquidity by asking repeatedly.
 * The client then accepts it with `quote.accept`.
 */
export function requestDeskQuote(actor: ClientActor, deps: QuoteDeps) {
  return memberClientCommand(actor, async (ctx, p: DeskQuotePayload, clientId): Promise<DeskDealQuote> => {
    const desk = await deskByHandle(ctx.tx, requireText(p.handle, 'handle', 30));
    if (!desk || desk.status !== 'LIVE') throw new DomainError('DESK_NOT_LIVE', 'this desk is not taking deals right now');
    const price = (await currentDeskPrices(ctx.tx, desk.id))[p.direction];
    if (!price || !price.offered) throw new DomainError('DESK_NOT_LIVE', 'this desk has no live price for this right now');
    const relation = await attachDeskClientInTx(ctx, { deskId: desk.id, clientId, source: 'PAGE' });
    if (relation.status !== 'ACTIVE') throw new DomainError('DESK_CLIENT_BLOCKED', 'this desk is not dealing with this client');

    // The client's earlier price at this desk is replaced, not added to (locks: every request, in id order, first).
    const previous = (await ctx.tx.selectFrom('trade_request').select('id').where('desk_id', '=', desk.id).where('client_id', '=', clientId)
      .where('status', 'in', ['OPEN', 'QUOTED']).where('desk_deal_link_id', 'is', null).execute()).map((r) => r.id);
    const payload: CreateRequestPayload = {
      clientId, direction: p.direction, fixedSide: p.fixedSide, amount: p.amount, deskId: desk.id,
      bankAccountId: p.bankAccountId ?? null, walletId: p.walletId ?? null, sourceWalletId: p.sourceWalletId ?? null,
    };
    const opened = await openRequestInTx(ctx, deps, { clientId, payload, channel: 'CLIENT_APP' });
    for (const id of [...previous, opened.requestId].sort()) await lockRow(ctx.tx, 'trade_request', 'trade_request', id);
    for (const id of previous) await cancelSentQuoteOfRequest(ctx, id, 'SUPERSEDED');
    return quoteLockedDeskDealInTx(ctx, deps, { requestId: opened.requestId, clientRateMicro: null, validitySeconds: DESK_INSTANT_QUOTE_SECONDS, committedBy: price.setBy }, previous);
  });
}
