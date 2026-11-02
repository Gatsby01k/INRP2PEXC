import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { DomainError, Money, Rate, railOptions, requireUuid } from '@inrp2p/kernel';
import { type Db, type DirectionValue, type Executor, type FixedSideValue, type TraderSide, type TxContext, assertLockOrder, lockInOrder } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox, type OutboxHandler } from '@inrp2p/outbox';
import { executeCommand } from '@inrp2p/commands';
import type { ClientActor } from '@inrp2p/identity';
import { assertNewBusinessOpen, newBusinessState } from '@inrp2p/trades';
import {
  type PricedOffer, type PricingChoice, type PricingPolicy, type ReferenceRateSnapshot, acceptanceEvidence, approximateBase, choosePrice, currentPricingPolicy, freshReference,
  publishTraderRate, recordMarketReference, sizeBand,
} from '@inrp2p/pricing';
import {
  type BlockRead, closeOrdersForRequests, completionPpm, effectiveMaxOrder, freeCapacity, lockBlock, readBlocks, readStanding, standingIssues, traderProgram, traderRecords,
} from '@inrp2p/trader-core';
import {
  type UsdtNetworkTerms, assertProfitable, currentNetworkCosts, networkAvailable, networkFeePolicy, priceNetworkP2p, pricingOfUsdtTerms, recordQuoteNetworkFee, reservePerSendSun,
  usdtNetworkTerms,
} from '@inrp2p/network';
import { lockRow } from './actors.ts';
import { memberClientCommand } from './desk-deals.ts';
import type { QuoteDeps } from './policy.ts';
import { type CreateRequestPayload, cancelSentQuoteOfRequest, closeRequest, openRequestInTx } from './requests.ts';
import { businessNow } from './security.ts';

/**
 * Automatic prices of the INRP2P exchange (docs/adr/0025-automatic-pricing.md): a client asks, and in the same step gets a
 * firm price — or, for an amount no firm offer covers, a price request goes to several traders — or, when nothing can be
 * priced honestly, the request waits for a person exactly as before.
 *
 * A firm price is, in one transaction: the chosen trader's order opened and accepted on its own firm offer (or its winning
 * bid), its capacity held until the quote can no longer be accepted and a minute more; the trader's rate published as the
 * route's snapshot; the quote at the chosen client price with its frozen network terms; the decision recorded beside it
 * (`auto_quote`, IX137); the quote sent for `AUTO_QUOTE_SECONDS`. The client then accepts it like any quote (`quote.accept`),
 * which opens the trade and starts the order — nothing about the price, the trader or the economics changes after that.
 *
 * Nobody holds capacity twice: every trader a price could go to is locked before any order is touched (lock order:
 * request → quote → traders → orders → blocks), so routing, a trader's own edits and other prices wait their turn; the
 * capacity is checked again under the block's lock before it is held.
 */

/** How long an automatic price can be accepted. */
export const AUTO_QUOTE_SECONDS = 60;
/** The trader's capacity outlives the quote by this much, then the trader sweep gives it back. */
const HOLD_GRACE_SECONDS = 60;
/** The acting system, as it is written into orders, quotes and audit events. */
const SYSTEM_PRICER = 'SYSTEM:auto_price';

/** Why a request was left for a person rather than priced automatically. */
export type ManualReason = 'OFF' | 'NOT_P2P' | 'NO_MARKET' | 'NETWORK_UNKNOWN' | 'NO_OFFER' | 'NOT_COMPETITIVE';

export type AutoOutcome =
  | { readonly kind: 'QUOTED'; readonly quoteId: string; readonly ref: string; readonly clientRate: string; readonly base: string; readonly clientInr: string; readonly expiresAt: string }
  | { readonly kind: 'RFQ'; readonly rfqRef: string; readonly closesAt: string }
  | { readonly kind: 'MANUAL'; readonly reason: ManualReason };

const sideFor = (direction: DirectionValue): TraderSide => (direction === 'SELL_USDT' ? 'BUY_USDT' : 'SELL_USDT');

interface RequestRow {
  readonly id: string;
  readonly ref: string;
  readonly client_id: string;
  readonly direction: DirectionValue;
  readonly fixed_side: FixedSideValue;
  readonly requested_base_minor: bigint | null;
  readonly requested_quote_minor: bigint | null;
  readonly bank_account_id: string | null;
  readonly crypto_wallet_id: string | null;
  readonly network: 'TRON';
  readonly status: string;
  readonly desk_id: string | null;
  readonly version: number;
}

async function readRequest(ctx: TxContext, requestId: string): Promise<RequestRow> {
  const r = await ctx.tx.selectFrom('trade_request')
    .select(['id', 'ref', 'client_id', 'direction', 'fixed_side', 'requested_base_minor', 'requested_quote_minor', 'bank_account_id', 'crypto_wallet_id', 'network', 'status', 'desk_id', 'version'])
    .where('id', '=', requireUuid(requestId, 'requestId'))
    .executeTakeFirst();
  if (!r) throw new DomainError('NOT_FOUND', 'request not found');
  return r;
}

