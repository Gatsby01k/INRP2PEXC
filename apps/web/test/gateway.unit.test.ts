import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODE_LENGTH, CODE_MINUTES, RESEND_AFTER_SECONDS, clock, codeDigits, looksLikeEmail, maskEmail } from '../src/app/sign-in/access.ts';

describe('the workspace gateway: what it checks before asking the server', () => {
  it('takes an address that has a name, an @ and a dotted domain, and nothing less', () => {
    expect(looksLikeEmail('treasury@acmepay.test')).toBe(true);
    expect(looksLikeEmail('  treasury@acmepay.test  ')).toBe(true);
    for (const bad of ['', 'treasury', 'treasury@', 'treasury@acmepay', '@acmepay.test', 'tre asury@acmepay.test', 'a@b@c.d']) {
      expect(looksLikeEmail(bad), bad).toBe(false);
    }
  });

  it('shows the address as its first character and its domain', () => {
    expect(maskEmail('vlad@company.com')).toBe('v•••@company.com');
    expect(maskEmail(' treasury@acmepay.test ')).toBe('t•••@acmepay.test');
    // The last @ is the domain's, whatever the name contains.
    expect(maskEmail('"a@b"@company.com')).toBe('"•••@company.com');
    expect(maskEmail('')).toBe('');
  });

  it('keeps only a code’s digits, however they were typed, pasted or offered', () => {
    expect(codeDigits('482199')).toBe('482199');
    expect(codeDigits('482 199')).toBe('482199');
    expect(codeDigits('482-199')).toBe('482199');
    expect(codeDigits('Your code: 482199.')).toBe('482199');
    expect(codeDigits('4821990')).toBe('482199');
    expect(codeDigits('abc')).toBe('');
  });

  it('counts down as a clock, and never below zero', () => {
    expect(clock(RESEND_AFTER_SECONDS)).toBe('00:30');
    expect(clock(28.2)).toBe('00:29');
    expect(clock(0.1)).toBe('00:01');
    expect(clock(0)).toBe('00:00');
    expect(clock(-3)).toBe('00:00');
    expect(clock(75)).toBe('01:15');
  });
});

/**
 * What the surface says about codes — six digits, ten minutes — is a promise about Better Auth's configuration, and
 * so is offering "resend" at all. Read from the configuration itself, so the words cannot drift from what the server
 * does. Refusing too many sends stays the server's job; the surface only reports it.
 */
describe('the workspace gateway says what the server does', () => {
  const config = readFileSync(path.join(import.meta.dirname, '../../../packages/identity/src/auth/config.ts'), 'utf8');
  const emailOtp = config.slice(config.indexOf('emailOTP({'));
  const number = (source: string, pattern: RegExp) => {
    const match = source.match(pattern);
    if (!match?.[1]) throw new Error(`not found in the identity config: ${pattern}`);
    return Number.parseInt(match[1], 10);
  };

  it('six digits, and ten minutes', () => {
    expect(number(emailOtp, /otpLength:\s*(\d+)/)).toBe(CODE_LENGTH);
    expect(number(emailOtp, /expiresIn:\s*(\d+)/)).toBe(CODE_MINUTES * 60);
  });

  it('offers a resend the server will take: inside its window, with a first send and a resend in its allowance', () => {
    const rule = /'\/email-otp\/send-verification-otp':\s*\{\s*window:\s*(\d+),\s*max:\s*(\d+)/;
    const window = number(config, rule);
    const max = Number.parseInt(config.match(rule)![2]!, 10);
    expect(RESEND_AFTER_SECONDS).toBeLessThan(window);
    expect(max).toBeGreaterThanOrEqual(2);
  });
});
