import { describe, expect, it } from 'vitest';
import { draftFor } from '../src/index.ts';

/** What the database refuses in a client-facing message (migration 0017): the desk's own vocabulary. */
const INTERNAL = /(route|margin|spread|provider|custody|dealer|obligation|liquidity|suspense)/i;

/**
 * A UPI ID's messages once the one who pays it checks it (ADR 0030): live when added — with the first deals' limit said
 * plainly — and paused, with what happens to the deal, when a payer's app showed another name.
 */
describe('a UPI ID’s messages', () => {
  it('a client’s own is ready at once, and says how much it takes until a deal confirms it', () => {
    const d = draftFor('DESTINATION_ADDED', { label: 'UPI ID ka••••@okhdfcbank', upiConfirmed: false });
    expect(d.title).toBe('A UPI ID was added');
    expect(d.body).toContain('is ready');
    expect(d.body).toContain('₹25,000');
    expect(d.body).toContain('If you did not add it, tell the desk straight away.');
    expect(d.href).toBe('/destinations');
  });

  it('one the desk looked up has no first deals’ limit to mention', () => {
    const d = draftFor('DESTINATION_ADDED', { label: 'UPI ID ra••••@okaxis', upiConfirmed: true });
    expect(d.body).not.toContain('₹25,000');
    expect(d.body).toContain('is ready');
  });

  it('a bank account keeps its own words', () => {
    expect(draftFor('DESTINATION_ADDED', { label: 'HDFC Bank ••1234' }).title).toBe('A bank account or wallet was added');
  });

  it('a paused one says why, that nothing more is paid to it, and that the deal goes on by bank transfer', () => {
    const own = draftFor('DESTINATION_PAUSED', { label: 'UPI ID ka••••@okhdfcbank', tradeRef: 'TR-261114-0042' });
    expect(own.title).toBe('Your UPI ID is paused');
    expect(own.body).toContain('a different name for UPI ID ka••••@okhdfcbank on TR-261114-0042');
    expect(own.body).toContain('Nothing more is paid to it');
    expect(own.body).toContain('bank transfer');
    expect(own).toMatchObject({ href: '/destinations', subjectRef: 'TR-261114-0042' });
    // A trader is not given the client's trade reference: the message stands without one.
    const trader = draftFor('DESTINATION_PAUSED', { label: 'UPI ID ka••••@okhdfcbank' });
    expect(trader.body).not.toMatch(/ on TR-/);
    expect(trader.subjectRef).toBeNull();
    for (const m of [own, trader]) expect(`${m.title} ${m.body}`).not.toMatch(INTERNAL);
  });
});
