import { DomainError, Money, Rate, computeP2pEconomics, divRound, inrToUsdt, type TradeEconomics } from '@inrp2p/kernel';

/**
 * The automatic price of a deal on the INRP2P exchange (ADR 0025), as pure arithmetic over facts read elsewhere.
 *
 * What INRP2P earns on a deal is the USDT its escrow keeps — the difference between the client's price and the trader's
 * rate, less the network the escrow carries (FI-97, FI-100) — and it earns it only if the client accepts and the trader
 * then completes. So the price chosen is the one with the highest **expected** net margin:
 *
 *     acceptance(price) × completion(trader) × net margin(price, trader)
 *
 * over every client price on the rupee-paisa grid and every firm offer that can take the deal, where
 *
 * - the net margin is the kernel's own P2P economics (`computeP2pEconomics`), exact and rounded against whoever is paid,
 *   and must be at least the policy's minimum — a price that leaves less is never a candidate, so a negative one never is;
 * - the price is never worse for the client than the confirmed market reference moved by the policy's premium (the cap):
 *   it is competitive by construction, and that bound is the only place the market enters the price;
 * - acceptance is learned from INRP2P's own automatic quotes — accepted against declined, counted in price bands relative
 *   to the reference, for the deal's size band and its direction — with a uniform prior and the constraint that a better
 *   price is never less likely to be accepted (pooled adjacent violators). With no evidence every band is even odds, so
 *   the first prices sit at the cap and keep the full spread the traders' rates leave; declines move them down, and old
 *   evidence ages out of the window, so higher prices are tried again;
 * - completion is the trader's record of finishing what it started (`completionPpm`, from trader-core).
 *
 * No elasticity, mark-up or market figure is assumed: what is not the traders' rates, the reference and the deal's own
 * costs is counted from what clients and traders actually did.
 */

export type Direction = 'SELL_USDT' | 'BUY_USDT';
export type FixedSide = 'BASE' | 'QUOTE';

/** Rupee-paisa per USDT: the grid client prices are given on. */
export const PRICE_STEP_MICRO = 10_000n;
/** At most this many grid prices are weighed, nearest the cap first — a bound on the work, not on the price. */
export const MAX_PRICE_POINTS = 5_000;
const PPM = 1_000_000n;
const SCALE = 10_000_000_000n;

/** One firm offer: a trader's rate with the order sizes it takes, in its own currency (INR when it buys USDT, USDT when it sells). */
export interface PricedOffer {
  readonly id: string;
  /** For a deterministic choice between equals. */
  readonly ref: string;
  readonly rateMicro: bigint;
  readonly minMinor: bigint | null;
  readonly maxMinor: bigint | null;
  readonly freeMinor: bigint;
  /** That a deal given to this trader completes, in parts per million. */
  readonly completionPpm: bigint;
  /**
   * ADR 0024: the most of its own USDT this trader may put into one more deal — the lower of its level's largest deal and
   * what its open deals leave of its limit, both from its free reserve. Absent when no limits apply.
   */
  readonly maxBaseMinor?: bigint | null;
}

export interface Tally {
  readonly accepted: number;
  readonly declined: number;
}

export interface AcceptanceEvidence {
  /** By price band (`bin`), for the deal's direction and size band. */
  readonly band: ReadonlyMap<number, Tally>;
  /** By price band, for the deal's direction across all sizes — what a size band with little evidence leans on. */
  readonly direction: ReadonlyMap<number, Tally>;
}

export interface PricingInput {
  readonly direction: Direction;
  readonly fixedSide: FixedSide;
  readonly amountMinor: bigint;
  readonly offers: readonly PricedOffer[];
  readonly referenceMicro: bigint;
  readonly maxPremiumBps: number;
  readonly binBps: number;
  /** The USDT the escrow carries for the deal's network out of INRP2P's margin (GasFree); zero when its trader funds it in TRX. */
  readonly networkAllowanceMinor: bigint;
  /** The policy's minimum net margin in rupees; each price must leave it in USDT at that price's own rate (rounded up). */
  readonly minNetMarginInrMinor: bigint;
  readonly evidence: AcceptanceEvidence;
}

export type P2pEconomics = TradeEconomics & { readonly routeBase: Money<'USDT'>; readonly grossMarginBase: Money<'USDT'> };