const requestedOf = (r: RequestRow): bigint => (r.fixed_side === 'BASE' ? r.requested_base_minor : r.requested_quote_minor)!;

/** How the deal's network is paid — on GasFree out of INRP2P's margin, in TRX from its trader's network deposit (ADR 0022). */
type NetworkMode = { readonly mode: 'GASFREE'; readonly terms: UsdtNetworkTerms } | { readonly mode: 'BURN'; readonly needSun: bigint; readonly minNetMarginInrMinor: bigint };

async function networkMode(ctx: TxContext): Promise<NetworkMode | null> {
  try {
    if ((await networkFeePolicy(ctx.tx)).resourceMode === 'GASFREE') return { mode: 'GASFREE', terms: await usdtNetworkTerms(ctx.tx, { funderTraderId: null }) };
    const costs = await currentNetworkCosts(ctx.tx);
    return { mode: 'BURN', needSun: reservePerSendSun(costs.snapshot, costs.policy) * BigInt(1 + costs.policy.refundSendsSell), minNetMarginInrMinor: costs.policy.minNetMarginInrMinor };
  } catch (e) {
    if (e instanceof DomainError && (e.code === 'NETWORK_FEES_UNKNOWN' || e.code === 'NOT_FOUND')) return null;
    throw e;
  }
}

/** A trader a price could go to, read in the caller's transaction (under the trader's lock when it is about to act on it). */
interface Candidate {
  readonly traderId: string;
  readonly ref: string;
  readonly block: BlockRead;
}

/**
 * Traders in standing whose side fills this request on a P2P route, pay or are paid by a rail this amount can travel on,
 * and — when their deposit pays the network in TRX — can cover the deal's transfers. Whether their offer is firm, and
 * whether it takes this amount, is the pricing's to decide.
 */
async function candidates(ctx: TxContext, request: RequestRow, network: NetworkMode, reference: ReferenceRateSnapshot): Promise<Candidate[]> {
  const side = sideFor(request.direction);
  const approxInr = request.fixed_side === 'QUOTE' ? requestedOf(request) : (requestedOf(request) * reference.rate.micro) / 10_000_000_000n;
  const possibleRails = new Set(railOptions(approxInr > 0n ? approxInr : 1n).filter((o) => o.possible).map((o) => o.rail));
  const traders = await ctx.tx.selectFrom('trader_profile').select(['id', 'ref', 'client_id']).where('status', 'in', ['APPROVED', 'PAUSED']).orderBy('ref').execute();
  const out: Candidate[] = [];
  for (const t of traders) {
    if (t.client_id === request.client_id) continue;
    const { standing } = await readStanding(ctx.tx, t.id);
    if (standingIssues(standing).length > 0) continue;
    const block = (await readBlocks(ctx.tx, t.id)).find((b) => b.side === side);
    if (!block || block.status !== 'ACTIVE') continue;
    const route = await ctx.tx.selectFrom('liquidity_route').select(['execution_mode', 'status']).where('id', '=', block.routeId).executeTakeFirstOrThrow();
    if (route.execution_mode !== 'P2P' || route.status !== 'ACTIVE') continue;
    if (!block.rails.some((r) => possibleRails.has(r))) continue;
    if (network.mode === 'BURN' && (await networkAvailable(ctx.tx, t.id)) < network.needSun) continue;
    out.push({ traderId: t.id, ref: t.ref, block });
  }
  return out;
}

async function completionOf(ctx: TxContext, policy: PricingPolicy): Promise<(traderId: string) => bigint> {
  const records = await traderRecords(ctx.tx, { sinceDays: policy.learningDays });
  return (traderId) => completionPpm(records.byTrader.get(traderId), records.network);
}

interface PriceContext {
  readonly request: RequestRow;
  readonly policy: PricingPolicy;
  readonly reference: ReferenceRateSnapshot;
  readonly network: NetworkMode;
}

/** The kernel's pricing over a set of offers, with this request's evidence of acceptance. */
async function price(ctx: TxContext, pc: PriceContext, offers: readonly PricedOffer[]) {
  const amount = requestedOf(pc.request);
  const band = sizeBand(approximateBase(pc.request.fixed_side, amount, pc.reference.rate.micro));
  const evidence = await acceptanceEvidence(ctx.tx, { direction: pc.request.direction, sizeBand: band, binBps: pc.policy.binBps, learningDays: pc.policy.learningDays });
  return choosePrice({
    direction: pc.request.direction, fixedSide: pc.request.fixed_side, amountMinor: amount, offers, referenceMicro: pc.reference.rate.micro,
    maxPremiumBps: pc.policy.maxPremiumBps, binBps: pc.policy.binBps,
    networkAllowanceMinor: pc.network.mode === 'GASFREE' ? pc.network.terms.allowanceUsdtMinor : 0n,
    minNetMarginInrMinor: pc.network.mode === 'GASFREE' ? pc.network.terms.minNetMarginInrMinor : pc.network.minNetMarginInrMinor,
    evidence,
  });
}

