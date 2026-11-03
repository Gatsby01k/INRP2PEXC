import { describe, expect, it } from 'vitest';
import { Money, Rate, computeP2pEconomics, inrToUsdt, isDomainError } from '@inrp2p/kernel';
import {
  type AcceptanceEvidence, type PricedOffer, type PricingInput, type Tally, MAX_PRICE_POINTS, PRICE_STEP_MICRO, acceptanceByBand, approximateBase, bandOf, capRate, choosePrice, floorDiv,
  positionBps, sizeBand,
} from '../src/index.ts';

const r = (decimal: string) => Rate.parse(decimal, 'ROUTE').micro;
const usdt = (decimal: string) => Money.parse(decimal, 'USDT').minor;
const inr = (decimal: string) => Money.parse(decimal, 'INR').minor;
const NONE: AcceptanceEvidence = { band: new Map(), direction: new Map() };
const PPM = 1_000_000n;

const offer = (id: string, rate: string, o: Partial<Omit<PricedOffer, 'id' | 'rateMicro'>> = {}): PricedOffer => ({
  id, ref: o.ref ?? `TR-${id}`, rateMicro: r(rate), minMinor: o.minMinor ?? null, maxMinor: o.maxMinor ?? null, freeMinor: o.freeMinor ?? 10n ** 15n, completionPpm: o.completionPpm ?? 900_000n,
});

const input = (over: Partial<PricingInput>): PricingInput => ({
  direction: 'BUY_USDT', fixedSide: 'BASE', amountMinor: usdt('1000'), offers: [], referenceMicro: r('100'), maxPremiumBps: 0, binBps: 10,
  networkAllowanceMinor: usdt('4.5'), minNetMarginInrMinor: inr('100'), evidence: NONE, ...over,
});

const priced = (i: PricingInput) => {
  const out = choosePrice(i);
  if (out.kind !== 'PRICED') throw new Error(`expected a price, got ${out.reason}`);
  return out.choice;
};

describe('the automatic price of a client buying USDT', () => {
  it('with no evidence, sits at the market and goes to the trader that leaves the most', () => {
    const c = priced(input({ offers: [offer('a', '98'), offer('b', '98.5')] }));
    expect(Rate.ofMicro(c.clientRateMicro, 'CLIENT').toDecimalString()).toBe('100.000000');
    expect(c.offer.id).toBe('a');
    // ₹100,000 for 1,000 USDT; the trader delivers ₹100,000 / 98, rounded up; INRP2P keeps the rest less the network.
    expect(c.econ.base.minor).toBe(usdt('1000'));
    expect(c.econ.clientInr.minor).toBe(inr('100000'));
    expect(c.econ.routeBase.minor).toBe(usdt('1020.408164'));
    expect(c.econ.grossMarginBase.minor).toBe(usdt('20.408164'));
    expect(c.netMarginMinor).toBe(usdt('15.908164'));
    expect(c.positionBps).toBe(0);
    expect(c.viableOffers).toBe(2);
  });

  it('never asks more than the market reference moved by the premium', () => {
    const c = priced(input({ offers: [offer('a', '90')], maxPremiumBps: 50 }));
    expect(c.clientRateMicro).toBe(r('100.5'));
    expect(c.capRateMicro).toBe(r('100.5'));
    expect(c.positionBps).toBe(50);
  });

  it('is the kernel’s own P2P economics, to the micro-USDT', () => {
    const c = priced(input({ fixedSide: 'QUOTE', amountMinor: inr('250000.37'), offers: [offer('a', '98.37')] }));
    const k = computeP2pEconomics({ direction: 'BUY_USDT', fixedSide: 'QUOTE', amount: Money.ofMinor(inr('250000.37'), 'INR'), clientRate: Rate.ofMicro(c.clientRateMicro, 'CLIENT'), routeRate: Rate.ofMicro(r('98.37'), 'ROUTE') });
    expect(c.econ.base.minor).toBe(k.base.minor);
    expect(c.econ.routeBase.minor).toBe(k.routeBase.minor);
    expect(c.netMarginMinor).toBe(k.grossMarginBase.minor - usdt('4.5'));
  });
});