export interface PricingChoice {
  readonly clientRateMicro: bigint;
  readonly offer: PricedOffer;
  readonly econ: P2pEconomics;
  /** The amount the trader's capacity holds, in its own currency. */
  readonly capacityMinor: bigint;
  readonly netMarginMinor: bigint;
  readonly minNetMarginMinor: bigint;
  readonly positionBps: number;
  readonly bin: number;
  readonly acceptancePpm: bigint;
  readonly capRateMicro: bigint;
  /** acceptance × completion × net margin, in micro-USDT. */
  readonly expectedNetMinor: bigint;
  /** The offers that could take the deal at some price within the bounds. */
  readonly viableOffers: number;
}

export type PricingOutcome =
  | { readonly kind: 'PRICED'; readonly choice: PricingChoice }
  /** No offer can take this amount at all; or offers can, but none at a price within the market bound that leaves the minimum. */
  | { readonly kind: 'NONE'; readonly reason: 'NO_OFFER' | 'NOT_COMPETITIVE'; readonly capRateMicro: bigint };

/** Floor division for a positive divisor (bigint `/` truncates towards zero). */
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new DomainError('INVALID_ARGUMENT', 'divisor must be positive');
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}

/** The price band a position falls in: whole bands of `binBps`, floored (so −1 bps is in band −1). */
export function bandOf(position: number, binBps: number): number {
  return Number.parseInt(floorDiv(BigInt(position), BigInt(binBps)).toString(), 10);
}

/** Where a client price sits against the reference, in whole basis points (floored): positive is worse for the client. */
export function positionBps(direction: Direction, clientRateMicro: bigint, referenceMicro: bigint): number {
  const delta = direction === 'BUY_USDT' ? clientRateMicro - referenceMicro : referenceMicro - clientRateMicro;
  const bps = floorDiv(delta * 10_000n, referenceMicro);
  if (bps > 1_000_000n || bps < -1_000_000n) throw new DomainError('INVALID_RATE', 'the price is too far from the market reference');
  return Number.parseInt(bps.toString(), 10);
}

/**
 * The worst price the client may be given: the reference moved by the policy's premium, onto the grid on the client's
 * side (a buyer's cap rounded down, a seller's up) — never past what the database allows (IX139).
 */
export function capRate(direction: Direction, referenceMicro: bigint, maxPremiumBps: number): bigint {
  const prem = BigInt(maxPremiumBps);
  if (direction === 'BUY_USDT') {
    const bound = (referenceMicro * (10_000n + prem)) / 10_000n;
    return (bound / PRICE_STEP_MICRO) * PRICE_STEP_MICRO;
  }
  const bound = divRound(referenceMicro * (10_000n - prem), 10_000n, 'UP');
  return divRound(bound, PRICE_STEP_MICRO, 'UP') * PRICE_STEP_MICRO;
}

/** The client's USDT by order of magnitude — under 1,000 · 10,000 · 100,000 · above — the size bands acceptance is learned in. */
export function sizeBand(baseMinor: bigint): number {
  if (baseMinor < 1_000_000_000n) return 0;
  if (baseMinor < 10_000_000_000n) return 1;
  if (baseMinor < 100_000_000_000n) return 2;
  return 3;
}

/** The deal's USDT for its size band: exact when USDT is fixed, at the reference when rupees are. */
export function approximateBase(fixedSide: FixedSide, amountMinor: bigint, referenceMicro: bigint): bigint {
  return fixedSide === 'BASE' ? amountMinor : (amountMinor * SCALE) / referenceMicro;
}

/**
 * Acceptance per price band, in parts per million: the band's own count shrunk towards its direction's (itself a
 * Laplace estimate), then made non-increasing as the price gets worse for the client — weighted by how much each band
 * knows. Bands in `bins` without any evidence get the prior.
 */
