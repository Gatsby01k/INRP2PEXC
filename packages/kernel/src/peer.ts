import { DomainError } from './errors.ts';
import { MARKET_RATE_STEP_MICRO } from './market-rate.ts';
import { Money } from './money.ts';
import { Rate } from './rate.ts';
import { type Direction, type P2pTradeEconomics, computeP2pEconomics } from './economics.ts';

/**
 * ADR 0033: two clients' requests meeting — the price of a meeting, its economics and its size. Pure arithmetic: the
 * quote module reads the requests, the market reference and the policy, and the database checks the result (IX148).
 *
 * A request's **bound** is its client's own price: a seller never takes less, a buyer never pays more. A request with no
 * bound takes the market reference of its own direction — a seller the bid, a buyer the ask. Two requests cross when the
 * buyer's bound is at or above the seller's. The meeting's centre is the market's middle held inside that range; INRP2P's
 * fee comes off it, half each side, but never past either bound — so two clients "at the market" both get the market's
 * rate and INRP2P keeps at most the market's spread. Rates sit on the rupee-paisa grid, rounded in INRP2P's favour inside
 * the range. The margin is never negative.
 */

const STEP = MARKET_RATE_STEP_MICRO;
const ceilStep = (micro: bigint): bigint => ((micro + STEP - 1n) / STEP) * STEP;
const floorStep = (micro: bigint): bigint => (micro / STEP) * STEP;

export interface PeerSide {
  /** The direction of this client's own request. */
  readonly direction: Direction;
  /** Its client's bound, or null — at the market. */
  readonly limitMicro: bigint | null;
}

export interface PeerMarket {
  /** The reference of clients selling USDT (what a buyer of USDT pays them at the market): the bid. */
  readonly bidMicro: bigint | null;
  /** The reference of clients buying USDT: the ask. */
  readonly askMicro: bigint | null;
}

export type PeerMeeting =
  | {
    readonly kind: 'CROSS';
    /** The rate the taker deals at, all-in for it. */
    readonly takerRateMicro: bigint;
    /** The rate the maker deals at — the route's rate. */
    readonly makerRateMicro: bigint;
    readonly centreMicro: bigint;
    readonly midMicro: bigint | null;
  }
  | {
    readonly kind: 'GAP';
    /** The all-in rate the taker would deal at, were it to meet the maker's bound. */
    readonly takerMeetsAtMicro: bigint;
    /** The all-in rate the maker would deal at, were it to meet the taker's bound. */
    readonly makerMeetsAtMicro: bigint;
  }
  /** One side has no bound and its market reference is missing: nothing to price it on. */
  | { readonly kind: 'NO_MARKET' };

function boundOf(side: PeerSide, market: PeerMarket): bigint | null {
  if (side.limitMicro !== null) return side.limitMicro;
  return side.direction === 'SELL_USDT' ? market.bidMicro : market.askMicro;
}

function feeOf(micro: bigint, feeBps: number): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 100) throw new DomainError('INVALID_ARGUMENT', 'a meeting fee is 0 to 100 basis points');
  return (micro * BigInt(feeBps) + 9_999n) / 10_000n;
}

/**
 * Where two requests from opposite sides meet, or how far apart they are. `taker` is the one acting now (or, between
 * two waiting requests, the one asked); `maker` is the other.
 */
