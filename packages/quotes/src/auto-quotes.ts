import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { DomainError, type MarketReference, type MarketReferences, Money, NO_MARKET, Rate, railsOverlap, requireUuid } from '@inrp2p/kernel';
import { type Db, type DirectionValue, type Executor, type FixedSideValue, type TraderSide, type TxContext, assertLockOrder, lockInOrder } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox, type OutboxHandler } from '@inrp2p/outbox';
import { usableUpiId } from '@inrp2p/clients';
import { executeCommand } from '@inrp2p/commands';
import type { ClientActor } from '@inrp2p/identity';
import { assertNewBusinessOpen, newBusinessState } from '@inrp2p/trades';
import {
  type PricedOffer, type PricingChoice, type PricingPolicy, type ReferenceRateSnapshot, acceptanceEvidence, approximateBase, choosePrice, currentPricingPolicy, freshReference,
  marketReferences, publishTraderRate, recordMarketReference, sizeBand,
} from '@inrp2p/pricing';
import {
  type BlockRead, type RiskLimits, closeOrdersForRequests, completionPpm, effectiveMaxOrder, freeCapacity, lockBlock, readBlocks, readStanding, riskFit, standingIssues, traderProgram,
  traderRecords,
} from '@inrp2p/trader-core';
import {
  type UsdtNetworkTerms, assertProfitable, currentNetworkCosts, networkAvailable, networkFeePolicy, priceNetworkP2p, pricingOfUsdtTerms, recordQuoteNetworkFee, reservePerSendSun,
  usdtNetworkTerms,
} from '@inrp2p/network';
import { lockRow } from './actors.ts';
import { memberClientCommand } from './desk-deals.ts';
import type { QuoteDeps } from './policy.ts';
import { type CreateRequestPayload, cancelSentQuoteOfRequest, closeRequest, openRequestInTx } from './requests.ts';
import { businessNow, hitRateLimit } from './security.ts';

/**
 * Automatic prices of the INRP2P exchange (docs/adr/0025-automatic-pricing.md, 0028-fully-automatic-exchange.md): a client
 * asks, and in the same step gets a firm price — or, when no firm offer prices it, a price request goes to several traders —
 * or, when nothing can be priced honestly, it waits for a trader (0032-no-client-turned-away.md). Nobody at INRP2P prices or
 * routes it; with automatic prices off, every request waits for a person exactly as before.
 *
 * A firm price is, in one transaction: the chosen trader's order opened and accepted on its own firm offer (or its winning
 * bid), its capacity held until the quote can no longer be accepted and a minute more; the trader's rate published as the
 * route's snapshot; the quote at the chosen client price with its frozen network terms; the decision recorded beside it
 * (`auto_quote`, IX139); the quote sent for `AUTO_QUOTE_SECONDS`. The client then accepts it like any quote (`quote.accept`),
 * which opens the trade and starts the order — nothing about the price, the trader or the economics changes after that.
 *
 * Nobody holds capacity twice: every trader a price could go to is locked before any order is touched (lock order:
 * request → quote → traders → orders → blocks), so routing, a trader's own edits and other prices wait their turn; the
 * capacity is checked again under the block's lock before it is held.
 */

/** How long an automatic price can be accepted. */
export const AUTO_QUOTE_SECONDS = 60;
/**
 * ADR 0032: how long a price found for a waiting client is held. The client is not on the screen when it is found — it is
 * told by message and comes back to it — so a minute would be gone before it is read. The trader's capacity is held as
 * long, and a minute more, like any price's.
 */
export const HELD_QUOTE_SECONDS = 600;
/** ADR 0032: how long the exchange keeps looking for a trader for a request nothing priced. */
export const WAIT_HOURS = 24;
/** ADR 0032: a trader is told that clients are waiting at most this often. */
export const DEMAND_NOTICE_MINUTES = 30;
/** The trader's capacity outlives the quote by this much, then the trader sweep gives it back. */
const HOLD_GRACE_SECONDS = 60;
/** The acting system, as it is written into orders, quotes and audit events. */
const SYSTEM_PRICER = 'SYSTEM:auto_price';

/**
 * Why a request could not be priced automatically: prices are off (a person prices it), the market reference or the
 * network's fees are not known, no firm offer takes the amount, none takes it at the market — or, put to traders, none bid
 * a price that does.
 */
export type ManualReason = 'OFF' | 'NO_MARKET' | 'NETWORK_UNKNOWN' | 'NO_OFFER' | 'NOT_COMPETITIVE';
export type NoPriceReason = Exclude<ManualReason, 'OFF'> | 'NO_BID';

export type AutoOutcome =
  | { readonly kind: 'QUOTED'; readonly quoteId: string; readonly ref: string; readonly clientRate: string; readonly base: string; readonly clientInr: string; readonly expiresAt: string }
  | { readonly kind: 'RFQ'; readonly rfqRef: string; readonly closesAt: string }
  /** Automatic prices are off: the request waits for a person, as before ADR 0025. */
  | { readonly kind: 'MANUAL'; readonly reason: 'OFF' }
  /**
   * ADR 0032: nothing prices it honestly now — the request stays open and the exchange keeps looking until `until`; the
   * traders who could take it are told someone is waiting. Found, the price is held for the client and it is told.
   */
  | { readonly kind: 'WAITING'; readonly reason: NoPriceReason; readonly until: string };

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

/** How the deal's network is paid — on GasFree in USDT, by its client (ADR 0022, 0028); in TRX from its trader's network deposit. */
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
  /** ADR 0024: the most of its own USDT the trader's reserve lets it put into one more deal; null when no limits apply. */
  readonly roomMinor: bigint | null;
}