interface Placement {
  readonly pc: PriceContext;
  readonly choice: PricingChoice;
  readonly traderId: string;
  readonly blockId: string;
  readonly routeId: string;
  /** The trader's person whose commitment this is: who made the offer firm, or who placed the winning bid. */
  readonly committedBy: string;
  readonly offeredBy: string;
  readonly source: 'INSTANT' | 'RFQ';
  readonly rfqId: string | null;
}

/**
 * The firm price itself, for a caller that holds the request's lock and the lock of the chosen trader (and of every trader
 * it weighed). The trader's capacity is checked once more under its block's lock; an offer that stopped being firm, or a
 * rate that moved, is refused rather than priced on.
 */
async function placeQuote(ctx: TxContext, p: Placement): Promise<Extract<AutoOutcome, { kind: 'QUOTED' }>> {
  const { pc, choice } = p;
  const { request } = pc;
  const side = sideFor(request.direction);
  const now = await businessNow(ctx.tx);
  const expiresAt = new Date(now.getTime() + AUTO_QUOTE_SECONDS * 1000);
  const holdUntil = new Date(expiresAt.getTime() + HOLD_GRACE_SECONDS * 1000);
  const program = await traderProgram(ctx.tx);
  const rateMicro = choice.offer.rateMicro;
  const econ = choice.econ;

  // A new order locks nothing that exists; its block is locked next, after any order this transaction closed.
  const order = await ctx.tx.insertInto('trader_order')
    .values({
      trader_id: p.traderId, block_id: p.blockId, route_id: p.routeId, trade_request_id: request.id, side,
      base_minor: econ.routeBase.minor, inr_minor: econ.clientInr.minor, rate_micro: rateMicro, capacity_minor: choice.capacityMinor,
      planned_client_rate_micro: choice.clientRateMicro, offered_by: p.offeredBy,
      offer_expires_at: sql<Date>`inrp2p_now() + make_interval(secs => ${program.offerTtlSeconds})`,
    })
    .returning(['id', 'ref'])
    .executeTakeFirstOrThrow();
  const facts = (await readBlocks(ctx.tx, p.traderId)).find((b) => b.id === p.blockId)!;
  const block = await lockBlock(ctx, p.blockId);
  if (block.status !== 'ACTIVE') throw new DomainError('TRADER_NOT_ELIGIBLE', 'the chosen side stopped taking orders');
  if (p.source === 'INSTANT' && (block.rate_micro !== rateMicro || !block.instant_until || block.instant_until <= now)) {
    throw new DomainError('TRADER_ORDER_NOT_LIVE', 'the chosen firm offer changed while it was being priced');
  }
  const offered = await ctx.tx.selectFrom('trader_order').select(({ fn }) => fn.sum<string>('capacity_minor').as('n'))
    .where('block_id', '=', block.id).where('status', '=', 'OFFERED').where('id', '<>', order.id).where('offer_expires_at', '>', sql<Date>`inrp2p_now()`).executeTakeFirst();
  const free = freeCapacity({ ...facts, capacityMinor: block.capacity_minor, reservedMinor: block.reserved_minor, offeredMinor: BigInt(offered?.n ?? '0') });
  if (choice.capacityMinor > free) throw new DomainError('CAPACITY_INSUFFICIENT', 'the chosen trader no longer has that much available');
  await ctx.tx.updateTable('trader_block').set({ reserved_minor: block.reserved_minor + choice.capacityMinor, updated_at: sql<Date>`inrp2p_now()`, version: block.version + 1 }).where('id', '=', block.id).execute();
  const snapshot = await publishTraderRate(ctx, { routeId: p.routeId, direction: request.direction, rate: Rate.ofMicro(rateMicro, 'ROUTE') });
  await ctx.tx.updateTable('trader_order')
    .set({ status: 'ACCEPTED', accepted_at: now, accepted_by: p.committedBy, route_rate_snapshot_id: snapshot.snapshotId, hold_until: holdUntil, version: 2 })
    .where('id', '=', order.id)
    .execute();

  const allowance = pc.network.mode === 'GASFREE' ? pc.network.terms.allowanceUsdtMinor : null;
  const quote = await ctx.tx.insertInto('quote')
    .values({
      trade_request_id: request.id, client_id: request.client_id, direction: request.direction, fixed_side: request.fixed_side,
      base_minor: econ.base.minor, quote_inr_minor: econ.clientInr.minor, client_rate_micro: choice.clientRateMicro, route_rate_micro: rateMicro,
      route_rate_snapshot_id: snapshot.snapshotId, route_id: p.routeId, route_value_inr_minor: econ.routeInr.minor, gross_margin_inr_minor: econ.grossMargin.minor,
      route_base_minor: econ.routeBase.minor, gross_margin_base_minor: econ.grossMarginBase.minor, network_fee_base_minor: allowance,
      network: request.network, bank_account_id: request.bank_account_id, crypto_wallet_id: request.crypto_wallet_id,
      valid_for_seconds: AUTO_QUOTE_SECONDS, is_counter: false, negative_margin_reason: null, created_by: SYSTEM_PRICER,
    })
    .returning(['id', 'ref'])
    .executeTakeFirstOrThrow();
  const terms = { direction: request.direction, clientRateMicro: choice.clientRateMicro, grossMarginBaseMinor: econ.grossMarginBase.minor, traderOrderId: order.id };
  const network = pc.network.mode === 'GASFREE' ? pricingOfUsdtTerms(pc.network.terms, terms) : await priceNetworkP2p(ctx.tx, terms);
  assertProfitable(network);
  if (network.p2p!.netMarginUsdtMinor !== choice.netMarginMinor || network.p2p!.minNetMarginUsdtMinor !== choice.minNetMarginMinor) {
    throw new DomainError('INVALID_ARGUMENT', 'the network terms disagree with the price chosen');
  }
  await recordQuoteNetworkFee(ctx, quote.id, network);
  await ctx.tx.insertInto('auto_quote')
    .values({
      quote_id: quote.id, trade_request_id: request.id, trader_order_id: order.id, policy_id: pc.policy.id, source: p.source, rfq_id: p.rfqId,
      direction: request.direction, size_band: sizeBand(econ.base.minor), reference_snapshot_id: pc.reference.id, reference_rate_micro: pc.reference.rate.micro,
      position_bps: choice.positionBps, cap_rate_micro: choice.capRateMicro, offers: choice.viableOffers,
      completion_ppm: Number.parseInt(choice.offer.completionPpm.toString(), 10), acceptance_ppm: Number.parseInt(choice.acceptancePpm.toString(), 10),
      net_margin_usdt_minor: choice.netMarginMinor, min_net_margin_usdt_minor: choice.minNetMarginMinor,
    })
    .execute();

  await ctx.tx.updateTable('quote').set({ status: 'SENT', sent_at: now, expires_at: expiresAt, sent_by: SYSTEM_PRICER }).where('id', '=', quote.id).execute();
  const current = await ctx.tx.selectFrom('trade_request').select('version').where('id', '=', request.id).executeTakeFirstOrThrow();
  await ctx.tx.updateTable('trade_request').set({ status: 'QUOTED', last_activity_at: sql<Date>`inrp2p_now()`, version: current.version + 1 }).where('id', '=', request.id).execute();

  await appendAudit(ctx, {
    action: 'quote.auto_priced', entityType: 'quote', entityId: quote.id,
    after: {
      ref: quote.ref, request_id: request.id, source: p.source, rfq_id: p.rfqId, order_id: order.id, trader_id: p.traderId, direction: request.direction,
      client_rate: Rate.ofMicro(choice.clientRateMicro, 'CLIENT'), trader_rate: Rate.ofMicro(rateMicro, 'ROUTE'), base: econ.base, client_inr: econ.clientInr,
      trader_base: econ.routeBase, gross_margin_usdt: econ.grossMarginBase, network_usdt: allowance === null ? null : Money.ofMinor(allowance, 'USDT'),
      net_margin_usdt: Money.ofMinor(choice.netMarginMinor, 'USDT'), min_net_margin_usdt: Money.ofMinor(choice.minNetMarginMinor, 'USDT'),
      reference: { snapshot_id: pc.reference.id, rate: pc.reference.rate, age_seconds: pc.reference.ageSeconds }, cap_rate: Rate.ofMicro(choice.capRateMicro, 'CLIENT'),
      position_bps: choice.positionBps, acceptance_ppm: choice.acceptancePpm.toString(), completion_ppm: choice.offer.completionPpm.toString(),
      expected_net_usdt: Money.ofMinor(choice.expectedNetMinor, 'USDT'), offers: choice.viableOffers, policy_id: pc.policy.id, expires_at: expiresAt,
    },
  });
  await enqueueOutbox(ctx, { type: 'quote.sent', aggregateType: 'quote', aggregateId: quote.id, payload: { quoteId: quote.id, expiresAt: expiresAt.toISOString(), clientId: request.client_id } });
  return {
    kind: 'QUOTED', quoteId: quote.id, ref: quote.ref, clientRate: Rate.ofMicro(choice.clientRateMicro, 'CLIENT').toDecimalString(),
    base: econ.base.toDecimalString(), clientInr: econ.clientInr.toDecimalString(), expiresAt: expiresAt.toISOString(),
  };
}

