import { describe, expect, it } from 'vitest';
import { marketEstimate } from '../src/app/(public)/_landing/estimate.ts';
import { HERO } from '../src/content/site.ts';

describe('the home page converter’s market estimate (ADR 0025 reference)', () => {
  it('is the amount at the market’s rate, to the nearest rupee, grouped, with the rate to the paisa', () => {
    expect(marketEstimate('100000', '88.400000')).toEqual({ rupees: '8,840,000', rate: '88.40' });
    expect(marketEstimate('2500.5', '88.437500')).toEqual({ rupees: '221,138', rate: '88.43' });
    expect(marketEstimate('0.000001', '88.400000')).toEqual({ rupees: '0', rate: '88.40' });
  });

  it('is nothing without an amount or a rate — the words stand in for it', () => {
    expect(marketEstimate('', '88.400000')).toBeNull();
    expect(marketEstimate('0', '88.400000')).toBeNull();
    expect(marketEstimate('100000', null)).toBeNull();
    expect(marketEstimate('100000', 'not a rate')).toBeNull();
  });

  it('names the market as the source and says the firm price comes next, in words only', () => {
    expect(HERO.quote.market).toContain('{rate}');
    expect(HERO.quote.market).not.toMatch(/\d/);
  });
});
