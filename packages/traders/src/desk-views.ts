import { sql } from 'kysely';
import { DomainError, Money, NO_MARKET, Rate, requireText } from '@inrp2p/kernel';
import { marketReferences } from '@inrp2p/pricing';
import type { DeskStatus, DirectionValue, Executor, TraderStatus } from '@inrp2p/db';
import {
  type TierName, type StandingIssue, currentDeskPrices, currentFeePolicy, deskOfTrader, freeCapacity, readBlocks, readStanding, switchOnIssues, traderMembership,
} from '@inrp2p/trader-core';
import { allowanceOf, currentGasFreeFees, networkFeePolicy } from '@inrp2p/network';
import { traderNetworkView } from './network.ts';
import type { P2pStep } from '@inrp2p/settlement';
import type { OrderStage } from './progress.ts';
import { orderSummariesOf } from './views.ts';

/**
 * The desk's own workspace (docs/adr/0020-desks.md, stage 1 block 5): what its people see of the exchange they run on
 * INRP2P — its standing, prices, deals, clients and what it earned and paid.
 *
 * Unlike a trader's order screens, a desk sees its own clients: they are its business. It never sees INRP2P's side of a
 * deal — the INRP2P desk's dealers, a route, a margin, an internal snapshot — nor anything about a client beyond its
 * dealings with this desk. `deskSafe` refuses those keys in every projection here, in production as well as in tests.
 */
export const FORBIDDEN_DESK_KEY = /margin|dealer|obligation|snapshot|operator|hmac|enc$|sealed|kyc|screening|legal|planned|route/i;

export function assertDeskSafe(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertDeskSafe(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_DESK_KEY.test(k)) throw new Error(`desk projection leaks key ${path}.${k}`);
    assertDeskSafe(v, `${path}.${k}`);
  }
}

function deskSafe<T>(value: T): T {
  assertDeskSafe(value);
  return value;
}

const usdt = (minor: bigint) => Money.ofMinor(minor, 'USDT').toDecimalString();
const inr = (minor: bigint) => Money.ofMinor(minor, 'INR').toDecimalString();
const clientRate = (micro: bigint) => Rate.ofMicro(micro, 'CLIENT').toDecimalString();

async function nowOf(ex: Executor): Promise<Date> {
  return (await sql<{ now: Date }>`select inrp2p_now() as now`.execute(ex)).rows[0]!.now;
}

export interface DeskSummary {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
  readonly about: string | null;
  readonly status: DeskStatus;
  /** Block 11: why INRP2P suspended the desk or hid its page — said to its people as INRP2P wrote it. */
  readonly suspensionReason: string | null;
  readonly pageHiddenReason: string | null;
  readonly version: number;
  readonly since: string;
}

export interface DeskWorkspace {
  /** Not a trader: a desk is a trader's. A trader without a desk yet: it can open one. */
  readonly state: 'NOT_TRADER' | 'NO_DESK' | 'OPEN';
  readonly traderStatus: TraderStatus | null;
  /** An administrator runs the desk — its page, its status, its team; whoever can commit works its deals and prices. */
  readonly canAdmin: boolean;
  readonly canCommit: boolean;
  readonly desk: DeskSummary | null;
  readonly now: string;
}

/** Who the signed-in person is to their client's desk, and the desk itself. The client comes from the membership. */
export async function deskWorkspace(ex: Executor, userId: string): Promise<DeskWorkspace & { readonly traderId: string | null }> {
  const member = await traderMembership(ex, userId);
  const trader = await ex.selectFrom('trader_profile').select(['id', 'status']).where('client_id', '=', member.clientId).executeTakeFirst();
  const desk = trader ? await deskOfTrader(ex, trader.id) : null;
  return deskSafe({
    state: !trader ? ('NOT_TRADER' as const) : desk ? ('OPEN' as const) : ('NO_DESK' as const),
    traderStatus: trader?.status ?? null,
    traderId: trader?.id ?? null,
    canAdmin: member.role === 'CLIENT_ADMIN',
    canCommit: member.canCommit,
    desk: desk ? { id: desk.id, handle: desk.handle, displayName: desk.displayName, about: desk.about, status: desk.status, suspensionReason: desk.suspensionReason, pageHiddenReason: desk.pageHiddenReason, version: desk.version, since: desk.createdAt.toISOString() } : null,
    now: (await nowOf(ex)).toISOString(),
  });
}