export function peerMeeting(taker: PeerSide, maker: PeerSide, market: PeerMarket, feeBps: number): PeerMeeting {
  if (taker.direction === maker.direction) throw new DomainError('INVALID_ARGUMENT', 'a meeting joins two opposite sides');
  for (const v of [taker.limitMicro, maker.limitMicro, market.bidMicro, market.askMicro]) {
    if (v !== null && v <= 0n) throw new DomainError('INVALID_RATE', 'rates are positive');
  }
  const takerBuys = taker.direction === 'BUY_USDT';
  const buyer = takerBuys ? taker : maker;
  const seller = takerBuys ? maker : taker;
  const b = boundOf(buyer, market);
  const s = boundOf(seller, market);
  if (b === null || s === null) return { kind: 'NO_MARKET' };

  if (b < s) {
    // How far apart: what each would deal at, all-in, to meet the other's bound — the fee on top for a buyer, off for a seller.
    const buyerMeets = ceilStep(s + feeOf(s, feeBps));
    const sellerMeets = floorStep(b - feeOf(b, feeBps));
    return { kind: 'GAP', takerMeetsAtMicro: takerBuys ? buyerMeets : sellerMeets, makerMeetsAtMicro: takerBuys ? sellerMeets : buyerMeets };
  }

  const mid = market.bidMicro !== null && market.askMicro !== null ? (market.bidMicro + market.askMicro) / 2n : null;
  const centre = mid === null ? (s + b) / 2n : mid < s ? s : mid > b ? b : mid;
  const half = feeOf(centre, feeBps) / 2n;
  // The buyer pays the centre and half the fee, never past its bound; the seller gets the centre less half, never below its own.
  let buy = ceilStep(centre + half);
  if (buy > b) buy = floorStep(b);
  let sell = floorStep(centre - half);
  if (sell < s) sell = ceilStep(s);
  if (buy < sell) {
    // The range is narrower than the grid: one paisa-step rate inside it, if any, serves both.
    const one = ceilStep(s);
    if (one > b) return { kind: 'GAP', takerMeetsAtMicro: takerBuys ? one : floorStep(b), makerMeetsAtMicro: takerBuys ? floorStep(b) : one };
    buy = one;
    sell = one;
  }
  return { kind: 'CROSS', takerRateMicro: takerBuys ? buy : sell, makerRateMicro: takerBuys ? sell : buy, centreMicro: centre, midMicro: mid };
}

export type PeerEconomicsInput =
  | { readonly direction: Direction; readonly fixedSide: 'BASE'; readonly amount: Money<'USDT'>; readonly takerRateMicro: bigint; readonly makerRateMicro: bigint; readonly allowance: Money<'USDT'> }
  | { readonly direction: Direction; readonly fixedSide: 'QUOTE'; readonly amount: Money<'INR'>; readonly takerRateMicro: bigint; readonly makerRateMicro: bigint; readonly allowance: Money<'USDT'> };

export type PeerEconomics = P2pTradeEconomics & {
  readonly clientNetworkBase: Money<'USDT'>;
  /** The part of the allowance the maker's side carries in its USDT. */
  readonly makerNetworkBase: Money<'USDT'>;
  readonly networkFeeBase: Money<'USDT'>;
  /** INRP2P's own margin: the gross USDT margin less the network both sides paid. Never negative. */
  readonly netMarginBase: Money<'USDT'>;
};

/**
 * A meeting's economics (ADR 0033 §2.3), in the taker's direction: the taker is the trade's client, the maker its route.
 * The escrow carries the whole allowance; the taker pays half of it (rounded down) as its own line — buying, its rupees
 * price its USDT and that half; selling, its rupees price its USDT less it — and the maker's side carries the rest in its
 * USDT: a maker selling delivers that much more, a maker buying receives that much less. One rupee amount for both (FI-97).
 */
export function computePeerEconomics(input: PeerEconomicsInput): PeerEconomics {
  if (input.allowance.isNegative()) throw new DomainError('INVALID_AMOUNT', 'a network allowance is never negative');
  const takerNet = Money.ofMinor(input.allowance.minor / 2n, 'USDT');
  const makerNet = input.allowance.sub(takerNet);
  const base = computeP2pEconomics(
    input.fixedSide === 'BASE'
      ? { direction: input.direction, fixedSide: 'BASE', amount: input.amount, clientRate: Rate.ofMicro(input.takerRateMicro, 'CLIENT'), routeRate: Rate.ofMicro(input.makerRateMicro, 'ROUTE') }
      : { direction: input.direction, fixedSide: 'QUOTE', amount: input.amount, clientRate: Rate.ofMicro(input.takerRateMicro, 'CLIENT'), routeRate: Rate.ofMicro(input.makerRateMicro, 'ROUTE') },
    { clientNetwork: takerNet },
  );
  const buy = input.direction === 'BUY_USDT';
  const routeBase = buy ? base.routeBase.add(makerNet) : base.routeBase.sub(makerNet);
  if (!routeBase.isPositive()) throw new DomainError('INVALID_AMOUNT', 'amount is too small to carry the network');
  const grossMarginBase = buy ? routeBase.sub(base.base) : base.base.sub(routeBase);
  const netMarginBase = grossMarginBase.sub(input.allowance);
  if (netMarginBase.isNegative()) throw new DomainError('INVALID_RATE', 'a meeting never leaves a negative margin');
  return Object.freeze({ ...base, routeBase, grossMarginBase, clientNetworkBase: takerNet, makerNetworkBase: makerNet, networkFeeBase: input.allowance, netMarginBase });
}

