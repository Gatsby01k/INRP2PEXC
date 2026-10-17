import { describe, expect, it } from 'vitest';
import { readNarration } from '../src/narration.ts';

describe('reading who sent a credit from a bank narration', () => {
  it.each([
    ['UPI/412345678901/RAHUL KUMAR SHARMA/rahul.sharma@okhdfcbank/Payment from Phone for flat rent and bills', { name: 'RAHUL KUMAR SHARMA', vpa: 'rahul.sharma@okhdfcbank', accountDigits: null }],
    ['UPI/CR/412345678901/RAHUL KUMAR/HDFC/rahul@ybl/UPIIntent', { name: 'RAHUL KUMAR', vpa: 'rahul@ybl', accountDigits: null }],
    ['IMPS/P2A/612345678901/RAJESH K/SBIN0001234', { name: 'RAJESH K', vpa: null, accountDigits: null }],
    ['MMT/IMPS/612345678901/RAJESH KUMAR/HDFC BANK', { name: 'RAJESH KUMAR', vpa: null, accountDigits: null }],
    ['NEFT-HDFCN52026101612345-RAHUL KUMAR SHARMA-XXXXXX1234-HDFC0000123', { name: 'RAHUL KUMAR SHARMA', vpa: null, accountDigits: '1234' }],
    ['NEFT/N289261234567890/ACME TRADING PVT LTD/ICIC0000104', { name: 'ACME TRADING PVT LTD', vpa: null, accountDigits: null }],
  ])('%s', (narration, expected) => {
    expect(readNarration(narration)).toEqual(expected);
  });

  it('says nothing when there is nothing to read', () => {
    expect(readNarration(null)).toEqual({ name: null, vpa: null, accountDigits: null });
    expect(readNarration('412345678901')).toEqual({ name: null, vpa: null, accountDigits: null });
    expect(readNarration('UPI/CR/412345678901')).toEqual({ name: null, vpa: null, accountDigits: null });
  });
});