/** Opens the desk of the signed-in person's client, or refuses: every screen below needs one. */
async function ownDesk(ex: Executor, userId: string) {
  const ws = await deskWorkspace(ex, userId);
  if (!ws.desk || !ws.traderId) throw new DomainError('NOT_FOUND', 'open your desk first');
  return { ...ws, desk: ws.desk, traderId: ws.traderId };
}

export interface DeskPriceView {
  /** Migration 0048: the desk's own number (`OWN`), or its side's rate on Traders as it is now (`SIDE`). */
  readonly basis: 'OWN' | 'SIDE';
  /** The rate clients are priced at now; null for a price following a side that has no rate right now. */
  readonly rate: string | null;
  readonly min: string;
  readonly max: string;
  readonly live: boolean;
  /** Until when an own price stands; null for one following a side. */
  readonly validUntil: string | null;
  /** For a price following a side at a market rate: the side's offset from the market, in basis points. */
  readonly marketOffsetBps: number | null;
  /** Live and not past its time: what a client on the page is priced at. */
  readonly offered: boolean;
  readonly setAt: string;
}

export async function deskPriceViews(ex: Executor, deskId: string): Promise<Readonly<Record<DirectionValue, DeskPriceView | null>>> {
  const current = await currentDeskPrices(ex, deskId, await marketReferences(ex));
  const view = (d: DirectionValue): DeskPriceView | null => {
    const p = current[d];
    return p
      ? {
        basis: p.basis, rate: p.rateMicro === null ? null : clientRate(p.rateMicro), min: usdt(p.minBaseMinor), max: usdt(p.maxBaseMinor), live: p.live,
        validUntil: p.validUntil?.toISOString() ?? null, marketOffsetBps: p.market?.offsetBps ?? null, offered: p.offered, setAt: p.setAt.toISOString(),
      }
      : null;
  };
  return { SELL_USDT: view('SELL_USDT'), BUY_USDT: view('BUY_USDT') };
}

/** A desk deal in the desk's own words: its client, the client's side of it, and what the desk gets and pays. */
export interface DeskDeal {
  /** The desk's order reference: the deal's page in the workspace. */
  readonly ref: string;
  readonly tradeRef: string | null;
  readonly clientId: string;
  readonly clientName: string;
  /** The client's direction: SELL_USDT, the client sells USDT to the desk. */
  readonly direction: DirectionValue;
  readonly via: 'PAGE' | 'LINK';
  /** The client's USDT, the rupees between them, and the desk's rate. */
  readonly usdt: string;
  readonly inr: string;
  readonly rate: string;
  /** What the desk receives (client sells) or delivers (client buys) in USDT, and INRP2P's fee in it. */
  readonly deskUsdt: string;
  readonly fee: string;
  /** ADR 0022: the network allowance the desk's USDT carries in this deal (settled at cost into its credit); null in TRX. */
  readonly network: string | null;
  /** ASKING: the client holds the desk's price; IN_PROGRESS: accepted, settling; then COMPLETED or CANCELLED. */
  readonly state: 'ASKING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  readonly stage: OrderStage | null;
  /** The step of the deal's escrow (ADR 0019) while it settles: whose money moves next. */
  readonly step: P2pStep | null;
  /** The desk has to act now: put its USDT in escrow, pay the client, or confirm the client's rupees. */
  readonly yourMove: boolean;
  /** Until when the current step runs (a deal in progress), or the price can be accepted (asking). */
  readonly dueBy: string | null;
  readonly at: string;
  readonly completedAt: string | null;
}

interface DealRow {
  id: string;
  ref: string;
  status: string;
  offered_at: Date;
  completed_at: Date | null;
  closed_at: Date | null;
  client_id: string;
  client_name: string;
  direction: DirectionValue;
  desk_deal_link_id: string | null;
  quote_base: bigint | null;
  quote_inr: bigint | null;
  quote_rate: bigint | null;
  quote_desk_base: bigint | null;
  quote_fee: bigint | null;
  quote_network: bigint | null;
  quote_expires_at: Date | null;
  quote_status: string | null;
  trade_ref: string | null;
  trade_state: string | null;
  trade_opened_at: Date | null;
  finished_at: Date | null;
}

