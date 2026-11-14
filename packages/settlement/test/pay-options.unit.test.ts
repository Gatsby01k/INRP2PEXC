import { describe, expect, it } from 'vitest';
import { RAIL_NOT_TAKEN, railOptions } from '@inrp2p/kernel';
import { RAIL_NO_UPI_ID, dealPayOptions } from '../src/p2p-timing.ts';

const paise = (rupees: number) => BigInt(rupees) * 100n;
const possible = (o: ReturnType<typeof dealPayOptions>) => o.filter((x) => x.possible).map((x) => x.rail);

/**
 * A deal's ways to pay (ADR 0029): what its amount allows, among what its trader's side uses — and UPI only when the payee
 * has a verified UPI ID that can take it. There is no UPI address but a registered one.
 */
describe('dealPayOptions', () => {
  it('offers UPI first, by the amount, when the payee has a verified UPI ID', () => {
    expect(possible(dealPayOptions(paise(74_550), null, true))).toEqual(['UPI', 'IMPS', 'NEFT']);
    expect(dealPayOptions(paise(74_550), null, true)).toEqual(railOptions(paise(74_550)));
  });

  it('takes UPI off — and says why — when nobody has a verified UPI ID to be paid to', () => {
    const options = dealPayOptions(paise(74_550), null, false);
    expect(possible(options)).toEqual(['IMPS', 'NEFT']);
    expect(options.find((o) => o.rail === 'UPI')).toEqual({ rail: 'UPI', possible: false, limit: RAIL_NO_UPI_ID });
  });

  it('keeps the side’s own refusal when it does not take UPI at all', () => {
    expect(dealPayOptions(paise(74_550), ['IMPS', 'NEFT'], true).find((o) => o.rail === 'UPI')).toEqual({ rail: 'UPI', possible: false, limit: RAIL_NOT_TAKEN });
  });

  it('never leaves a deal with no way to pay: a side that takes UPI only, with no UPI ID, is paid by bank transfer', () => {
    expect(possible(dealPayOptions(paise(74_550), ['UPI'], false))).toEqual(['IMPS', 'NEFT']);
  });

  it('above UPI’s ₹1 lakh, a UPI ID changes nothing', () => {
    expect(dealPayOptions(paise(150_000), null, true)).toEqual(railOptions(paise(150_000)));
    expect(dealPayOptions(paise(150_000), null, false)).toEqual(railOptions(paise(150_000)));
  });
});