/** What a trader's limits leave for one more deal, in its own USDT: the lower of its largest deal and its open room. */
const roomOf = (limits: RiskLimits | null): bigint | null => {
  if (!limits) return null;
  const open = limits.maxOpenMinor - limits.exposure.totalMinor;
  const room = open < limits.maxDealMinor ? open : limits.maxDealMinor;
  return room > 0n ? room : 0n;
};

/**
 * Traders in standing whose side fills this request on a P2P route, pay or are paid by a rail this amount can travel on,
 * and — when their deposit pays the network in TRX — can cover the deal's transfers. Whether their offer is firm, and
 * whether it takes this amount, is the pricing's to decide.
 */
async function candidates(ctx: TxContext, request: RequestRow, network: NetworkMode, reference: ReferenceRateSnapshot, market: MarketReferences): Promise<Candidate[]> {
  const side = sideFor(request.direction);
  const approxInr = request.fixed_side === 'QUOTE' ? requestedOf(request) : (requestedOf(request) * reference.rate.micro) / 10_000_000_000n;
  const traders = await ctx.tx.selectFrom('trader_profile').select(['id', 'ref', 'client_id']).where('status', 'in', ['APPROVED', 'PAUSED']).orderBy('ref').execute();
  const out: Candidate[] = [];
  for (const t of traders) {
    if (t.client_id === request.client_id) continue;
    const { standing, reserve } = await readStanding(ctx.tx, t.id);
    if (standingIssues(standing).length > 0) continue;
    const roomMinor = roomOf(reserve.limits);
    if (roomMinor === 0n) continue;
    const block = (await readBlocks(ctx.tx, t.id, market)).find((b) => b.side === side);
    if (!block || block.status !== 'ACTIVE') continue;
    const route = await ctx.tx.selectFrom('liquidity_route').select(['execution_mode', 'status']).where('id', '=', block.routeId).executeTakeFirstOrThrow();
    if (route.execution_mode !== 'P2P' || route.status !== 'ACTIVE') continue;
    // The deal will offer only the rails this side uses (`dealRails`) — and UPI only to a verified UPI ID of whoever is
    // paid (ADR 0029): the trader when the client buys, the client when it sells. One of them must carry the amount.
    const inr = approxInr > 0n ? approxInr : 1n;
    const upi = block.rails.includes('UPI') && (await usableUpiId(ctx.tx, request.direction === 'BUY_USDT' ? t.client_id : request.client_id, inr)) !== null;
    if (!railsOverlap(inr, upi ? block.rails : block.rails.filter((r) => r !== 'UPI'))) continue;
    if (network.mode === 'BURN' && (await networkAvailable(ctx.tx, t.id)) < network.needSun) continue;
    out.push({ traderId: t.id, ref: t.ref, block, roomMinor });
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
  /** ADR 0028: the references a side at a market rate is priced on — the same reads for every trader weighed. */
  readonly market: MarketReferences;
}

/** ADR 0028: on GasFree the client pays the deal's network, the whole allowance its escrow carries. */
const clientNetworkOf = (network: NetworkMode): bigint => (network.mode === 'GASFREE' ? network.terms.allowanceUsdtMinor : 0n);

/** The kernel's pricing over a set of offers, with this request's evidence of acceptance. */
async function price(ctx: TxContext, pc: PriceContext, offers: readonly PricedOffer[]) {
  const amount = requestedOf(pc.request);
  const band = sizeBand(approximateBase(pc.request.fixed_side, amount, pc.reference.rate.micro));
  const evidence = await acceptanceEvidence(ctx.tx, { direction: pc.request.direction, sizeBand: band, binBps: pc.policy.binBps, learningDays: pc.policy.learningDays });
  return choosePrice({
    direction: pc.request.direction, fixedSide: pc.request.fixed_side, amountMinor: amount, offers, referenceMicro: pc.reference.rate.micro,
    maxPremiumBps: pc.policy.maxPremiumBps, binBps: pc.policy.binBps,
    networkAllowanceMinor: pc.network.mode === 'GASFREE' ? pc.network.terms.allowanceUsdtMinor : 0n,
    clientNetworkMinor: clientNetworkOf(pc.network),
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
  /** ADR 0032: a price found for a waiting client, who is not on the screen — held `HELD_QUOTE_SECONDS`, and not learnt from. */
  readonly held: boolean;
  /** ADR 0028: for a firm offer at a market rate, the reference and terms its rate was derived from; null otherwise. */
  readonly market: { readonly reference: MarketReference; readonly offsetBps: number; readonly limitMicro: bigint | null } | null;
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
  const validFor = p.held ? HELD_QUOTE_SECONDS : AUTO_QUOTE_SECONDS;
  const expiresAt = new Date(now.getTime() + validFor * 1000);
  const holdUntil = new Date(expiresAt.getTime() + HOLD_GRACE_SECONDS * 1000);
  const program = await traderProgram(ctx.tx);
  const rateMicro = choice.offer.rateMicro;
  const econ = choice.econ;

  // ADR 0024: the trader's own USDT in the deal stays within what its reserve allows, counted under its lock — before the
  // order exists, since an open order is part of the exposure the limits are read with.
  const { reserve } = await readStanding(ctx.tx, p.traderId);
  if (reserve.limits && riskFit(reserve.limits, econ.routeBase.minor)) throw new DomainError('TRADER_LIMIT_EXCEEDED', 'the chosen trader’s reserve does not cover this deal');

  // A new order locks nothing that exists; its block is locked next, after any order this transaction closed.
  const order = await ctx.tx.insertInto('trader_order')
    .values({
      trader_id: p.traderId, block_id: p.blockId, route_id: p.routeId, trade_request_id: request.id, side,
      base_minor: econ.routeBase.minor, inr_minor: econ.clientInr.minor, rate_micro: rateMicro, capacity_minor: choice.capacityMinor,
      planned_client_rate_micro: choice.clientRateMicro, offered_by: p.offeredBy,
      rate_reference_snapshot_id: p.market?.reference.snapshotId ?? null, rate_offset_bps: p.market?.offsetBps ?? null, rate_limit_micro: p.market?.limitMicro ?? null,
      offer_expires_at: sql<Date>`inrp2p_now() + make_interval(secs => ${program.offerTtlSeconds})`,
    })
    .returning(['id', 'ref'])
    .executeTakeFirstOrThrow();
  const facts = (await readBlocks(ctx.tx, p.traderId, pc.market)).find((b) => b.id === p.blockId)!;
  const block = await lockBlock(ctx, p.blockId);
  if (block.status !== 'ACTIVE') throw new DomainError('TRADER_NOT_ELIGIBLE', 'the chosen side stopped taking orders');
  if (p.source === 'INSTANT') {
    // Under the block's lock: still firm, and still the very terms the price was made on — its own number, or the same
    // market terms on the same reference (the database derives that rate again, IX143).
    const firm = block.instant_open_ended || (block.instant_until !== null && block.instant_until > now);
    const same = p.market
      ? block.rate_basis === 'MARKET' && block.market_offset_bps === p.market.offsetBps && block.rate_limit_micro === p.market.limitMicro && facts.rateMicro === rateMicro
      : block.rate_basis === 'FIXED' && block.rate_micro === rateMicro;
    if (!firm || !same) throw new DomainError('TRADER_ORDER_NOT_LIVE', 'the chosen firm offer changed while it was being priced');
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
      client_network_base_minor: allowance, network: request.network, bank_account_id: request.bank_account_id, crypto_wallet_id: request.crypto_wallet_id,
      valid_for_seconds: validFor, is_counter: false, negative_margin_reason: null, created_by: SYSTEM_PRICER,
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
      net_margin_usdt_minor: choice.netMarginMinor, min_net_margin_usdt_minor: choice.minNetMarginMinor, held: p.held,
    })
    .execute();

  await ctx.tx.updateTable('quote').set({ status: 'SENT', sent_at: now, expires_at: expiresAt, sent_by: SYSTEM_PRICER }).where('id', '=', quote.id).execute();
  const current = await ctx.tx.selectFrom('trade_request').select('version').where('id', '=', request.id).executeTakeFirstOrThrow();
  // Priced, a request stops waiting (ADR 0032): if this price runs out, the client asks again for itself.
  await ctx.tx.updateTable('trade_request').set({ status: 'QUOTED', waiting_until: null, last_activity_at: sql<Date>`inrp2p_now()`, version: current.version + 1 }).where('id', '=', request.id).execute();

  await appendAudit(ctx, {
    action: 'quote.auto_priced', entityType: 'quote', entityId: quote.id,
    after: {
      ref: quote.ref, request_id: request.id, source: p.source, rfq_id: p.rfqId, held: p.held, order_id: order.id, trader_id: p.traderId, direction: request.direction,
      client_rate: Rate.ofMicro(choice.clientRateMicro, 'CLIENT'), trader_rate: Rate.ofMicro(rateMicro, 'ROUTE'), base: econ.base, client_inr: econ.clientInr,
      trader_base: econ.routeBase, gross_margin_usdt: econ.grossMarginBase, network_usdt: allowance === null ? null : Money.ofMinor(allowance, 'USDT'),
      network_paid_by: allowance === null ? null : 'CLIENT', trader_rate_market: p.market ? { reference_snapshot_id: p.market.reference.snapshotId, offset_bps: p.market.offsetBps } : null,
      net_margin_usdt: Money.ofMinor(choice.netMarginMinor, 'USDT'), min_net_margin_usdt: Money.ofMinor(choice.minNetMarginMinor, 'USDT'),
      reference: { snapshot_id: pc.reference.id, rate: pc.reference.rate, age_seconds: pc.reference.ageSeconds }, cap_rate: Rate.ofMicro(choice.capRateMicro, 'CLIENT'),
      position_bps: choice.positionBps, acceptance_ppm: choice.acceptancePpm.toString(), completion_ppm: choice.offer.completionPpm.toString(),
      expected_net_usdt: Money.ofMinor(choice.expectedNetMinor, 'USDT'), offers: choice.viableOffers, policy_id: pc.policy.id, expires_at: expiresAt,
    },
  });
  // A held price (ADR 0032) is told as what it is: the trader the client waited for, found — by every channel it has.
  await enqueueOutbox(ctx, {
    type: 'quote.sent', aggregateType: 'quote', aggregateId: quote.id,
    payload: { quoteId: quote.id, expiresAt: expiresAt.toISOString(), clientId: request.client_id, ...(p.held ? { held: true } : {}) },
  });
  return {
    kind: 'QUOTED', quoteId: quote.id, ref: quote.ref, clientRate: Rate.ofMicro(choice.clientRateMicro, 'CLIENT').toDecimalString(),
    base: econ.base.toDecimalString(), clientInr: econ.clientInr.toDecimalString(), expiresAt: expiresAt.toISOString(),
  };
}

/** The firm offer a candidate stands behind for this request, if any: its rate within its own limits and what it has free. */
function firmOffer(c: Candidate, completion: bigint): PricedOffer | null {
  const b = c.block;
  if (!b.firm || !b.instantSetBy || b.rateMicro === null || b.minOrderMinor === null || b.maxOrderMinor === null) return null;
  return {
    id: c.traderId, ref: c.ref, rateMicro: b.rateMicro, minMinor: b.minOrderMinor, maxMinor: effectiveMaxOrder(b), freeMinor: freeCapacity(b), completionPpm: completion, maxBaseMinor: c.roomMinor,
  };
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
  else if (!(reference = await freshReference(ctx.tx, request.direction, policy))) manual = 'NO_MARKET';
  else if (!(network = await networkMode(ctx))) manual = 'NETWORK_UNKNOWN';
  const market = manual ? NO_MARKET : await marketReferences(ctx.tx, policy);
  const peek = manual ? [] : await candidates(ctx, request, network!, reference!, market);

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
  // With prices off a person prices it, as before; with them on, nothing waits for a person (ADR 0028) — and nobody is
  // turned away: what nothing prices now waits for a trader (ADR 0032).
  if (manual === 'OFF') return { kind: 'MANUAL', reason: 'OFF' };
  if (manual) return keepWaiting(ctx, request, manual, null);

  // Under the locks, the candidates as they are now.
  const pc: PriceContext = { request, policy, reference: reference!, network: network!, market };
  const locked = await candidates(ctx, request, network!, reference!, market);
  const completion = await completionOf(ctx, policy);
  const offers = locked.map((c) => firmOffer(c, completion(c.traderId))).filter((o): o is PricedOffer => o !== null);
  const outcome = await price(ctx, pc, offers);
  if (outcome.kind === 'PRICED') {
    const chosen = locked.find((c) => c.traderId === outcome.choice.offer.id)!;
    const b = chosen.block;
    return placeQuote(ctx, {
      pc, choice: outcome.choice, traderId: chosen.traderId, blockId: b.id, routeId: b.routeId,
      committedBy: b.instantSetBy!, offeredBy: SYSTEM_PRICER, source: 'INSTANT', rfqId: null, held: false,
      market: b.rateBasis === 'MARKET' && b.market ? { reference: b.market, offsetBps: b.marketOffsetBps!, limitMicro: b.rateLimitMicro } : null,
    });
  }
  // No firm offer prices it — none takes the amount, or none takes it at the market: when price requests are on, the
  // traders who could fill it are asked for their best rate, the ones whose firm offer fell short included.
  if (policy.rfq) {
    const opened = await openRfqInTx(ctx, pc, locked.map((c) => ({ ...c, completionPpm: completion(c.traderId) })));
    if (opened) return opened;
  }
  return keepWaiting(ctx, request, outcome.reason, outcome.reason === 'NO_OFFER' ? readyNowText(pc, offers) : null);
}

/** ADR 0032: what the client is told when the exchange stopped looking and found no price. */
export const WAIT_ENDED_TEXT = `No trader could take this amount in the ${WAIT_HOURS} hours we looked. Nothing was committed — ask again whenever you like.`;

/**
 * For an amount no firm offer takes: the amounts the firm offers do take now, in whole USDT at the market reference — what
 * the client can ask for instead of waiting, and be priced at once. Said as "about": the client's own USDT moves with its
 * price and the deal's network. Null when no firm offer takes any amount.
 */
function readyNowText(pc: PriceContext, offers: readonly PricedOffer[]): string | null {
  if (offers.length === 0) return null;
  const inr = pc.request.direction === 'SELL_USDT';
  const usdt = (m: bigint): bigint => (inr ? (m * 10_000_000_000n) / pc.reference.rate.micro : m);
  let lo: bigint | null = null;
  let hi = 0n;
  for (const o of offers) {
    let top = o.freeMinor;
    if (o.maxMinor !== null && o.maxMinor < top) top = o.maxMinor;
    let topUsdt = usdt(top);
    if (o.maxBaseMinor !== undefined && o.maxBaseMinor !== null && o.maxBaseMinor < topUsdt) topUsdt = o.maxBaseMinor;
    const bottom = o.minMinor === null ? 0n : usdt(o.minMinor);
    if (topUsdt <= bottom) continue;
    if (lo === null || bottom < lo) lo = bottom;
    if (topUsdt > hi) hi = topUsdt;
  }
  // Whole USDT, grouped by thousands the international way (D-11): "20,000".
  const whole = (m: bigint, up: boolean) => ((m + (up ? 999_999n : 0n)) / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (lo === null || hi === 0n) return null;
  const a = whole(lo, true);
  const b = whole(hi, false);
  return a === '0' || a === '1'
    ? `Right now a trader can take up to about ${b} USDT — ask for that and your price comes at once.`
    : `Right now a trader can take about ${a} to ${b} USDT — ask for that and your price comes at once.`;
}

/** The most a firm offer takes right now, as `readyNowText` words it: whole USDT, without grouping. Null when it says none. */
const READY_NOW = /a trader can take (?:up to about|about [\d,]+ to) ([\d,]+) USDT/;
export function readyNowMaxOf(text: string | null): string | null {
  const m = text ? READY_NOW.exec(text) : null;
  return m ? m[1]!.replace(/,/g, '') : null;
}

/** ADR 0032: what a waiting client is shown about its wait — facts of record, nothing estimated. */
export interface WaitingFacts {
  readonly since: string;
  readonly until: string;
  /** What it waits on: the exchange's own reading of the market or the network, or a trader's price. */
  readonly on: 'MARKET' | 'TRADERS';
  /** The traders with this side, told that a client waits on it (none while it waits on the market). */
  readonly tradersTold: number;
  /** Requests on the same side that started waiting before this one: the sweep prices them first. */
  readonly ahead: number;
  /** The most a firm offer takes right now, in whole USDT, when the client could ask for that and be priced at once. */
  readonly readyNowUsdt: string | null;
}

/** ADR 0032: the wait of a request, for its client's screen; null when it does not wait. */
export async function waitingFactsOf(ex: Executor, requestId: string): Promise<WaitingFacts | null> {
  const r = await ex.selectFrom('trade_request')
    .select(['id', 'client_id', 'direction', 'status', 'status_reason', 'no_price_reason', 'waiting_since', 'waiting_until'])
    .where('id', '=', requireUuid(requestId, 'requestId'))
    .executeTakeFirst();
  if (!r || r.status !== 'OPEN' || !r.waiting_until || !r.waiting_since) return null;
  const on = r.no_price_reason === 'NO_MARKET' || r.no_price_reason === 'NETWORK_UNKNOWN' ? 'MARKET' : 'TRADERS';
  const [told, ahead] = await Promise.all([
    on === 'MARKET'
      ? Promise.resolve({ n: '0' })
      : ex.selectFrom('trader_profile as t')
        .innerJoin('trader_block as b', 'b.trader_id', 't.id')
        .innerJoin('liquidity_route as l', 'l.id', 'b.route_id')
        .select(sql<string>`count(distinct t.id)`.as('n'))
        .where('t.status', '=', 'APPROVED').where('t.client_id', '<>', r.client_id).where('b.side', '=', sideFor(r.direction)).where('l.execution_mode', '=', 'P2P')
        .executeTakeFirstOrThrow(),
    ex.selectFrom('trade_request').select(sql<string>`count(*)`.as('n'))
      .where('status', '=', 'OPEN').where('waiting_until', 'is not', null).where('direction', '=', r.direction)
      .where(sql<boolean>`(waiting_since, id) < (${r.waiting_since}, ${r.id}::uuid)`)
      .executeTakeFirstOrThrow(),
  ]);
  return {
    since: r.waiting_since.toISOString(),
    until: r.waiting_until.toISOString(),
    on,
    tradersTold: Number.parseInt(told.n, 10),
    ahead: Number.parseInt(ahead.n, 10),
    readyNowUsdt: on === 'TRADERS' ? readyNowMaxOf(r.status_reason) : null,
  };
}

/**
 * ADR 0032 (amending 0028): nothing prices the request honestly now, and the client is not turned away. The request stays
 * open and the exchange keeps looking — every minute (`runWaitingSweep`) — for `WAIT_HOURS` from when it started waiting;
 * the reason is on the record, and `hint`, when there is one, is what the client could ask for instead and be priced at
 * once. The traders who could take it hear that a client is waiting — unless all that is missing is the exchange's own
 * reading of the market or of the network, which no trader can help with.
 */
async function keepWaiting(ctx: TxContext, request: RequestRow, reason: NoPriceReason, hint: string | null): Promise<Extract<AutoOutcome, { kind: 'WAITING' }>> {
  const current = await ctx.tx.selectFrom('trade_request').select(['status', 'version', 'waiting_since', 'waiting_until']).where('id', '=', request.id).executeTakeFirstOrThrow();
  const now = await businessNow(ctx.tx);
  const fresh = current.waiting_until === null;
  const until = fresh ? new Date(now.getTime() + WAIT_HOURS * 3_600_000) : current.waiting_until!;
  await ctx.tx.updateTable('trade_request')
    .set({
      status_reason: hint, no_price_reason: reason, waiting_since: fresh ? now : current.waiting_since, waiting_until: until,
      last_activity_at: sql<Date>`inrp2p_now()`, version: current.version + 1,
    })
    .where('id', '=', request.id)
    .execute();
  await appendAudit(ctx, { action: 'quote.auto_price_skipped', entityType: 'trade_request', entityId: request.id, after: { ref: request.ref, reason } });
  if (fresh) {
    await appendAudit(ctx, {
      action: 'request.waiting', entityType: 'trade_request', entityId: request.id,
      before: { status: current.status }, after: { status: 'OPEN', no_price: reason, waiting_until: until, by: SYSTEM_PRICER },
    });
    if (reason !== 'NO_MARKET' && reason !== 'NETWORK_UNKNOWN') await tellTradersClientWaiting(ctx, request);
  }
  return { kind: 'WAITING', reason, until: until.toISOString() };
}

/**
 * ADR 0032: the traders who could take a waiting request — approved by INRP2P, with the side it needs on a P2P route,
 * online or not, and never the client itself — hear that a client is waiting: the side and the amount, never who. How
 * often one trader hears it is the inbox's to limit (`DEMAND_NOTICE_MINUTES`).
 */
async function tellTradersClientWaiting(ctx: TxContext, request: RequestRow): Promise<void> {
  const traders = await ctx.tx.selectFrom('trader_profile as t')
    .innerJoin('trader_block as b', 'b.trader_id', 't.id')
    .innerJoin('liquidity_route as r', 'r.id', 'b.route_id')
    .select('t.id')
    .distinct()
    .where('t.status', '=', 'APPROVED')
    .where('t.client_id', '<>', request.client_id)
    .where('b.side', '=', sideFor(request.direction))
    .where('r.execution_mode', '=', 'P2P')
    .orderBy('t.id')
    .execute();
  for (const t of traders) {
    await enqueueOutbox(ctx, { type: 'trader.clients_waiting', aggregateType: 'trade_request', aggregateId: request.id, payload: { requestId: request.id, traderId: t.id } });
  }
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
  // ADR 0024: and the USDT of its own the deal would take, at the market reference, within what its reserve leaves — a
  // trader who could not bid is not asked, and does not take the place of one who could.
  const ownUsdt = request.fixed_side === 'BASE' ? amount : (amount * 10_000_000_000n) / reference.rate.micro;
  const invitees = traders
    .filter((t) => t.block.operatorMaxOrderMinor === null || approx <= t.block.operatorMaxOrderMinor)
    .filter((t) => t.block.operatorMaxCapacityMinor === null || approx <= t.block.operatorMaxCapacityMinor)
    .filter((t) => t.roomMinor === null || ownUsdt <= t.roomMinor)
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
 * request waits for a trader (ADR 0032); with the request gone or taken by a person, the price request is cancelled.
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
  if (!reference || !network || bids.length === 0) {
    return noPrice(ctx, rfq.id, request, bids.length === 0 ? 'no trader bid' : 'nothing to bound the price by', !reference ? 'NO_MARKET' : !network ? 'NETWORK_UNKNOWN' : 'NO_BID');
  }

  await lockInOrder(ctx.tx, 'trader_profile', 'trader_profile', bids.map((b) => b.trader_id));
  // A bid is its own rate; the references only say whether its side is in standing as everywhere else.
  const market = await marketReferences(ctx.tx, policy);
  const pc: PriceContext = { request, policy, reference, network, market };
  const able = new Map((await candidates(ctx, request, network, reference, market)).map((c) => [c.traderId, c]));
  const completion = await completionOf(ctx, policy);
  const offers: PricedOffer[] = [];
  for (const bid of bids) {
    const c = able.get(bid.trader_id);
    const blockId = invited.find((i) => i.trader_id === bid.trader_id)?.block_id;
    if (!c || c.block.id !== blockId) continue;
    offers.push({
      id: c.traderId, ref: c.ref, rateMicro: bid.rate_micro, minMinor: null, maxMinor: c.block.operatorMaxOrderMinor, freeMinor: freeCapacity(c.block), completionPpm: completion(c.traderId),
      maxBaseMinor: c.roomMinor,
    });
  }
  const outcome = await price(ctx, pc, offers);
  if (outcome.kind !== 'PRICED') return noPrice(ctx, rfq.id, request, outcome.reason === 'NO_OFFER' ? 'no bid can take the amount' : 'no bid prices within the market', 'NO_BID');
  const chosen = able.get(outcome.choice.offer.id)!;
  const winner = bids.find((b) => b.trader_id === chosen.traderId)!;
  const quoted = await placeQuote(ctx, {
    pc, choice: outcome.choice, traderId: chosen.traderId, blockId: chosen.block.id, routeId: chosen.block.routeId,
    committedBy: winner.placed_by, offeredBy: `RFQ:${rfq.ref}`, source: 'RFQ', rfqId: rfq.id, market: null, held: false,
  });
  await closeRfq(ctx, rfq.id, 'AWARDED', `priced as ${quoted.ref}`, winner.id);
  return 'AWARDED';
}

/**
 * A price request that ends without a price. With automatic prices on, the request waits for a trader (ADR 0032); switched
 * off meanwhile, it goes to a person as every request then does.
 */
async function noPrice(ctx: TxContext, rfqId: string, request: RequestRow, note: string, reason: NoPriceReason): Promise<AwardResult> {
  await closeRfq(ctx, rfqId, 'NO_PRICE', note, null);
  if ((await currentPricingPolicy(ctx.tx)).autoQuote) {
    await keepWaiting(ctx, request, reason, null);
  } else {
    await enqueueOutbox(ctx, { type: 'desk.request_needs_action', aggregateType: 'trade_request', aggregateId: request.id, payload: { requestId: request.id } });
  }
  return 'NO_PRICE';
}

async function closeRfq(ctx: TxContext, rfqId: string, status: 'AWARDED' | 'NO_PRICE' | 'CANCELLED', note: string, winnerBidId: string | null): Promise<void> {
  await ctx.tx.updateTable('rfq').set({ status, closed_at: sql<Date>`inrp2p_now()`, close_note: note.slice(0, 300) }).where('id', '=', rfqId).execute();
  if (winnerBidId) await ctx.tx.updateTable('rfq_bid').set({ status: 'WON' }).where('id', '=', winnerBidId).execute();
  const lost = await ctx.tx.updateTable('rfq_bid').set({ status: 'LOST' }).where('rfq_id', '=', rfqId).where('status', '=', 'LIVE').returning(['trader_id']).execute();
  await appendAudit(ctx, { action: `rfq.${status.toLowerCase()}`, entityType: 'rfq', entityId: rfqId, after: { status, note, winning_bid_id: winnerBidId, lost: lost.map((l) => l.trader_id) } });
}

const SYSTEM = { type: 'SYSTEM' as const, id: null, surface: 'SYSTEM' as const };

async function awardStep(db: Db, rfqId: string, key: string): Promise<AwardResult> {
  const out = await executeCommand(db, { authorize: async () => {}, handle: (ctx) => awardRfqInTx(ctx, rfqId) }, { name: 'rfq.award', actor: SYSTEM, payload: { rfqId, run: key }, idempotencyKey: key, financial: true });
  return out.result;
}

/**
 * A price request the award refused outright (the winner's side changed under it, say) ends without a price rather than
 * being tried again every minute in front of the others.
 */
async function giveUpStep(db: Db, rfqId: string, reason: string): Promise<void> {
  const key = randomUUID();
  await executeCommand(db, {
    authorize: async () => {},
    handle: async (ctx) => {
      const head = await ctx.tx.selectFrom('rfq').select(['trade_request_id']).where('id', '=', rfqId).executeTakeFirstOrThrow();
      await lockRow(ctx.tx, 'trade_request', 'trade_request', head.trade_request_id);
      assertLockOrder(ctx.tx, 'rfq');
      const rfq = await ctx.tx.selectFrom('rfq').select(['id', 'status']).where('id', '=', rfqId).forUpdate().executeTakeFirstOrThrow();
      if (rfq.status !== 'OPEN') return;
      await noPrice(ctx, rfq.id, await readRequest(ctx, head.trade_request_id), `could not be awarded: ${reason}`, 'NO_BID');
    },
  }, { name: 'rfq.give_up', actor: SYSTEM, payload: { rfqId, run: key }, idempotencyKey: key, financial: true });
}

export interface RfqSweepReport extends Record<AwardResult, number> {
  readonly failures: readonly { readonly rfqId: string; readonly code: string; readonly message: string }[];
}

/**
 * `rfq_sweep` (cron, every minute): every price request that is due — or whose request went away — is closed, each in its
 * own step; one that fails never holds up the rest.
 */
export async function runRfqSweep(db: Db, limit = 50): Promise<RfqSweepReport> {
  const due = await sql<{ id: string }>`
    select q.id from rfq q join trade_request r on r.id = q.trade_request_id
     where q.status = 'OPEN'
       and (q.closes_at <= inrp2p_now() or r.status <> 'OPEN'
            or not exists (select 1 from rfq_invite i where i.rfq_id = q.id
                             and not exists (select 1 from rfq_bid b where b.rfq_id = q.id and b.trader_id = i.trader_id and b.status = 'LIVE')))
     order by q.closes_at limit ${limit}`.execute(db);
  const report: Record<AwardResult, number> = { NOT_DUE: 0, AWARDED: 0, NO_PRICE: 0, CANCELLED: 0, CLOSED: 0 };
  const failures: { rfqId: string; code: string; message: string }[] = [];
  for (const { id } of due.rows) {
    try {
      report[await awardStep(db, id, randomUUID())] += 1;
    } catch (e) {
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      failures.push({ rfqId: id, code: e instanceof DomainError ? e.code : 'UNEXPECTED', message });
      // A refusal is the same next minute; anything else (the database, a conflict) may pass and is simply tried again.
      if (e instanceof DomainError) {
        await giveUpStep(db, id, `${e.code}: ${message}`).then(() => { report.NO_PRICE += 1; }, () => undefined);
      }
    }
  }
  return { ...report, failures };
}

// ---- the clients who wait (ADR 0032) ----------------------------------------------------------------------------------

export type WaitingResult = 'STILL_WAITING' | 'PRICED' | 'ENDED' | 'TO_A_PERSON' | 'GONE';

/**
 * A waiting request, looked at again under its lock.
 *
 * - Its time up, it closes declined (ADR 0028) and the client is told.
 * - Automatic prices switched off meanwhile, it goes to a person, as every request then does.
 * - Otherwise, when a firm offer prices it now, it is priced as a client asking would be — every trader it could go to
 *   locked first — but held for `HELD_QUOTE_SECONDS`: the client is not on the screen, it is told by message and comes back
 *   to it. Whether anything prices it is seen first without locking a single trader, so a look every minute costs no trader
 *   a wait.
 * - Nothing pricing it, it keeps waiting, and what the client could ask for instead is kept current.
 */
export async function lookAgainInTx(ctx: TxContext, requestId: string): Promise<WaitingResult> {
  await lockRow(ctx.tx, 'trade_request', 'trade_request', requireUuid(requestId, 'requestId'));
  const row = await ctx.tx.selectFrom('trade_request').select(['status', 'version', 'waiting_until', 'status_reason', 'no_price_reason']).where('id', '=', requestId).executeTakeFirstOrThrow();
  if (row.status !== 'OPEN' || row.waiting_until === null) return 'GONE';
  const request = await readRequest(ctx, requestId);
  if (row.waiting_until <= (await businessNow(ctx.tx))) {
    await endWait(ctx, request, row.version);
    return 'ENDED';
  }
  if ((await newBusinessState(ctx.tx)).paused) return 'STILL_WAITING';
  if (await ctx.tx.selectFrom('rfq').select('id').where('trade_request_id', '=', requestId).where('status', '=', 'OPEN').executeTakeFirst()) return 'STILL_WAITING';
  const policy = await currentPricingPolicy(ctx.tx);
  if (!policy.autoQuote) {
    await ctx.tx.updateTable('trade_request').set({ waiting_until: null, version: row.version + 1 }).where('id', '=', requestId).execute();
    await appendAudit(ctx, { action: 'request.waiting_ended', entityType: 'trade_request', entityId: requestId, after: { to: 'DESK', reason: 'automatic prices are off' } });
    await enqueueOutbox(ctx, { type: 'desk.request_needs_action', aggregateType: 'trade_request', aggregateId: requestId, payload: { requestId } });
    return 'TO_A_PERSON';
  }
  const reference = await freshReference(ctx.tx, request.direction, policy);
  const network = reference ? await networkMode(ctx) : null;
  if (!reference || !network) return 'STILL_WAITING';
  const market = await marketReferences(ctx.tx, policy);
  const pc: PriceContext = { request, policy, reference, network, market };
  const completion = await completionOf(ctx, policy);
  const offersOf = (cs: readonly Candidate[]) => cs.map((c) => firmOffer(c, completion(c.traderId))).filter((o): o is PricedOffer => o !== null);

  const peek = await candidates(ctx, request, network, reference, market);
  const seen = await price(ctx, pc, offersOf(peek));
  if (seen.kind !== 'PRICED') {
    const hint = seen.reason === 'NO_OFFER' ? readyNowText(pc, offersOf(peek)) : null;
    if (hint !== row.status_reason || seen.reason !== row.no_price_reason) {
      await ctx.tx.updateTable('trade_request').set({ status_reason: hint, no_price_reason: seen.reason, version: row.version + 1 }).where('id', '=', requestId).execute();
      // It waited only on the exchange's own reading of the market; now it waits on traders, and they hear of it.
      if (row.no_price_reason === 'NO_MARKET' || row.no_price_reason === 'NETWORK_UNKNOWN') await tellTradersClientWaiting(ctx, request);
    }
    return 'STILL_WAITING';
  }

  // Something prices it: every trader it could go to is locked, then priced on the candidates as they are now.
  await lockInOrder(ctx.tx, 'trader_profile', 'trader_profile', peek.map((c) => c.traderId));
  const locked = await candidates(ctx, request, network, reference, market);
  const outcome = await price(ctx, pc, offersOf(locked));
  if (outcome.kind !== 'PRICED') return 'STILL_WAITING';
  const chosen = locked.find((c) => c.traderId === outcome.choice.offer.id)!;
  const b = chosen.block;
  await placeQuote(ctx, {
    pc, choice: outcome.choice, traderId: chosen.traderId, blockId: b.id, routeId: b.routeId,
    committedBy: b.instantSetBy!, offeredBy: SYSTEM_PRICER, source: 'INSTANT', rfqId: null, held: true,
    market: b.rateBasis === 'MARKET' && b.market ? { reference: b.market, offsetBps: b.marketOffsetBps!, limitMicro: b.rateLimitMicro } : null,
  });
  return 'PRICED';
}

/** The wait is over with no price: the request closes declined, as ADR 0028 closed it at once, and the client is told. */
async function endWait(ctx: TxContext, request: RequestRow, version: number): Promise<void> {
  await ctx.tx.updateTable('trade_request')
    .set({ status: 'DECLINED', status_reason: WAIT_ENDED_TEXT, waiting_until: null, closed_at: sql<Date>`inrp2p_now()`, last_activity_at: sql<Date>`inrp2p_now()`, version: version + 1 })
    .where('id', '=', request.id)
    .execute();
  await appendAudit(ctx, {
    action: 'request.declined', entityType: 'trade_request', entityId: request.id,
    before: { status: 'OPEN' }, after: { status: 'DECLINED', reason: WAIT_ENDED_TEXT, by: SYSTEM_PRICER, waited_hours: WAIT_HOURS },
  });
  await enqueueOutbox(ctx, { type: 'client.request_wait_ended', aggregateType: 'trade_request', aggregateId: request.id, payload: { requestId: request.id, clientId: request.client_id } });
}

export interface WaitingSweepReport extends Record<WaitingResult, number> {
  readonly failures: readonly { readonly requestId: string; readonly code: string; readonly message: string }[];
}

/**
 * `waiting_requests_sweep` (cron, every minute): every waiting request looked at again, the longest waiting first — the
 * first to ask is the first a trader's price goes to — each in its own step; one that fails is looked at next minute and
 * never holds up the rest.
 */
export async function runWaitingSweep(db: Db, limit = 100): Promise<WaitingSweepReport> {
  const due = await db.selectFrom('trade_request').select('id').where('status', '=', 'OPEN').where('waiting_until', 'is not', null)
    .orderBy('waiting_since').orderBy('id').limit(limit).execute();
  const report: Record<WaitingResult, number> = { STILL_WAITING: 0, PRICED: 0, ENDED: 0, TO_A_PERSON: 0, GONE: 0 };
  const failures: { requestId: string; code: string; message: string }[] = [];
  for (const { id } of due) {
    const key = randomUUID();
    try {
      const out = await executeCommand(db, { authorize: async () => {}, handle: (ctx) => lookAgainInTx(ctx, id) }, {
        name: 'request.look_again', actor: SYSTEM, payload: { requestId: id, run: key }, idempotencyKey: key, financial: true,
      });
      report[out.result] += 1;
    } catch (e) {
      failures.push({ requestId: id, code: e instanceof DomainError ? e.code : 'UNEXPECTED', message: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    }
  }
  return { ...report, failures };
}

/**
 * `reference_rate_refresh` (cron, every five minutes): the market's bid and ask read from public books and published as the
 * references automatic prices are bounded by, under the system actor (`recordMarketReference`).
 */
export async function runMarketReferenceRefresh(db: Db, read: () => Promise<{ bidMicro: bigint; askMicro: bigint; source: string }>): Promise<{ recorded: DirectionValue[]; skipped: string[]; source: string }> {
  const reading = await read();
  // A reading every five minutes, recorded and audited as itself; no idempotency key — one nobody could present again
  // replays nothing (see `scanner/system.ts`).
  const out = await executeCommand(db, { authorize: async () => {}, handle: (ctx) => recordMarketReference(ctx, reading) }, {
    name: 'rates.market_reference_read', actor: SYSTEM, payload: { source: reading.source }, idempotencyKey: null, financial: false,
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

/**
 * Prices one client may ask for in `PRICE_REQUEST_WINDOW_SECONDS`, firm or not. Each automatic price locks every trader it
 * could go to and holds one trader's capacity, and each one left to lapse counts in what prices are learnt from: a client
 * asking in a loop would slow every other client's price and teach the pricing its own refusals. A person comparing
 * amounts asks a few times a minute at most.
 */
export const PRICE_REQUESTS_PER_WINDOW = 30;
export const PRICE_REQUEST_WINDOW_SECONDS = 600;

/** Counts a price request of the client against its window — in its own transaction, before the request runs. */
export async function limitPriceRequests(db: Db, clientId: string): Promise<void> {
  await hitRateLimit(db, { bucket: 'price_request_client', subject: requireUuid(clientId, 'clientId'), limit: PRICE_REQUESTS_PER_WINDOW, windowSeconds: PRICE_REQUEST_WINDOW_SECONDS });
}

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
 * request is priced at once: a firm quote, a price request to traders, or — nothing pricing it honestly — the request waits
 * for a trader, and the client is told the moment one prices it (ADR 0032).
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

/**
 * For the client's screen: whether its open request is with traders, whether it is waiting for one (ADR 0032) and until
 * when, and whether it can ask for a new price itself — not while it waits: the exchange is already looking every minute.
 */
export async function automaticPricingOf(ex: Executor, requestId: string): Promise<{ rfqClosesAt: string | null; waitingUntil: string | null; canReprice: boolean }> {
  const [policy, rfq, request] = await Promise.all([
    currentPricingPolicy(ex),
    ex.selectFrom('rfq').select('closes_at').where('trade_request_id', '=', requestId).where('status', '=', 'OPEN').executeTakeFirst(),
    ex.selectFrom('trade_request').select('waiting_until').where('id', '=', requestId).executeTakeFirst(),
  ]);
  const waitingUntil = request?.waiting_until ?? null;
  return { rfqClosesAt: rfq ? rfq.closes_at.toISOString() : null, waitingUntil: waitingUntil ? waitingUntil.toISOString() : null, canReprice: policy.autoQuote && !rfq && !waitingUntil };
}