export function acceptanceByBand(evidence: AcceptanceEvidence, bins: readonly number[]): Map<number, bigint> {
  const all = [...new Set([...bins, ...evidence.band.keys(), ...evidence.direction.keys()])].sort((a, b) => a - b);
  const blocks: { bins: number[]; sum: bigint; weight: bigint }[] = [];
  for (const b of all) {
    const dir = evidence.direction.get(b) ?? { accepted: 0, declined: 0 };
    const own = evidence.band.get(b) ?? { accepted: 0, declined: 0 };
    const pDir = (BigInt(dir.accepted) * PPM + PPM) / BigInt(dir.accepted + dir.declined + 2);
    const n = BigInt(own.accepted + own.declined);
    const weight = n + 2n;
    // Σ w·p for this band alone: (a·10⁶ + 2·p_dir) — its estimate times its weight.
    blocks.push({ bins: [b], sum: BigInt(own.accepted) * PPM + 2n * pDir, weight });
    // A worse price (higher band) must not look likelier to be accepted than a better one: pool until it does not.
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1]!;
      const prev = blocks[blocks.length - 2]!;
      if (prev.sum * last.weight >= last.sum * prev.weight) break;
      blocks.splice(blocks.length - 2, 2, { bins: [...prev.bins, ...last.bins], sum: prev.sum + last.sum, weight: prev.weight + last.weight });
    }
  }
  const out = new Map<number, bigint>();
  for (const block of blocks) for (const b of block.bins) out.set(b, block.sum / block.weight);
  return out;
}

interface Scored {
  readonly baseMinor: bigint;
  readonly inrMinor: bigint;
  readonly routeBaseMinor: bigint;
  readonly grossMinor: bigint;
}

/**
 * The P2P economics of one price against one rate, in bare integers — the same formulas and roundings as the kernel's
 * `computeP2pEconomics` (FINANCIAL_INVARIANTS §1.2), without its objects, because every grid price is weighed against every
 * offer. The chosen one is recomputed by the kernel and must agree (`choose` refuses otherwise).
 */
function score(direction: Direction, fixedSide: FixedSide, amountMinor: bigint, clientRateMicro: bigint, rateMicro: bigint): Scored | null {
  const buy = direction === 'BUY_USDT';
  let base: bigint;
  let inr: bigint;
  if (fixedSide === 'BASE') {
    base = amountMinor;
    inr = divRound(base * clientRateMicro, SCALE, buy ? 'UP' : 'DOWN');
  } else {
    inr = amountMinor;
    base = divRound(inr * SCALE, clientRateMicro, buy ? 'DOWN' : 'UP');
  }
  const routeBase = divRound(inr * SCALE, rateMicro, buy ? 'UP' : 'DOWN');
  if (base <= 0n || inr <= 0n || routeBase <= 0n) return null;
  return { baseMinor: base, inrMinor: inr, routeBaseMinor: routeBase, grossMinor: buy ? routeBase - base : base - routeBase };
}

/** What a trader's capacity holds for the deal: the rupees it pays when it buys USDT, the USDT it delivers when it sells. */
const capacityOf = (direction: Direction, s: Scored): bigint => (direction === 'SELL_USDT' ? s.inrMinor : s.routeBaseMinor);

const fits = (offer: PricedOffer, direction: Direction, s: Scored): boolean => {
  const amount = capacityOf(direction, s);
  return (offer.minMinor === null || amount >= offer.minMinor) && (offer.maxMinor === null || amount <= offer.maxMinor) && amount <= offer.freeMinor
    && (offer.maxBaseMinor === undefined || offer.maxBaseMinor === null || s.routeBaseMinor <= offer.maxBaseMinor);
};

/** The policy's rupee minimum in USDT at a price's own rate, rounded up (as `priceNetworkP2p` and IX103 value it). */
const minNetAt = (minNetInrMinor: bigint, clientRateMicro: bigint): bigint => inrToUsdt(Money.ofMinor(minNetInrMinor, 'INR'), Rate.ofMicro(clientRateMicro, 'CLIENT'), 'UP').minor;

/**
 * The price and the offer with the highest expected net margin, or why there is none. Deterministic: equal expectations go
 * to the price better for the client, then to the likelier trader, then to the lower trader reference.
 */