/**
 * The desk's deals: its own orders on requests placed with it. A price the client did not take is not a deal and is not
 * listed; one the client holds right now is (`ASKING`).
 */
async function dealRows(ex: Executor, deskId: string, where: 'OPEN' | 'DONE' | { ref: string }, limit = 100): Promise<DealRow[]> {
  const filter = typeof where === 'object'
    ? sql`and o.ref = ${where.ref}`
    : where === 'OPEN'
      ? sql`and ((o.status = 'IN_PROGRESS' and t.lifecycle_state not in ('COMPLETED', 'CANCELLED')) or (o.status = 'ACCEPTED' and o.trade_id is null and q.status = 'SENT' and q.expires_at > inrp2p_now()))`
      : sql`and (t.lifecycle_state in ('COMPLETED', 'CANCELLED') or o.status in ('COMPLETED', 'CANCELLED'))`;
  const r = await sql<DealRow>`
    select o.id, o.ref, o.status, o.offered_at, o.completed_at, o.closed_at,
           r.client_id, c.display_name as client_name, r.direction, r.desk_deal_link_id,
           q.base_minor as quote_base, q.quote_inr_minor as quote_inr, q.client_rate_micro as quote_rate,
           q.route_base_minor as quote_desk_base, q.platform_fee_base_minor as quote_fee, q.network_fee_base_minor as quote_network, q.expires_at as quote_expires_at, q.status as quote_status,
           t.ref as trade_ref, t.lifecycle_state as trade_state, t.opened_at as trade_opened_at, coalesce(t.completed_at, t.cancelled_at, o.completed_at) as finished_at
      from trader_order o
      join trade_request r on r.id = o.trade_request_id
      join client c on c.id = r.client_id
      -- The quote is the order's once it started; before that, the one that priced it (its frozen network terms, IX113).
      left join lateral (select f.quote_id from quote_network_fee f where f.trader_order_id = o.id order by f.created_at desc limit 1) nf on true
      left join quote q on q.id = coalesce(o.quote_id, nf.quote_id)
      left join trade t on t.id = o.trade_id
     where r.desk_id = ${deskId} ${filter}
     order by coalesce(t.completed_at, t.cancelled_at, t.opened_at, o.offered_at) desc
     limit ${limit}`.execute(ex);
  return r.rows;
}

async function toDeals(ex: Executor, traderId: string, rows: readonly DealRow[]): Promise<DeskDeal[]> {
  const summaries = await orderSummariesOf(ex, traderId, rows.filter((r) => r.status === 'IN_PROGRESS' && r.trade_state !== 'COMPLETED' && r.trade_state !== 'CANCELLED').map((r) => r.id));
  return rows.map((r) => {
    const s = summaries.get(r.id);
    // The deal is its trade: completed or cancelled the moment the trade is, whatever the order's own sweep has caught up with.
    const state = r.trade_state === 'COMPLETED' || r.status === 'COMPLETED' ? 'COMPLETED'
      : r.trade_state === 'CANCELLED' || r.status === 'CANCELLED' ? 'CANCELLED'
      : r.status === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'ASKING';
    return {
      ref: r.ref, tradeRef: r.trade_ref, clientId: r.client_id, clientName: r.client_name, direction: r.direction, via: r.desk_deal_link_id ? 'LINK' : 'PAGE',
      usdt: usdt(r.quote_base ?? 0n), inr: inr(r.quote_inr ?? 0n), rate: clientRate(r.quote_rate ?? 0n),
      deskUsdt: usdt(r.quote_desk_base ?? 0n), fee: usdt(r.quote_fee ?? 0n), network: r.quote_network === null ? null : usdt(r.quote_network),
      state, stage: s?.stage ?? null, step: s?.p2pStep ?? null, yourMove: s?.stage === 'YOUR_TURN',
      dueBy: state === 'ASKING' ? (r.quote_expires_at?.toISOString() ?? null) : (s?.dueBy ?? null),
      at: (r.trade_opened_at ?? r.offered_at).toISOString(), completedAt: state === 'COMPLETED' || state === 'CANCELLED' ? (r.finished_at ?? r.closed_at)?.toISOString() ?? null : null,
    } satisfies DeskDeal;
  });
}

