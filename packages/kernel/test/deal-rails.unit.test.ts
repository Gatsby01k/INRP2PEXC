import { describe, expect, it } from 'vitest';
import { RAIL_NOT_TAKEN, railOptions, railOptionsFor, railsOverlap } from '../src/index.ts';

const paise = (rupees: number) => BigInt(rupees) * 100n;
const possible = (options: ReturnType<typeof railOptionsFor>) => options.filter((o) => o.possible).map((o) => o.rail);

/**
 * The rails of one deal (launch audit 2026-11-10): what the amount allows, among what its trader's side uses. Before, the
 * amount alone decided — a trader's "Clients pay you by" was saved and never read.
 */
describe('railOptionsFor', () => {
  it('is the amount’s own rails when nothing is known of the deal’s side', () => {
    expect(railOptionsFor(paise(74_550), null)).toEqual(railOptions(paise(74_550)));
  });

  it('offers only what the side uses, best first, and says why the rest are not offered', () => {
    const options = railOptionsFor(paise(74_550), ['IMPS', 'NEFT']);
    expect(possible(options)).toEqual(['IMPS', 'NEFT']);
    expect(options.find((o) => o.rail === 'UPI')).toEqual({ rail: 'UPI', possible: false, limit: RAIL_NOT_TAKEN });
    // A rail the amount itself rules out keeps the network's own reason.
    expect(options.find((o) => o.rail === 'RTGS')).toEqual({ rail: 'RTGS', possible: false, limit: 'RTGS starts at ₹2,00,000' });
    // The suggested way is the first of them.
    expect(options[0]!.rail).toBe('IMPS');
  });

  it('keeps the amount’s order among the side’s rails', () => {
    expect(possible(railOptionsFor(paise(74_550), ['RTGS', 'NEFT', 'IMPS', 'UPI']))).toEqual(['UPI', 'IMPS', 'NEFT']);
    expect(possible(railOptionsFor(paise(300_000), ['NEFT', 'RTGS']))).toEqual(['RTGS', 'NEFT']);
    expect(possible(railOptionsFor(paise(900_000), ['UPI', 'IMPS', 'NEFT']))).toEqual(['NEFT']);
  });

  it('never leaves a deal with no way to pay: when nothing the side uses can carry the amount, the amount decides', () => {
    // UPI only, ₹3 lakh: matching keeps such a deal from opening; one opened by hand is still payable.
    expect(railOptionsFor(paise(300_000), ['UPI'])).toEqual(railOptions(paise(300_000)));
    expect(railOptionsFor(paise(74_550), [])).toEqual(railOptions(paise(74_550)));
  });
});

describe('railsOverlap', () => {
  it('says whether one of the rails can carry the amount', () => {
    expect(railsOverlap(paise(74_550), ['UPI'])).toBe(true);
    expect(railsOverlap(paise(100_001), ['UPI'])).toBe(false);
    expect(railsOverlap(paise(600_000), ['UPI', 'IMPS'])).toBe(false);
    expect(railsOverlap(paise(600_000), ['UPI', 'IMPS', 'RTGS'])).toBe(true);
    expect(railsOverlap(paise(150_000), ['RTGS'])).toBe(false);
    expect(railsOverlap(paise(150_000), [])).toBe(false);
  });
});