/** The firm offer a candidate stands behind for this request, if any: its rate within its own limits and what it has free. */
function firmOffer(c: Candidate, completion: bigint): PricedOffer | null {
  const b = c.block;
  if (!b.firm || !b.instantSetBy || b.rateMicro === null || b.minOrderMinor === null || b.maxOrderMinor === null) return null;
  return { id: c.traderId, ref: c.ref, rateMicro: b.rateMicro, minMinor: b.minOrderMinor, maxMinor: effectiveMaxOrder(b), freeMinor: freeCapacity(b), completionPpm: completion };
}

/**
 * Prices a request automatically, for a caller that holds the request's lock and those of the requests it replaces (whose
 * sent quotes it cancelled): their orders give their capacity back and they close as withdrawn, whatever the outcome.
 */
export async function autoPriceLockedInTx(ctx: TxContext, input: { requestId: string; supersede?: readonly string[] }): Promise<AutoOutcome> {
  const supersede = input.supersede ?? [];
  const request = await readRequest(ctx, input.requestId);
  if (request.desk_id) throw new DomainError('INVALID_ARGUMENT', `request ${request.ref} was placed with a desk: that desk prices it`);
  if (request.status !== 'OPEN') throw new DomainError('REQUEST_NOT_OPEN', `request is ${request.status}`);

  // Whether anything can be priced is settled before any trader is locked.
  const policy = await currentPricingPolicy(ctx.tx);
  let manual: ManualReason | null = null;
  let reference: ReferenceRateSnapshot | null = null;
  let network: NetworkMode | null = null;
  if (!policy.autoQuote) manual = 'OFF';
  else if ((await traderProgram(ctx.tx)).executionMode !== 'P2P') manual = 'NOT_P2P';
  else if (!(reference = await freshReference(ctx.tx, request.direction, policy))) manual = 'NO_MARKET';
  else if (!(network = await networkMode(ctx))) manual = 'NETWORK_UNKNOWN';
  const peek = manual ? [] : await candidates(ctx, request, network!, reference!);

  // Every trader whose order closes here, and every trader the price may go to, locked at once, before any order.
  const stale = await ctx.tx.selectFrom('trader_order').select('trader_id').where('trade_request_id', 'in', [request.id, ...supersede]).where('status', 'in', ['OFFERED', 'ACCEPTED']).execute();
  await lockInOrder(ctx.tx, 'trader_profile', 'trader_profile', [...stale.map((s) => s.trader_id), ...peek.map((c) => c.traderId)]);
  await closeOrdersForRequests(ctx, [request.id, ...supersede]);
  for (const id of supersede) {
    const old = await ctx.tx.selectFrom('trade_request').select(['status', 'version']).where('id', '=', id).executeTakeFirstOrThrow();
    if (old.status !== 'OPEN' && old.status !== 'QUOTED') continue;
    await closeRequest(ctx.tx, id, 'WITHDRAWN', 'replaced by a new price', old.version);
    await appendAudit(ctx, { action: 'request.withdrawn', entityType: 'trade_request', entityId: id, before: { status: old.status }, after: { status: 'WITHDRAWN', reason: 'replaced by a new price', by: 'CLIENT' } });
  }
  if (manual) return leaveForDesk(ctx, request, manual);

  // Under the locks, the candidates as they are now.
  const pc: PriceContext = { request, policy, reference: reference!, network: network! };
  const locked = await candidates(ctx, request, network!, reference!);
  const completion = await completionOf(ctx, policy);
  const offers = locked.map((c) => firmOffer(c, completion(c.traderId))).filter((o): o is PricedOffer => o !== null);
  const outcome = await price(ctx, pc, offers);
  if (outcome.kind === 'PRICED') {
    const chosen = locked.find((c) => c.traderId === outcome.choice.offer.id)!;
    return placeQuote(ctx, {
      pc, choice: outcome.choice, traderId: chosen.traderId, blockId: chosen.block.id, routeId: chosen.block.routeId,
      committedBy: chosen.block.instantSetBy!, offeredBy: SYSTEM_PRICER, source: 'INSTANT', rfqId: null,
    });
  }
  // Nobody's firm offer takes this amount: when price requests are on, the traders who could are asked.
  if (outcome.reason === 'NO_OFFER' && policy.rfq) {
    const opened = await openRfqInTx(ctx, pc, locked.map((c) => ({ ...c, completionPpm: completion(c.traderId) })));
    if (opened) return opened;
  }
  return leaveForDesk(ctx, request, outcome.reason);
}