export interface DeskPeriod {
  readonly deals: number;
  readonly usdt: string;
  readonly fees: string;
}

/** Completed deals of the desk over three windows — today (India's day), seven days, thirty days — from the trades. */
async function deskPeriods(ex: Executor, deskId: string): Promise<{ readonly today: DeskPeriod; readonly week: DeskPeriod; readonly month: DeskPeriod }> {
  const r = await sql<{ d_n: number; d_b: string; d_f: string; w_n: number; w_b: string; w_f: string; m_n: number; m_b: string; m_f: string }>`
    with done as (
      select t.completed_at, e.base_minor, coalesce(e.platform_fee_base_minor, 0) as fee
        from trade t join trade_request r on r.id = t.trade_request_id join trade_economics e on e.trade_id = t.id
       where r.desk_id = ${deskId} and t.lifecycle_state = 'COMPLETED' and t.completed_at > inrp2p_now() - interval '30 days')
    select count(*) filter (where completed_at >= (date_trunc('day', inrp2p_now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'))::int as d_n,
           coalesce(sum(base_minor) filter (where completed_at >= (date_trunc('day', inrp2p_now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')), 0)::text as d_b,
           coalesce(sum(fee) filter (where completed_at >= (date_trunc('day', inrp2p_now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')), 0)::text as d_f,
           count(*) filter (where completed_at > inrp2p_now() - interval '7 days')::int as w_n,
           coalesce(sum(base_minor) filter (where completed_at > inrp2p_now() - interval '7 days'), 0)::text as w_b,
           coalesce(sum(fee) filter (where completed_at > inrp2p_now() - interval '7 days'), 0)::text as w_f,
           count(*)::int as m_n, coalesce(sum(base_minor), 0)::text as m_b, coalesce(sum(fee), 0)::text as m_f
      from done`.execute(ex);
  const x = r.rows[0]!;
  const period = (n: number, b: string, f: string): DeskPeriod => ({ deals: n, usdt: usdt(BigInt(b)), fees: usdt(BigInt(f)) });
  return { today: period(x.d_n, x.d_b, x.d_f), week: period(x.w_n, x.w_b, x.w_f), month: period(x.m_n, x.m_b, x.m_f) };
}

/** What has to be true for a client on the page to get a price: each condition, and whether it holds. */
export interface DeskReadiness {
  readonly approved: boolean;
  readonly reserve: boolean;
  readonly destinations: boolean;
  /** Capacity left on the trader's side for each client direction (client sells: the desk's rupees; buys: its USDT). */
  readonly liquidity: boolean;
  readonly network: boolean;
  readonly prices: boolean;
  readonly live: boolean;
}

export interface DeskToday {
  readonly desk: DeskSummary;
  readonly readiness: DeskReadiness;
  /** Why the desk cannot deal at all right now, most fundamental first (a trader's standing). */
  readonly standing: readonly StandingIssue[];
  readonly prices: Readonly<Record<DirectionValue, DeskPriceView | null>>;
  /** What the desk can fill now, per client direction: rupees it can pay for USDT, USDT it can deliver. */
  readonly capacity: { readonly SELL_USDT: { readonly available: string; readonly currency: 'INR' } | null; readonly BUY_USDT: { readonly available: string; readonly currency: 'USDT' } | null };
  /**
   * What fuels the desk's transfers: its TRX deposit (`BURN`), or nothing at all — each deal carries its own network in
   * USDT through GasFree (`GASFREE`, ADR 0022).
   */
  readonly network: { readonly mode: 'BURN' | 'GASFREE'; readonly available: string; readonly dealsCovered: number | null; readonly short: boolean };
  /**
   * ADR 0024: what the desk's own reserve allows at its level — the largest deal it can take now (its own USDT side), what
   * is open, and the level. Null when the programme sets no reserve-based limits.
   */
  readonly reserveLimits: { readonly level: TierName; readonly largestDeal: string; readonly open: string; readonly maxOpen: string } | null;
  /** Deals waiting on the desk, the most urgent first; then the rest of what is open. */
  readonly yourMove: readonly DeskDeal[];
  readonly open: readonly DeskDeal[];
  readonly periods: { readonly today: DeskPeriod; readonly week: DeskPeriod; readonly month: DeskPeriod };
  readonly clients: { readonly total: number; readonly newThisWeek: number };
  readonly openLinks: number;
  /** INRP2P's fee on a deal the desk fills itself, in basis points. */
  readonly feeBps: number;
  /** ADR 0022: what a deal's USDT side carries for its network now, at GasFree's fees; null in TRX. */
  readonly networkFee: string | null;
  readonly now: string;
}

