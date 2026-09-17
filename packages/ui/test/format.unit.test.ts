import { describe, expect, it } from 'vitest';
import { Money, Rate } from '@inrp2p/kernel';
import {
  formatCountdown, formatDuration, formatInr, formatInrCompact, formatIstDateTime, formatIstTime, formatRate, formatUsdt,
  formatUsdtCompact, formatUsdtHeadline, groupDigits, maskAccount, maskEmail, maskUtr, percentString, shortenAddress, shortenHash,
} from '../src/format/index.ts';

const inr = (a: string) => Money.parse(a, 'INR');
const usdt = (a: string) => Money.parse(a, 'USDT');

describe('INR formatting — international grouping, no locale (D-11)', () => {
  it.each([
    ['10200000', '₹10,200,000'],
    ['10420000.00', '₹10,420,000'],
    ['220000', '₹220,000'],
    ['0', '₹0'],
    ['999', '₹999'],
    ['1000', '₹1,000'],
    ['1234567.89', '₹1,234,567.89'],
    ['0.05', '₹0.05'],
  ])('%s → %s', (input, expected) => {
    expect(formatInr(inr(input))).toBe(expected);
  });

  it('never uses lakh/crore grouping regardless of runtime locale', () => {
    expect(formatInr(inr('10200000'))).not.toContain('1,02,00,000');
  });

  it('shows paise always on evidence, and refuses to hide non-zero paise', () => {
    expect(formatInr(inr('10200000'), { fraction: 'always' })).toBe('₹10,200,000.00');
    expect(() => formatInr(inr('10.50'), { fraction: 'never' })).toThrow();
    expect(formatInr(inr('10'), { fraction: 'never' })).toBe('₹10');
  });

  it('signs margins explicitly', () => {
    expect(formatInr(inr('220000'), { sign: 'always' })).toBe('+₹220,000');
    expect(formatInr(inr('-800'), { sign: 'always' })).toBe('−₹800');
  });

  it('compact forms for summaries only', () => {
    expect(formatInrCompact(inr('6500000'))).toBe('₹6.5M');
    expect(formatInrCompact(inr('3700000'))).toBe('₹3.7M');
    expect(formatInrCompact(inr('800000'))).toBe('₹800k');
    expect(formatInrCompact(inr('2500000'))).toBe('₹2.5M');
    expect(formatInrCompact(inr('999960'))).toBe('₹1M');
    expect(formatInrCompact(inr('18400000'))).toBe('₹18.4M');
    expect(formatInrCompact(inr('950'))).toBe('₹950');
    expect(formatUsdtCompact(usdt('2100000'))).toBe('2.1M');
    expect(formatUsdtCompact(usdt('640000'))).toBe('640k');
  });
});

describe('USDT and rate formatting', () => {
  it('USDT summary 2 dp, exact 6 dp, headline whole', () => {
    expect(formatUsdt(usdt('100000'))).toBe('100,000.00 USDT');
    expect(formatUsdt(usdt('100000'), { precision: 'exact' })).toBe('100,000.000000 USDT');
    expect(formatUsdt(usdt('1840220.125'), { unit: false })).toBe('1,840,220.12');
    expect(formatUsdtHeadline(usdt('100000'))).toBe('100,000 USDT');
    expect(formatUsdtHeadline(usdt('99950.5'))).toBe('99,950.500000 USDT');
  });

  it('rates keep at least 2 decimals and never drop stored precision', () => {
    expect(formatRate(Rate.parse('102', 'CLIENT'))).toBe('₹102.00');
    expect(formatRate(Rate.parse('104.2', 'ROUTE'))).toBe('₹104.20');
    expect(formatRate(Rate.parse('102.125', 'CLIENT'))).toBe('₹102.125');
    expect(formatRate(Rate.parse('102.123456', 'CLIENT'), { unit: true })).toBe('₹102.123456 / USDT');
  });
});

describe('helpers', () => {
  it('groups digits', () => {
    expect(groupDigits('1')).toBe('1');
    expect(groupDigits('1234')).toBe('1,234');
    expect(groupDigits('100000000000')).toBe('100,000,000,000');
  });

  it('computes exact percentages without floats', () => {
    expect(percentString(450000000n, 1020000000n)).toBe('44.11');
    expect(percentString(0n, 10n)).toBe('0.00');
    expect(percentString(11n, 10n)).toBe('100.00');
  });

  it('masks sensitive identifiers', () => {
    expect(maskUtr('HDFCR52026091617118')).toBe('••••7118');
    expect(maskAccount('8219')).toBe('•••• 8219');
    expect(() => maskAccount('50100123458219')).toThrow();
    expect(maskEmail('alex@acmepay.in')).toBe('a•••@acmepay.in');
    expect(shortenAddress('TXqH2JBkDgGWyCFg4GZzg8eUjG5KdK9fA2')).toBe('TXq…9fA2');
    expect(shortenHash('7c1e5f0a9b3d2e4c6a8b0d1f3e5a7c9b2d4f6a8c0e1b3d5f7a9c1e3b5d7fa90b')).toBe('7c1e…a90b'); // secret-scan:allow — public on-chain tx hash fixture
  });

  it('formats IST deterministically', () => {
    const d = new Date('2026-09-16T10:41:00Z');
    expect(formatIstTime(d)).toBe('16:11 IST');
    expect(formatIstDateTime(new Date('2026-09-16T19:00:00Z'))).toBe('17 Sep 2026, 00:30 IST');
    expect(formatCountdown(72_900)).toBe('01:12');
    expect(formatCountdown(-5)).toBe('00:00');
    expect(formatDuration(72 * 60_000)).toBe('1 h 12 min');
  });
});
