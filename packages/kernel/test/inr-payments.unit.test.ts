import { describe, expect, it } from 'vitest';
import { checkUtrShape, judgeSender, matchNames, nameTokens, normalizeVpa, railsForUtr, requireUtrShape, upiPayUri } from '../src/index.ts';

describe('matching the sender of a payment to the account holder', () => {
  const holder = 'Rahul Kumar Sharma';

  it.each([
    ['RAHUL KUMAR SHARMA', 'the same name'],
    ['SHARMA RAHUL KUMAR', 'another order'],
    ['RAHUL K SHARMA', 'a middle initial'],
    ['Mr. Rahul Kumar Sharma', 'a title'],
    ['RAHUL KUMAR SHA', 'a narration cut at a fixed width'],
    ['RAHUL SHARMA', 'a middle name left out'],
    ['RAHUL KUMAAR SHARMA', 'a spelling'],
    ['RAHUL KR SHARMA', 'the usual abbreviation'],
  ])('MATCH: %s (%s)', (seen) => {
    expect(matchNames(holder, seen).verdict).toBe('MATCH');
  });

  it.each([
    ['R SHARMA', 'an initial and a surname could be a father'],
    ['SHARMA', 'a surname alone could be anyone in the family'],
    ['R K SHARMA', 'initials and a surname'],
    ['RAHUL KUMAR SHARMA ENTERPRISES', 'one word the account does not carry'],
  ])('PARTIAL: %s (%s)', (seen) => {
    expect(matchNames(holder, seen).verdict).toBe('PARTIAL');
  });

  it.each([
    ['SURESH SHARMA', 'a relative'],
    ['RAHUL VERMA', 'another surname'],
    ['PRIYA SINGH', 'a stranger'],
    ['SURESH KUMAR SHARMA', 'one first name differs'],
  ])('MISMATCH: %s (%s)', (seen) => {
    expect(matchNames(holder, seen).verdict).toBe('MISMATCH');
  });

  it('knows how Indian names are written several ways', () => {
    expect(matchNames('Mohammed Asif', 'MD ASIF').verdict).toBe('MATCH');
    expect(matchNames('Lakshmi Narayanan', 'LAXMI NARAYANAN').verdict).toBe('MATCH');
    expect(matchNames('Shaikh Imran', 'SK IMRAN').verdict).toBe('MATCH');
    expect(matchNames('Anil', 'ANIL').verdict).toBe('MATCH');
  });

  it('reads company names without their legal suffixes', () => {
    expect(matchNames('Acme Trading Private Limited', 'M/S ACME TRADING PVT LTD').verdict).toBe('MATCH');
    expect(matchNames('Acme Trading Private Limited', 'ACME TRAD').verdict).toBe('MATCH');
    expect(matchNames('Acme Trading Private Limited', 'APEX TRADING PVT LTD').verdict).toBe('MISMATCH');
  });

  it('says which word matched which, for the desk to see', () => {
    const m = matchNames(holder, 'R K SHARMA');
    expect(m.pairs).toEqual([
      { seen: 'R', expected: 'RAHUL', how: 'INITIAL' },
      { seen: 'K', expected: 'KUMAR', how: 'INITIAL' },
      { seen: 'SHARMA', expected: 'SHARMA', how: 'EXACT' },
    ]);
  });

  it('has nothing to say about a payment that shows no name', () => {
    expect(matchNames(holder, '').verdict).toBe('UNKNOWN');
    expect(matchNames(holder, '123 / -').verdict).toBe('UNKNOWN');
  });

  it('drops titles, initials punctuation and "son of"', () => {
    expect(nameTokens('Smt. R.K. Devi')).toEqual(['R', 'K', 'DEVI']);
    expect(nameTokens('RAMESH S/O SURESH')).toEqual(['RAMESH']);
  });

  it('lets the account number settle a thin name, and doubt a full one', () => {
    expect(judgeSender({ holderName: holder, last4: '1234' }, { name: 'R SHARMA', accountDigits: 'XXXXXX1234' }).verdict).toBe('MATCH');
    expect(judgeSender({ holderName: holder, last4: '1234' }, { name: 'RAHUL SHARMA', accountDigits: '9876' })).toMatchObject({ verdict: 'PARTIAL', account: 'DIFFERENT' });
    expect(judgeSender({ holderName: holder, last4: '1234' }, { name: 'SURESH SHARMA', accountDigits: '1234' }).verdict).toBe('MISMATCH');
    expect(judgeSender({ holderName: holder, last4: '1234' }, { name: null, accountDigits: null })).toMatchObject({ verdict: 'UNKNOWN', account: 'NOT_SHOWN' });
  });
});

describe('payment references', () => {
  it('knows each rail’s shape', () => {
    expect(checkUtrShape('UPI', '4123 4567 8901')).toEqual({ ok: true, utr: '412345678901' });
    expect(checkUtrShape('IMPS', '612345678901').ok).toBe(true);
    expect(checkUtrShape('NEFT', 'hdfcn52026101612').ok).toBe(true);
    expect(checkUtrShape('RTGS', 'HDFCR52026101612345678').ok).toBe(true);
    expect(checkUtrShape('UPI', 'HDFCN52026101612')).toMatchObject({ ok: false });
    expect(() => requireUtrShape('IMPS', '12345')).toThrow(/12-digit/);
  });

  it('guesses the rail from the reference alone where it can', () => {
    expect(railsForUtr('412345678901')).toEqual(['UPI', 'IMPS']);
    expect(railsForUtr('HDFCN52026101612')).toEqual(['NEFT', 'RTGS']);
    expect(railsForUtr('HDFCR52026101612345678')).toEqual(['RTGS', 'NEFT']);
    expect(railsForUtr('abc')).toEqual([]);
  });
});

describe('UPI', () => {
  it('accepts UPI IDs and nothing else', () => {
    expect(normalizeVpa(' InrP2P.Collect@HDFCBank ')).toBe('inrp2p.collect@hdfcbank');
    expect(normalizeVpa('no-at-sign')).toBeNull();
    expect(normalizeVpa('a@b')).toBeNull();
  });

  it('builds the link every UPI app opens, with the exact amount and the trade’s reference', () => {
    expect(upiPayUri({ vpa: 'inrp2p@hdfcbank', payeeName: 'INRP2P Exchange Pvt Ltd', amount: '48250.5', note: 'INRP2P PX7Q4M2K' })).toBe(
      'upi://pay?pa=inrp2p%40hdfcbank&pn=INRP2P%20Exchange%20Pvt%20Ltd&am=48250.50&cu=INR&tn=INRP2P%20PX7Q4M2K',
    );
    expect(() => upiPayUri({ vpa: 'inrp2p@hdfcbank', payeeName: 'x', amount: '1.234', note: 'n' })).toThrow();
  });
});