export interface PeerSizeLimits {
  /** The taker's own amount, in its fixed unit — the most the meeting can be. */
  readonly takerAmountMinor: bigint;
  /** The maker's own request: what it sells or buys, in its fixed unit. */
  readonly maker: { readonly fixedSide: 'BASE' | 'QUOTE'; readonly amountMinor: bigint };
  /** The highest rupee amount both clients' peer limits allow. */
  readonly maxInrMinor: bigint;
  /** The smallest meeting, in the taker's USDT. */
  readonly minBaseMinor: bigint;
}

/** Whether a meeting of this size fits the maker's own request and both clients' limits. */
function fits(e: PeerEconomics, limits: PeerSizeLimits): boolean {
  if (e.clientInr.minor > limits.maxInrMinor) return false;
  // The maker sells what it has, or buys what it asked for — never more; its rupees are the deal's one amount.
  return limits.maker.fixedSide === 'QUOTE' ? e.routeInr.minor <= limits.maker.amountMinor : e.routeBase.minor <= limits.maker.amountMinor;
}

/**
 * The largest meeting both requests and both clients' limits allow, in the taker's fixed unit, at these rates — the
 * taker's whole amount when it fits; null when even the smallest meeting does not. Found by halving the amount: the
 * economics only grow with it.
 */
export function fitPeerDeal(input: Omit<PeerEconomicsInput, 'amount'> & { readonly limits: PeerSizeLimits }): PeerEconomics | null {
  const at = (minor: bigint): PeerEconomics | null => {
    try {
      return computePeerEconomics(input.fixedSide === 'BASE'
        ? { ...input, fixedSide: 'BASE', amount: Money.ofMinor(minor, 'USDT') }
        : { ...input, fixedSide: 'QUOTE', amount: Money.ofMinor(minor, 'INR') });
    } catch (e) {
      if (e instanceof DomainError && (e.code === 'INVALID_AMOUNT' || e.code === 'INVALID_RATE')) return null;
      throw e;
    }
  };
  const ok = (e: PeerEconomics | null): e is PeerEconomics => e !== null && fits(e, input.limits) && e.base.minor >= input.limits.minBaseMinor;
  const whole = at(input.limits.takerAmountMinor);
  if (ok(whole)) return whole;
  let lo = 0n;
  let hi = input.limits.takerAmountMinor;
  let best: PeerEconomics | null = null;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const e = at(mid);
    if (e !== null && fits(e, input.limits)) {
      lo = mid;
      best = e;
    } else {
      hi = mid;
    }
  }
  if (best === null || best.base.minor < input.limits.minBaseMinor) return null;
  // A round figure for people: whole rupees, or whole cents of USDT, below the largest that fits.
  const unit = input.fixedSide === 'QUOTE' ? 100n : 10_000n;
  const round = (lo / unit) * unit;
  if (round > 0n && round !== lo) {
    const r = at(round);
    if (ok(r)) return r;
  }
  return ok(best) ? best : null;
}

/** A client's highest rupee amount in one meeting, by the deals it completed (ADR 0033 §2.3). */
export function peerLimitInrMinor(completedDeals: number): bigint {
  if (completedDeals >= 10) return 50_000_000n;
  if (completedDeals >= 3) return 10_000_000n;
  return 2_500_000n;
}
