import { describe, expect, it } from 'vitest';
import { DEFAULT_P2P_TIMING, Money, accountUpiAddress, checkIfsc, railOptions, requireP2pTiming, suggestedRail, upiPayUri } from '../src/index.ts';

const paise = (rupees: string) => Money.parse(rupees, 'INR').minor;

describe('which rail suits a P2P payment (ADR 0023)', () => {
  it.each([
    ['1.00', 'UPI'],
    ['100000.00', 'UPI'],
    ['100000.01', 'IMPS'],
    ['199999.99', 'IMPS'],
    ['200000.00', 'IMPS'],
    ['500000.00', 'IMPS'],
    ['500000.01', 'RTGS'],
    ['25000000.00', 'RTGS'],
  ])('₹%s goes by %s first', (amount, rail) => {
    expect(suggestedRail(paise(amount))).toBe(rail);
  });

  it('lists every rail, the possible ones first, and says why the others are not', () => {
    expect(railOptions(paise('74550.00')).map((o) => [o.rail, o.possible])).toEqual([['UPI', true], ['IMPS', true], ['NEFT', true], ['RTGS', false]]);
    expect(railOptions(paise('150000.00')).map((o) => [o.rail, o.possible])).toEqual([['IMPS', true], ['NEFT', true], ['RTGS', false], ['UPI', false]]);
    expect(railOptions(paise('300000.00')).map((o) => [o.rail, o.possible])).toEqual([['IMPS', true], ['RTGS', true], ['NEFT', true], ['UPI', false]]);
    expect(railOptions(paise('900000.00')).map((o) => [o.rail, o.possible])).toEqual([['RTGS', true], ['NEFT', true], ['IMPS', false], ['UPI', false]]);
    expect(railOptions(paise('900000.00')).find((o) => o.rail === 'IMPS')!.limit).toMatch(/₹5,00,000/);
    expect(railOptions(paise('74550.00')).find((o) => o.rail === 'RTGS')!.limit).toMatch(/starts at ₹2,00,000/);
    // NEFT has no upper limit: it is always possible.
    for (const amount of ['1.00', '99999999.00']) expect(railOptions(paise(amount)).find((o) => o.rail === 'NEFT')!.possible).toBe(true);
  });

  it('agrees with the database’s own default rail', () => {
    // inrp2p_p2p_default_rail: ≤ 1,00,00,000 paise UPI, ≤ 5,00,00,000 IMPS, else RTGS.
    expect([10_000_000n, 10_000_001n, 50_000_000n, 50_000_001n].map(suggestedRail)).toEqual(['UPI', 'IMPS', 'IMPS', 'RTGS']);
  });
});

describe('IFSC', () => {
  it('takes RBI’s shape, whatever the spacing or case', () => {
    expect(checkIfsc(' hdfc0001234 ')).toEqual({ ok: true, ifsc: 'HDFC0001234', bank: 'HDFC', branch: '001234' });
  });
  it.each([
    ['HDFC001234', '11 characters'],
    ['HD1C0001234', 'four letters'],
    ['HDFC1001234', 'fifth character'],
    ['HDFC0-01234', 'letters and digits'],
  ])('refuses %s and says what is wrong', (raw, hint) => {
    const out = checkIfsc(raw);
    expect(out.ok).toBe(false);
    expect(out.ok ? '' : out.hint).toContain(hint);
  });
});

describe('the UPI address of a bank account', () => {
  it('is NPCI’s account-and-IFSC address, which every UPI app pays into that account', () => {
    expect(accountUpiAddress('5010 0123 4582 19', 'HDFC0001234')).toBe('50100123458219@hdfc0001234.ifsc.npci');
  });
  it('makes a upi://pay link with the exact amount', () => {
    const link = upiPayUri({ vpa: accountUpiAddress('50100123458219', 'HDFC0001234'), payeeName: 'USDT Seller LLP', amount: '74550', note: 'INRP2P TO-000123-0001' });
    expect(link).toBe('upi://pay?pa=50100123458219%40hdfc0001234.ifsc.npci&pn=USDT%20Seller%20LLP&am=74550.00&cu=INR&tn=INRP2P%20TO-000123-0001');
  });
  it('refuses what is not an account or an IFSC', () => {
    expect(() => accountUpiAddress('12ab', 'HDFC0001234')).toThrow();
    expect(() => accountUpiAddress('50100123458219', 'HDFC1001234')).toThrow();
  });
});

describe('P2P deal timing', () => {
  it('starts from UPI 15, IMPS 30, NEFT 60, RTGS 45 — and longer to confirm NEFT and RTGS', () => {
    expect(DEFAULT_P2P_TIMING.pay).toEqual({ UPI: 15, IMPS: 30, NEFT: 60, RTGS: 45 });
    expect(DEFAULT_P2P_TIMING.receipt.NEFT).toBeGreaterThan(DEFAULT_P2P_TIMING.receipt.IMPS);
    expect(DEFAULT_P2P_TIMING.receipt.RTGS).toBeGreaterThan(DEFAULT_P2P_TIMING.receipt.UPI);
    expect(requireP2pTiming(JSON.parse(JSON.stringify(DEFAULT_P2P_TIMING)))).toEqual(DEFAULT_P2P_TIMING);
  });
  it.each([
    [{ ...DEFAULT_P2P_TIMING, finalMinutes: 0 }, 'finalMinutes'],
    [{ ...DEFAULT_P2P_TIMING, pay: { ...DEFAULT_P2P_TIMING.pay, NEFT: 600 } }, 'pay.NEFT'],
    [{ ...DEFAULT_P2P_TIMING, receipt: { UPI: 30 } }, 'receipt.IMPS'],
    [{ ...DEFAULT_P2P_TIMING, escrowMinutes: 12.5 }, 'escrowMinutes'],
    [null, 'p2pTiming'],
  ])('refuses %o at %s', (value, field) => {
    expect(() => requireP2pTiming(value)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT', details: expect.objectContaining({ field: expect.stringContaining(field) }) }));
  });
});