describe('the automatic price of a client selling USDT', () => {
  it('pays at least the market and goes to the trader paying the most', () => {
    const c = priced(input({ direction: 'SELL_USDT', offers: [offer('a', '101.5'), offer('b', '102')] }));
    expect(c.clientRateMicro).toBe(r('100'));
    expect(c.offer.id).toBe('b');
    // The client sends 1,000 USDT and receives ₹100,000; the trader pays those rupees and receives ₹100,000 / 102 of USDT.
    expect(c.econ.clientInr.minor).toBe(inr('100000'));
    expect(c.econ.routeBase.minor).toBe(usdt('980.392156'));
    expect(c.netMarginMinor).toBe(usdt('1000') - usdt('980.392156') - usdt('4.5'));
  });

  it('never pays the client less than the market reference moved by the premium', () => {
    const c = priced(input({ direction: 'SELL_USDT', offers: [offer('a', '110')], maxPremiumBps: 25 }));
    expect(c.clientRateMicro).toBe(r('99.75'));
    expect(c.clientRateMicro).toBeGreaterThanOrEqual(capRate('SELL_USDT', r('100'), 25));
  });

  it('holds the trader’s rupees against its capacity: a trader buying USDT pays the client’s rupees', () => {
    const c = priced(input({ direction: 'SELL_USDT', offers: [offer('a', '102', { maxMinor: inr('99999.99') }), offer('b', '101')] }));
    expect(c.offer.id).toBe('b');
    expect(c.capacityMinor).toBe(inr('100000'));
  });
});

describe('what the price never does', () => {
  it('never leaves less than the minimum net margin, so never a negative one: nobody competitive is no price', () => {
    const out = choosePrice(input({ offers: [offer('a', '99.95')] }));
    expect(out).toMatchObject({ kind: 'NONE', reason: 'NOT_COMPETITIVE' });
    const sell = choosePrice(input({ direction: 'SELL_USDT', offers: [offer('a', '100.02')] }));
    expect(sell).toMatchObject({ kind: 'NONE', reason: 'NOT_COMPETITIVE' });
  });

  it('every price it gives leaves at least the minimum at that price’s own rate', () => {
    for (const rate of ['99.2', '99.5', '99.8', '98', '95']) {
      const out = choosePrice(input({ offers: [offer('a', rate)] }));
      if (out.kind !== 'PRICED') continue;
      const min = inrToUsdt(Money.ofMinor(inr('100'), 'INR'), Rate.ofMicro(out.choice.clientRateMicro, 'CLIENT'), 'UP').minor;
      expect(out.choice.netMarginMinor).toBeGreaterThanOrEqual(min);
      expect(out.choice.minNetMarginMinor).toBe(min);
      expect(out.choice.clientRateMicro).toBeLessThanOrEqual(r('100'));
    }
  });

  it('is no price when no offer can take the amount — too small, too large or more than it has free', () => {
    expect(choosePrice(input({ offers: [] }))).toMatchObject({ kind: 'NONE', reason: 'NO_OFFER' });
    expect(choosePrice(input({ offers: [offer('a', '98', { minMinor: usdt('5000') })] }))).toMatchObject({ kind: 'NONE', reason: 'NO_OFFER' });
    expect(choosePrice(input({ offers: [offer('a', '98', { maxMinor: usdt('500') })] }))).toMatchObject({ kind: 'NONE', reason: 'NO_OFFER' });
    expect(choosePrice(input({ offers: [offer('a', '98', { freeMinor: usdt('900') })] }))).toMatchObject({ kind: 'NONE', reason: 'NO_OFFER' });
  });

  it('picks a lower price the capacity of the best trader still takes, rather than a price it cannot', () => {
    // At ₹100 the trader would deliver 1,020.41 USDT; with 1,015 free it takes the deal only near ₹99.47 or below.
    const c = priced(input({ offers: [offer('a', '98', { freeMinor: usdt('1015') })] }));
    expect(c.capacityMinor).toBeLessThanOrEqual(usdt('1015'));
    expect(c.clientRateMicro).toBeLessThan(r('100'));
  });
});

describe('competition between traders', () => {
  it('weighs a trader’s rate by how reliably it completes: a better rate from an unreliable trader can lose', () => {
    const c = priced(input({ amountMinor: usdt('10000'), offers: [offer('shaky', '98', { completionPpm: 500_000n }), offer('steady', '98.5', { completionPpm: 990_000n })] }));
    expect(c.offer.id).toBe('steady');
  });

  it('and a much better rate still wins against a slightly more reliable trader', () => {
    const c = priced(input({ amountMinor: usdt('10000'), offers: [offer('cheap', '97', { completionPpm: 900_000n }), offer('steady', '98.5', { completionPpm: 950_000n })] }));
    expect(c.offer.id).toBe('cheap');
  });

  it('chooses the same way every time between equals: the lower trader reference', () => {
    const offers = [offer('x', '98', { ref: 'TR-0002' }), offer('y', '98', { ref: 'TR-0001' })];
    expect(priced(input({ offers })).offer.id).toBe('y');
    expect(priced(input({ offers: [...offers].reverse() })).offer.id).toBe('y');
  });
});