/** The desk's "Today": whether it can deal, what waits on it, what is open, and how it has been doing. */
export async function deskToday(ex: Executor, userId: string): Promise<DeskToday> {
  const { desk, traderId } = await ownDesk(ex, userId);
  const now = await nowOf(ex);
  const { standing, reserve } = await readStanding(ex, traderId);
  const issues = switchOnIssues(standing);
  // A desk deals at its own live prices: its sides give it capacity, never a rate.
  const blocks = await readBlocks(ex, traderId, NO_MARKET);
  const l = reserve.limits;
  const room = l ? l.maxOpenMinor - l.exposure.totalMinor : 0n;
  const largest = l ? (room < l.maxDealMinor ? (room > 0n ? room : 0n) : l.maxDealMinor) : 0n;
  const buys = blocks.find((b) => b.side === 'BUY_USDT');
  const sells = blocks.find((b) => b.side === 'SELL_USDT');
  const free = (b: (typeof blocks)[number] | undefined) => (b && b.status === 'ACTIVE' ? freeCapacity({ ...b, offeredMinor: 0n }) : 0n);
  const prices = await deskPriceViews(ex, desk.id);
  const network = await traderNetworkView(ex, traderId);
  const deals = await toDeals(ex, traderId, await dealRows(ex, desk.id, 'OPEN'));
  const byDue = (a: DeskDeal, b: DeskDeal) => (a.dueBy ?? '9999').localeCompare(b.dueBy ?? '9999');
  const clients = await sql<{ total: number; recent: number }>`
    select count(*)::int as total, count(*) filter (where created_at > inrp2p_now() - interval '7 days')::int as recent from desk_client where desk_id = ${desk.id}`.execute(ex);
  const links = await sql<{ n: number }>`
    select count(*)::int as n from desk_deal_link l
     where l.desk_id = ${desk.id} and l.status <> 'REVOKED' and l.expires_at > inrp2p_now()
       and not exists (select 1 from trade_request r join trade t on t.trade_request_id = r.id where r.desk_deal_link_id = l.id)`.execute(ex);
  const priced = (prices.SELL_USDT?.offered ?? false) || (prices.BUY_USDT?.offered ?? false);
  const liquid = (prices.SELL_USDT?.offered && free(buys) > 0n) || (prices.BUY_USDT?.offered && free(sells) > 0n) || (!priced && (free(buys) > 0n || free(sells) > 0n));

  return deskSafe({
    desk,
    readiness: {
      approved: !issues.includes('NOT_APPROVED') && !issues.includes('PAUSED'),
      reserve: !issues.includes('RESERVE_NOT_SET') && !issues.includes('RESERVE_SHORT'),
      destinations: !issues.includes('DESTINATIONS_INACTIVE'),
      liquidity: Boolean(liquid),
      network: !network.short,
      prices: priced,
      live: desk.status === 'LIVE',
    },
    standing: issues,
    prices,
    capacity: {
      SELL_USDT: buys ? { available: inr(free(buys)), currency: 'INR' as const } : null,
      BUY_USDT: sells ? { available: usdt(free(sells)), currency: 'USDT' as const } : null,
    },
    network: { mode: network.mode, available: network.available, dealsCovered: network.ordersCovered, short: network.short },
    reserveLimits: l ? { level: l.tier.name, largestDeal: usdt(largest), open: usdt(l.exposure.totalMinor), maxOpen: usdt(l.maxOpenMinor) } : null,
    yourMove: deals.filter((d) => d.yourMove).sort(byDue),
    open: deals.filter((d) => !d.yourMove),
    periods: await deskPeriods(ex, desk.id),
    clients: { total: clients.rows[0]!.total, newThisWeek: clients.rows[0]!.recent },
    openLinks: links.rows[0]!.n,
    feeBps: (await currentFeePolicy(ex)).ownDealBps,
    networkFee: await deskNetworkFee(ex),
    now: now.toISOString(),
  });
}

