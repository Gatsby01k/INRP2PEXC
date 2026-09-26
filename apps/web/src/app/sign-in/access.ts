/**
 * The client sign-in's own rules, kept pure so they are tested without a browser. None of them decides anything
 * about access: whether an address belongs to a client, whether a code is right and how often either may be tried
 * are Better Auth's answers (packages/identity `clientAuthOptions`), and the form only reports them.
 */

/** Digits in a client sign-in code (the identity config's `otpLength`). */
export const CODE_LENGTH = 6;

/** Minutes a code stays valid (the identity config's `expiresIn`, 600 seconds). */
export const CODE_MINUTES = 10;

/**
 * Seconds before the form offers another code. The server allows three sends in ten minutes from one network
 * address and refuses the rest (the form then says so); waiting half a minute keeps a visitor with a slow inbox
 * from spending them all before the first code has had a chance to arrive.
 */
export const RESEND_AFTER_SECONDS = 30;

/** Shaped like an address: something, an @, and a domain with a dot in it. The server decides whose it is. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** The address as the code step shows it: its first character, then its domain — "v•••@company.com". */
export function maskEmail(email: string): string {
  const address = email.trim();
  const at = address.lastIndexOf('@');
  if (at <= 0) return address;
  return `${address.slice(0, 1)}•••${address.slice(at)}`;
}

/** Only the digits of what was typed or pasted, at most a code's worth: "123 456" and "123-456" both give "123456". */
export function codeDigits(value: string): string {
  return value.replace(/\D/g, '').slice(0, CODE_LENGTH);
}

/** Whole seconds as a clock, "00:28". Never negative. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(s / 60);
  return `${String(minutes).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