describe('learning from what clients accepted', () => {
  const tally = (accepted: number, declined: number): Tally => ({ accepted, declined });

  it('moves the price below the market when clients keep declining it there', () => {
    const declinedAtMarket: AcceptanceEvidence = { band: new Map([[0, tally(0, 30)]]), direction: new Map([[0, tally(0, 30)]]) };
    const c = priced(input({ offers: [offer('a', '98')], evidence: declinedAtMarket }));
    expect(c.positionBps).toBeLessThan(0);
    expect(c.bin).toBeLessThan(0);
  });

  it('stays at the market while clients accept it there', () => {
    const acceptedAtMarket: AcceptanceEvidence = { band: new Map([[0, tally(40, 2)]]), direction: new Map([[0, tally(40, 2)]]) };
    expect(priced(input({ offers: [offer('a', '98')], evidence: acceptedAtMarket })).positionBps).toBe(0);
  });

  it('never believes a worse price is likelier to be accepted than a better one', () => {
    const odd: AcceptanceEvidence = { band: new Map([[-2, tally(1, 9)], [0, tally(9, 1)]]), direction: new Map([[-2, tally(1, 9)], [0, tally(9, 1)]]) };
    const acc = acceptanceByBand(odd, [-3, -2, -1, 0]);
    const bands = [...acc.keys()].sort((a, b) => a - b);
    for (let i = 1; i < bands.length; i += 1) expect(acc.get(bands[i - 1]!)!).toBeGreaterThanOrEqual(acc.get(bands[i]!)!);
  });

  it('is even odds with no evidence at all, and leans a thin size band on its direction', () => {
    expect(acceptanceByBand(NONE, [0]).get(0)).toBe(PPM / 2n);
    const dir: AcceptanceEvidence = { band: new Map(), direction: new Map([[0, tally(98, 0)]]) };
    expect(acceptanceByBand(dir, [0]).get(0)!).toBeGreaterThan(950_000n);
  });
});

describe('the arithmetic it stands on', () => {
  it('floors divisions and positions towards minus infinity', () => {
    expect(floorDiv(-1n, 10n)).toBe(-1n);
    expect(floorDiv(-10n, 10n)).toBe(-1n);
    expect(floorDiv(9n, 10n)).toBe(0n);
    expect(bandOf(-1, 10)).toBe(-1);
    expect(bandOf(9, 10)).toBe(0);
    expect(positionBps('BUY_USDT', r('99.99'), r('100'))).toBe(-1);
    expect(positionBps('SELL_USDT', r('99.99'), r('100'))).toBe(1);
  });

  it('puts the cap on the paisa grid on the client’s side', () => {
    expect(capRate('BUY_USDT', r('101.865'), 0)).toBe(r('101.86'));
    expect(capRate('SELL_USDT', r('101.315'), 0)).toBe(r('101.32'));
    expect(capRate('BUY_USDT', r('100'), 0) % PRICE_STEP_MICRO).toBe(0n);
  });

  it('bands deals by the client’s USDT, approximating rupees at the reference', () => {
    expect(sizeBand(usdt('999.99'))).toBe(0);
    expect(sizeBand(usdt('1000'))).toBe(1);
    expect(sizeBand(usdt('250000'))).toBe(3);
    expect(approximateBase('QUOTE', inr('100000'), r('100'))).toBe(usdt('1000'));
  });

  it('weighs a bounded number of prices even when a rate is far from the market', () => {
    const c = priced(input({ offers: [offer('a', '1')] }));
    expect(c.clientRateMicro).toBe(r('100'));
    expect(MAX_PRICE_POINTS).toBeGreaterThan(1000);
  });

  it('refuses nonsense inputs', () => {
    expect(() => choosePrice(input({ amountMinor: 0n }))).toThrow();
    try {
      choosePrice(input({ referenceMicro: 0n }));
    } catch (e) {
      expect(isDomainError(e, 'INVALID_RATE')).toBe(true);
    }
  });
});