/** Nothing could be priced honestly: the request stays open for a person, and the record says why. */
async function leaveForDesk(ctx: TxContext, request: RequestRow, reason: ManualReason): Promise<AutoOutcome> {
  if (reason !== 'OFF') {
    await appendAudit(ctx, { action: 'quote.auto_price_skipped', entityType: 'trade_request', entityId: request.id, after: { ref: request.ref, reason } });
  }
  return { kind: 'MANUAL', reason };
}

// ---- price requests to several traders --------------------------------------------------------------------------------

/**
 * Puts the request to the traders who could fill it if they chose to — in standing, their side active, the amount within
 * INRP2P's ceilings on them — the likeliest to complete first, at most the policy's number. Each is told the side, the
 * amount and the time it closes; never who asks. Null when nobody qualifies.
 */
async function openRfqInTx(ctx: TxContext, pc: PriceContext, traders: readonly (Candidate & { completionPpm: bigint })[]): Promise<Extract<AutoOutcome, { kind: 'RFQ' }> | null> {
  const { request, policy, reference } = pc;
  const amount = requestedOf(request);
  const sell = request.direction === 'SELL_USDT';
  // What the trader's capacity would hold, at the market reference: its rupees when it buys USDT, its USDT when it sells.
  const approx = request.fixed_side === 'QUOTE'
    ? (sell ? amount : (amount * 10_000_000_000n) / reference.rate.micro)
    : (sell ? (amount * reference.rate.micro) / 10_000_000_000n : amount);
  const invitees = traders
    .filter((t) => t.block.operatorMaxOrderMinor === null || approx <= t.block.operatorMaxOrderMinor)
    .filter((t) => t.block.operatorMaxCapacityMinor === null || approx <= t.block.operatorMaxCapacityMinor)
    .sort((a, b) => (a.completionPpm !== b.completionPpm ? (b.completionPpm > a.completionPpm ? 1 : -1) : a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
    .slice(0, policy.rfqMaxTraders);
  if (invitees.length === 0) return null;
  const now = await businessNow(ctx.tx);
  const closesAt = new Date(now.getTime() + policy.rfqWindowSeconds * 1000);
  const rfq = await ctx.tx.insertInto('rfq')
    .values({ trade_request_id: request.id, policy_id: policy.id, direction: request.direction, closes_at: closesAt })
    .returning(['id', 'ref'])
    .executeTakeFirstOrThrow();
  await ctx.tx.insertInto('rfq_invite').values(invitees.map((t) => ({ rfq_id: rfq.id, trader_id: t.traderId, block_id: t.block.id }))).execute();
  await ctx.tx.updateTable('trade_request').set({ last_activity_at: sql<Date>`inrp2p_now()` }).where('id', '=', request.id).execute();
  await appendAudit(ctx, {
    action: 'rfq.opened', entityType: 'rfq', entityId: rfq.id,
    after: { ref: rfq.ref, request_id: request.id, direction: request.direction, invited: invitees.map((t) => t.traderId), closes_at: closesAt, policy_id: policy.id },
  });
  for (const t of invitees) {
    await enqueueOutbox(ctx, { type: 'trader.rfq_opened', aggregateType: 'rfq', aggregateId: rfq.id, payload: { rfqId: rfq.id, traderId: t.traderId } });
  }
  return { kind: 'RFQ', rfqRef: rfq.ref, closesAt: closesAt.toISOString() };
}

export type AwardResult = 'NOT_DUE' | 'AWARDED' | 'NO_PRICE' | 'CANCELLED' | 'CLOSED';

/**
 * Closes a price request once it is due — its time is up, or every trader asked has bid — and awards it to the bid with the
 * highest expected net margin, priced exactly as a firm offer would be (the bid's rate, INRP2P's ceilings and the trader's
 * free capacity; the market bound and the minimum net margin). The winner's order is opened and accepted on its bid and the
 * client gets a firm price for `AUTO_QUOTE_SECONDS`; the others are told they lost. With no bid that prices honestly the
 * request goes to a person; with the request gone or taken by a person, the price request is cancelled.
 */
export async function awardRfqInTx(ctx: TxContext, rfqId: string): Promise<AwardResult> {
  const head = await ctx.tx.selectFrom('rfq').select(['trade_request_id']).where('id', '=', requireUuid(rfqId, 'rfqId')).executeTakeFirst();
  if (!head) throw new DomainError('NOT_FOUND', 'price request not found');
  await lockRow(ctx.tx, 'trade_request', 'trade_request', head.trade_request_id);
  assertLockOrder(ctx.tx, 'rfq');
  const rfq = await ctx.tx.selectFrom('rfq').selectAll().where('id', '=', rfqId).forUpdate().executeTakeFirstOrThrow();
  if (rfq.status !== 'OPEN') return 'CLOSED';
  const request = await readRequest(ctx, rfq.trade_request_id);
  const liveOrder = await ctx.tx.selectFrom('trader_order').select('id').where('trade_request_id', '=', request.id).where('status', 'in', ['OFFERED', 'ACCEPTED']).executeTakeFirst();
  if (request.status !== 'OPEN' || liveOrder) {
    await closeRfq(ctx, rfq.id, 'CANCELLED', request.status !== 'OPEN' ? 'the request is no longer open' : 'a person is pricing the request', null);
    return 'CANCELLED';
  }
  const now = await businessNow(ctx.tx);
  const bids = await ctx.tx.selectFrom('rfq_bid').selectAll().where('rfq_id', '=', rfq.id).where('status', '=', 'LIVE').orderBy('trader_id').execute();
  const invited = await ctx.tx.selectFrom('rfq_invite').select(['trader_id', 'block_id']).where('rfq_id', '=', rfq.id).execute();
  if (now < rfq.closes_at && bids.length < invited.length) return 'NOT_DUE';
  if ((await newBusinessState(ctx.tx)).paused) return 'NOT_DUE';

  const policy = await currentPricingPolicy(ctx.tx);
  const reference = await freshReference(ctx.tx, request.direction, policy);
  const network = reference ? await networkMode(ctx) : null;
  if (!reference || !network || bids.length === 0) return noPrice(ctx, rfq.id, request, bids.length === 0 ? 'no trader bid' : 'nothing to bound the price by');

  await lockInOrder(ctx.tx, 'trader_profile', 'trader_profile', bids.map((b) => b.trader_id));
  const pc: PriceContext = { request, policy, reference, network };
  const able = new Map((await candidates(ctx, request, network, reference)).map((c) => [c.traderId, c]));
  const completion = await completionOf(ctx, policy);
  const offers: PricedOffer[] = [];
  for (const bid of bids) {
    const c = able.get(bid.trader_id);
    const blockId = invited.find((i) => i.trader_id === bid.trader_id)?.block_id;
    if (!c || c.block.id !== blockId) continue;
    offers.push({ id: c.traderId, ref: c.ref, rateMicro: bid.rate_micro, minMinor: null, maxMinor: c.block.operatorMaxOrderMinor, freeMinor: freeCapacity(c.block), completionPpm: completion(c.traderId) });
  }
  const outcome = await price(ctx, pc, offers);
  if (outcome.kind !== 'PRICED') return noPrice(ctx, rfq.id, request, outcome.reason === 'NO_OFFER' ? 'no bid can take the amount' : 'no bid prices within the market');
  const chosen = able.get(outcome.choice.offer.id)!;
  const winner = bids.find((b) => b.trader_id === chosen.traderId)!;
  const quoted = await placeQuote(ctx, {
    pc, choice: outcome.choice, traderId: chosen.traderId, blockId: chosen.block.id, routeId: chosen.block.routeId,
    committedBy: winner.placed_by, offeredBy: `RFQ:${rfq.ref}`, source: 'RFQ', rfqId: rfq.id,
  });
  await closeRfq(ctx, rfq.id, 'AWARDED', `priced as ${quoted.ref}`, winner.id);
  return 'AWARDED';
}

async function noPrice(ctx: TxContext, rfqId: string, request: RequestRow, note: string): Promise<AwardResult> {
  await closeRfq(ctx, rfqId, 'NO_PRICE', note, null);
  await enqueueOutbox(ctx, { type: 'desk.request_needs_action', aggregateType: 'trade_request', aggregateId: request.id, payload: { requestId: request.id } });
  return 'NO_PRICE';
}

async function closeRfq(ctx: TxContext, rfqId: string, status: 'AWARDED' | 'NO_PRICE' | 'CANCELLED', note: string, winnerBidId: string | null): Promise<void> {
  await ctx.tx.updateTable('rfq').set({ status, closed_at: sql<Date>`inrp2p_now()`, close_note: note.slice(0, 300) }).where('id', '=', rfqId).execute();
  if (winnerBidId) await ctx.tx.updateTable('rfq_bid').set({ status: 'WON' }).where('id', '=', winnerBidId).execute();
  const lost = await ctx.tx.updateTable('rfq_bid').set({ status: 'LOST' }).where('rfq_id', '=', rfqId).where('status', '=', 'LIVE').returning(['trader_id']).execute();
  await appendAudit(ctx, { action: `rfq.${status.toLowerCase()}`, entityType: 'rfq', entityId: rfqId, after: { status, note, winning_bid_id: winnerBidId, lost: lost.map((l) => l.trader_id) } });
}

/** Whether a request has a price request still open — routing and the desk's own assignment leave it alone meanwhile. */
export async function hasOpenRfq(ctx: TxContext, requestId: string): Promise<boolean> {
  return (await ctx.tx.selectFrom('rfq').select('id').where('trade_request_id', '=', requestId).where('status', '=', 'OPEN').executeTakeFirst()) !== undefined;
}

const SYSTEM = { type: 'SYSTEM' as const, id: null, surface: 'SYSTEM' as const };

async function awardStep(db: Db, rfqId: string, key: string): Promise<AwardResult> {
  const out = await executeCommand(db, { authorize: async () => {}, handle: (ctx) => awardRfqInTx(ctx, rfqId) }, { name: 'rfq.award', actor: SYSTEM, payload: { rfqId, run: key }, idempotencyKey: key, financial: true });
  return out.result;
}

/** `rfq_sweep` (cron, every minute): every price request that is due — or whose request went away — is closed, each in its own step. */
export async function runRfqSweep(db: Db, limit = 50): Promise<Record<AwardResult, number>> {
  const due = await sql<{ id: string }>`
    select q.id from rfq q join trade_request r on r.id = q.trade_request_id
     where q.status = 'OPEN'
       and (q.closes_at <= inrp2p_now() or r.status <> 'OPEN'
            or not exists (select 1 from rfq_invite i where i.rfq_id = q.id
                             and not exists (select 1 from rfq_bid b where b.rfq_id = q.id and b.trader_id = i.trader_id and b.status = 'LIVE')))
     order by q.closes_at limit ${limit}`.execute(db);
  const report: Record<AwardResult, number> = { NOT_DUE: 0, AWARDED: 0, NO_PRICE: 0, CANCELLED: 0, CLOSED: 0 };
  for (const { id } of due.rows) report[await awardStep(db, id, randomUUID())] += 1;
  return report;
}

/**
 * `reference_rate_refresh` (cron, every five minutes): the market's bid and ask read from public books and published as the
 * references automatic prices are bounded by, under the system actor (`recordMarketReference`).
 */
export async function runMarketReferenceRefresh(db: Db, read: () => Promise<{ bidMicro: bigint; askMicro: bigint; source: string }>): Promise<{ recorded: DirectionValue[]; skipped: string[]; source: string }> {
  const reading = await read();
  const key = randomUUID();
  const out = await executeCommand(db, { authorize: async () => {}, handle: (ctx) => recordMarketReference(ctx, reading) }, {
    name: 'rates.market_reference_read', actor: SYSTEM, payload: { source: reading.source, run: key }, idempotencyKey: key, financial: false,
  });
  return { ...out.result, source: reading.source };
}

/** A bid placed: when it was the last trader asked, the request is awarded at once rather than at its closing time. */
export function rfqAwardHandler(db: Db): OutboxHandler {
  return {
    name: 'rfq_award',
    handles: (type) => type === 'rfq.bid_placed',
    run: async (event) => {
      const p = (event.payload ?? {}) as { rfqId?: unknown };
      if (typeof p.rfqId === 'string') await awardStep(db, p.rfqId, `rfq_award:${event.id}`);
    },
  };
}

// ---- the client's side ------------------------------------------------------------------------------------------------

export type InstantQuotePayload = Omit<CreateRequestPayload, 'clientId' | 'deskId'>;

export interface InstantQuoteResult {
  readonly requestId: string;
  readonly ref: string;
  readonly outcome: AutoOutcome;
}

/**
 * `request.instant_quote` — a client of the INRP2P exchange asks for a price. With automatic prices off this is
 * `request.create` exactly. With them on, the client's earlier open requests are replaced (their quotes cancelled and their
 * traders' capacity given back) — one live price per client, so nobody holds liquidity by asking repeatedly — and the new
 * request is priced at once: a firm quote, a price request to traders, or a request a person prices.
 */
export function requestInstantQuote(actor: ClientActor, deps: QuoteDeps) {
  return memberClientCommand(actor, async (ctx, p: InstantQuotePayload, clientId): Promise<InstantQuoteResult> => {
    const payload: CreateRequestPayload = { ...p, clientId, deskId: null };
    if (!(await currentPricingPolicy(ctx.tx)).autoQuote) {
      const opened = await openRequestInTx(ctx, deps, { clientId, payload, channel: 'CLIENT_APP' });
      return { ...opened, outcome: { kind: 'MANUAL', reason: 'OFF' } };
    }
    const previous = (await ctx.tx.selectFrom('trade_request').select('id').where('client_id', '=', clientId).where('desk_id', 'is', null)
      .where('status', 'in', ['OPEN', 'QUOTED']).execute()).map((r) => r.id);
    const opened = await openRequestInTx(ctx, deps, { clientId, payload, channel: 'CLIENT_APP' });
    for (const id of [...previous, opened.requestId].sort()) await lockRow(ctx.tx, 'trade_request', 'trade_request', id);
    for (const id of previous) await cancelSentQuoteOfRequest(ctx, id, 'SUPERSEDED');
    const outcome = await autoPriceLockedInTx(ctx, { requestId: opened.requestId, supersede: previous });
    return { ...opened, outcome };
  });
}

/**
 * `request.reprice` — the client asks again for a price on its open request, after the last one ran out. Its traders'
 * earlier holds are given back first. A request already put to traders keeps waiting for them.
 */
export function repriceRequest(actor: ClientActor) {
  return memberClientCommand(actor, async (ctx, p: { requestId: string }, clientId): Promise<AutoOutcome> => {
    const requestId = requireUuid(p.requestId, 'requestId');
    await lockRow(ctx.tx, 'trade_request', 'trade_request', requestId);
    const request = await readRequest(ctx, requestId);
    if (request.client_id !== clientId) throw new DomainError('NOT_FOUND', 'request not found');
    if (request.status !== 'OPEN') throw new DomainError('REQUEST_NOT_OPEN', `request is ${request.status}`);
    await assertNewBusinessOpen(ctx.tx);
    const rfq = await ctx.tx.selectFrom('rfq').select(['ref', 'closes_at']).where('trade_request_id', '=', requestId).where('status', '=', 'OPEN').executeTakeFirst();
    if (rfq) return { kind: 'RFQ', rfqRef: rfq.ref, closesAt: rfq.closes_at.toISOString() };
    return autoPriceLockedInTx(ctx, { requestId });
  });
}

/** For the client's screen: whether its open request is with traders, and whether it can ask for a new price itself. */
export async function automaticPricingOf(ex: Executor, requestId: string): Promise<{ rfqClosesAt: string | null; canReprice: boolean }> {
  const [policy, rfq] = await Promise.all([
    currentPricingPolicy(ex),
    ex.selectFrom('rfq').select('closes_at').where('trade_request_id', '=', requestId).where('status', '=', 'OPEN').executeTakeFirst(),
  ]);
  return { rfqClosesAt: rfq ? rfq.closes_at.toISOString() : null, canReprice: policy.autoQuote && !rfq };
}