export function choosePrice(input: PricingInput): PricingOutcome {
  const { direction, fixedSide, amountMinor, referenceMicro } = input;
  if (amountMinor <= 0n) throw new DomainError('INVALID_AMOUNT', 'amount must be positive');
  if (referenceMicro <= 0n) throw new DomainError('INVALID_RATE', 'the market reference must be positive');
  if (!Number.isInteger(input.binBps) || input.binBps < 1) throw new DomainError('INVALID_ARGUMENT', 'price bands are whole basis points');
  const buy = direction === 'BUY_USDT';
  const cap = capRate(direction, referenceMicro, input.maxPremiumBps);
  const offers = input.offers.filter((o) => o.rateMicro > 0n && o.completionPpm > 0n);
  if (offers.length === 0) return { kind: 'NONE', reason: 'NO_OFFER', capRateMicro: cap };

  // The grid from the cap towards the client's side, as far as any offer could still leave a margin — a buyer's price
  // must stay above the lowest rate, a seller's below the highest.
  const prices: bigint[] = [];
  if (buy) {
    const floorRate = offers.reduce((m, o) => (o.rateMicro < m ? o.rateMicro : m), offers[0]!.rateMicro);
    for (let c = cap; c > floorRate && prices.length < MAX_PRICE_POINTS; c -= PRICE_STEP_MICRO) prices.push(c);
  } else {
    const ceilRate = offers.reduce((m, o) => (o.rateMicro > m ? o.rateMicro : m), offers[0]!.rateMicro);
    for (let c = cap; c < ceilRate && prices.length < MAX_PRICE_POINTS; c += PRICE_STEP_MICRO) prices.push(c);
  }

  const bins = prices.map((c) => bandOf(positionBps(direction, c, referenceMicro), input.binBps));
  const acceptance = acceptanceByBand(input.evidence, bins);
  const viable = new Set<string>();
  let best: { c: bigint; offer: PricedOffer; s: Scored; net: bigint; minNet: bigint; value: bigint; pos: number; bin: number; acc: bigint } | null = null;

  for (let i = 0; i < prices.length; i += 1) {
    const c = prices[i]!;
    const bin = bins[i]!;
    const acc = acceptance.get(bin)!;
    const minNet = minNetAt(input.minNetMarginInrMinor, c);
    const pos = positionBps(direction, c, referenceMicro);
    for (const offer of offers) {
      const s = score(direction, fixedSide, amountMinor, c, offer.rateMicro);
      if (!s || !fits(offer, direction, s)) continue;
      const net = s.grossMinor - input.networkAllowanceMinor;
      if (net < minNet || net < 0n) continue;
      viable.add(offer.id);
      const value = acc * offer.completionPpm * net;
      const better = !best
        || value > best.value
        || (value === best.value && (pos < best.pos || (pos === best.pos && (offer.completionPpm > best.offer.completionPpm || (offer.completionPpm === best.offer.completionPpm && offer.ref < best.offer.ref)))));
      if (better) best = { c, offer, s, net, minNet, value, pos, bin, acc };
    }
  }
  if (!best) return { kind: 'NONE', reason: offers.some((o) => sizeAtAll(input, o)) ? 'NOT_COMPETITIVE' : 'NO_OFFER', capRateMicro: cap };

  const clientRate = Rate.ofMicro(best.c, 'CLIENT');
  const routeRate = Rate.ofMicro(best.offer.rateMicro, 'ROUTE');
  const econ = fixedSide === 'BASE'
    ? computeP2pEconomics({ direction, fixedSide: 'BASE', amount: Money.ofMinor(amountMinor, 'USDT'), clientRate, routeRate })
    : computeP2pEconomics({ direction, fixedSide: 'QUOTE', amount: Money.ofMinor(amountMinor, 'INR'), clientRate, routeRate });
  if (econ.base.minor !== best.s.baseMinor || econ.clientInr.minor !== best.s.inrMinor || econ.routeBase.minor !== best.s.routeBaseMinor) {
    throw new DomainError('INVALID_ARGUMENT', 'automatic pricing disagrees with the kernel economics');
  }
  return {
    kind: 'PRICED',
    choice: {
      clientRateMicro: best.c, offer: best.offer, econ, capacityMinor: capacityOf(direction, best.s), netMarginMinor: best.net, minNetMarginMinor: best.minNet,
      positionBps: best.pos, bin: best.bin, acceptancePpm: best.acc, capRateMicro: cap, expectedNetMinor: best.value / (PPM * PPM), viableOffers: viable.size,
    },
  };
}

/** Whether an offer takes this amount at its own rate, whatever the client's price — to tell "nobody can" from "nobody can here". */
function sizeAtAll(input: PricingInput, offer: PricedOffer): boolean {
  const s = score(input.direction, input.fixedSide, input.amountMinor, offer.rateMicro, offer.rateMicro);
  return s !== null && fits(offer, input.direction, s);
}
