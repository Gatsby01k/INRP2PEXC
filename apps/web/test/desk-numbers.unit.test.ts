import { describe, expect, it } from 'vitest';
import { sanitizeRateInput, stepRate } from '../src/app/(operator)/_desk/numbers.ts';
import { duration } from '../src/app/(operator)/system/reading.ts';

/**
 * The desk's rate field: what a dealer types is kept as typed (never rounded, never a float), and the arrow-key
 * step moves it by exactly one paisa in integer micro units. A rate that silently became 103.99999 would be a
 * quote the dealer did not send.
 */
describe('rate input', () => {
  it('keeps what the dealer typed', () => {
    expect(sanitizeRateInput('102.5')).toBe('102.5');
    expect(sanitizeRateInput('102.')).toBe('102.');
    expect(sanitizeRateInput('.25')).toBe('0.25');
    expect(sanitizeRateInput('')).toBe('');
  });

  it('drops the formatting a paste brings along', () => {
    expect(sanitizeRateInput('₹ 1,02.40')).toBe('102.40');
    expect(sanitizeRateInput('0102.40')).toBe('102.40');
  });

  it('refuses what is not a rate instead of guessing', () => {
    expect(sanitizeRateInput('10a')).toBeNull();
    expect(sanitizeRateInput('1.2.3')).toBeNull();
    expect(sanitizeRateInput('-102')).toBeNull();
    expect(sanitizeRateInput('102.1234567')).toBeNull();
    expect(sanitizeRateInput('1234567')).toBeNull();
  });
});

describe('rate step', () => {
  it('steps by one paisa exactly', () => {
    expect(stepRate('102.00', 10_000n)).toBe('102.01');
    expect(stepRate('102.00', -10_000n)).toBe('101.99');
    expect(stepRate('102.99', 10_000n)).toBe('103.00');
  });

  it('keeps the precision the dealer was working in', () => {
    expect(stepRate('102.4567', 10_000n)).toBe('102.4667');
    expect(stepRate('102', 10_000n)).toBe('102.01');
    expect(stepRate('102.', 10_000n)).toBe('102.01');
  });

  it('never steps to zero or below', () => {
    expect(stepRate('0.01', -10_000n)).toBe('0.01');
    expect(stepRate('0.00', -10_000n)).toBe('0.00');
  });

  it('leaves text it cannot read alone', () => {
    expect(stepRate('abc', 10_000n)).toBe('abc');
  });
});

describe('health durations', () => {
  it('reads like an operator talks', () => {
    expect(duration(12)).toBe('12 s');
    expect(duration(300)).toBe('5 min');
    expect(duration(5400)).toBe('1 h 30 min');
    expect(duration(7200)).toBe('2 h');
    expect(duration(9 * 86_400)).toBe('9 d');
  });
});
