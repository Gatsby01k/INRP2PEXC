import { describe, expect, it } from 'vitest';
import { type ReviewFacts, namesAgree, reviewVerdict } from '../src/auto-review.ts';

const U = 1_000_000n;
const clean: ReviewFacts = {
  applicantName: 'Asha Menon',
  bank: { status: 'PENDING_REVIEW', holderName: 'ASHA MENON', onFileElsewhere: false, rejectedBefore: false },
  wallet: { status: 'PENDING_REVIEW', proven: true, onFileElsewhere: false, rejectedBefore: false },
  rejectedBefore: false,
  reserveRequiredMinor: 500n * U,
  reserveFreeMinor: 500n * U,
};

describe('the programme’s review of an application (ADR 0024)', () => {
  it('verifies both details and approves when everything holds', () => {
    expect(reviewVerdict(clean)).toEqual({ verifyBank: true, verifyWallet: true, approve: true, flags: [] });
  });

  it('verifies what holds on its own and says what is left', () => {
    expect(reviewVerdict({ ...clean, wallet: { ...clean.wallet, proven: false }, reserveFreeMinor: 0n }))
      .toEqual({ verifyBank: true, verifyWallet: false, approve: false, flags: ['WALLET_NOT_PROVEN', 'RESERVE_SHORT'] });
    expect(reviewVerdict({ ...clean, bank: { ...clean.bank, holderName: 'Sunita Rao' } }))
      .toEqual({ verifyBank: false, verifyWallet: true, approve: false, flags: ['BANK_NAME_MISMATCH'] });
  });

  it('asks a person about anything another client has, anything rejected before, and an applicant the desk rejected', () => {
    expect(reviewVerdict({ ...clean, bank: { ...clean.bank, onFileElsewhere: true }, wallet: { ...clean.wallet, rejectedBefore: true } }).flags)
      .toEqual(['BANK_ON_FILE_ELSEWHERE', 'WALLET_REJECTED_BEFORE']);
    expect(reviewVerdict({ ...clean, bank: { ...clean.bank, status: 'REJECTED' } }).flags).toContain('BANK_REJECTED_BEFORE');
    expect(reviewVerdict({ ...clean, rejectedBefore: true })).toMatchObject({ verifyBank: true, verifyWallet: true, approve: false, flags: ['REJECTED_BEFORE'] });
    expect(reviewVerdict({ ...clean, reserveRequiredMinor: null }).flags).toEqual(['NO_DEFAULT_RESERVE']);
  });

  it('still asks for the proof of a wallet already verified — a client adds its wallets by typing them', () => {
    const active = { ...clean, bank: { ...clean.bank, status: 'ACTIVE' as const }, wallet: { ...clean.wallet, status: 'ACTIVE' as const } };
    expect(reviewVerdict(active)).toEqual({ verifyBank: false, verifyWallet: false, approve: true, flags: [] });
    expect(reviewVerdict({ ...active, wallet: { ...active.wallet, proven: false } })).toMatchObject({ approve: false, flags: ['WALLET_NOT_PROVEN'] });
    // What is already verified is not asked about again.
    expect(reviewVerdict({ ...active, bank: { ...active.bank, holderName: 'Someone Else', onFileElsewhere: true } }).flags).toEqual([]);
  });
});

describe('the account holder is the applicant', () => {
  it('when every word of one name is the other’s, with two whole words in common, either way round', () => {
    expect(namesAgree('Asha Menon', 'ASHA MENON')).toBe(true);
    expect(namesAgree('Asha Menon', 'Asha K Menon')).toBe(true);
    expect(namesAgree('Mohd Irfan Shaikh', 'MOHAMMED IRFAN SHEIKH')).toBe(true);
    expect(namesAgree('Konkan Liquidity LLP', 'KONKAN LIQUIDITY PRIVATE LIMITED')).toBe(true);
    expect(namesAgree('Vikram Rao', 'Sunita Rao')).toBe(false);
    expect(namesAgree('Rahul Sharma', 'R Sharma')).toBe(false);
    expect(namesAgree('Rahul Sharma', '')).toBe(false);
  });
});