/**
 * What a desk deal's USDT side carries for its network right now (ADR 0022 §2.2), as the next quote would price it at
 * GasFree's fees. Null when the network is priced in TRX or GasFree's fees were not read lately.
 */
export async function deskNetworkFee(ex: Executor): Promise<string | null> {
  if ((await networkFeePolicy(ex)).resourceMode !== 'GASFREE') return null;
  try {
    return usdt(allowanceOf(await currentGasFreeFees(ex)));
  } catch {
    return null;
  }
}

/** Both tabs of the desk's deals: open (asking and in progress) and done (completed and cancelled), newest first. */
export async function deskDeals(ex: Executor, userId: string, tab: 'open' | 'done'): Promise<{ readonly deals: readonly DeskDeal[]; readonly periods: Awaited<ReturnType<typeof deskPeriods>>; readonly now: string }> {
  const { desk, traderId } = await ownDesk(ex, userId);
  return deskSafe({
    deals: await toDeals(ex, traderId, await dealRows(ex, desk.id, tab === 'open' ? 'OPEN' : 'DONE', 200)),
    periods: await deskPeriods(ex, desk.id),
    now: (await nowOf(ex)).toISOString(),
  });
}

/** One deal of the desk, by its order reference; another desk's reference is "not found". */
export async function deskDeal(ex: Executor, userId: string, ref: string): Promise<DeskDeal> {
  const { desk, traderId } = await ownDesk(ex, userId);
  const rows = await dealRows(ex, desk.id, { ref: requireText(ref, 'ref', 32) }, 1);
  if (rows.length === 0) throw new DomainError('NOT_FOUND', 'deal not found');
  return deskSafe((await toDeals(ex, traderId, rows))[0]!);
}

/** The desk's prices, for its prices screen, with what the desk can fill on each side and the fee it pays on a deal. */
export async function deskPricing(ex: Executor, userId: string) {
  const { desk, traderId } = await ownDesk(ex, userId);
  // The sides' rates as they are now: what a desk price following its side would be (migration 0048).
  const blocks = await readBlocks(ex, traderId, await marketReferences(ex));
  const side = (s: 'BUY_USDT' | 'SELL_USDT') => blocks.find((b) => b.side === s);
  const sideRate = (s: 'BUY_USDT' | 'SELL_USDT') => {
    const b = side(s);
    return b ? { rate: b.rateMicro === null ? null : clientRate(b.rateMicro), basis: b.rateBasis, marketOffsetBps: b.marketOffsetBps } : null;
  };
  const free = (b: ReturnType<typeof side>) => (b && b.status === 'ACTIVE' ? freeCapacity({ ...b, offeredMinor: 0n }) : 0n);
  return deskSafe({
    desk,
    prices: await deskPriceViews(ex, desk.id),
    capacity: {
      SELL_USDT: side('BUY_USDT') ? inr(free(side('BUY_USDT'))) : null,
      BUY_USDT: side('SELL_USDT') ? usdt(free(side('SELL_USDT'))) : null,
    },
    /** Keyed by the client's direction: the rate of the side that fills it, now — what "same as on Traders" prices at. */
    sides: { SELL_USDT: sideRate('BUY_USDT'), BUY_USDT: sideRate('SELL_USDT') },
    feeBps: (await currentFeePolicy(ex)).ownDealBps,
    networkFee: await deskNetworkFee(ex),
    now: (await nowOf(ex)).toISOString(),
  });
}
