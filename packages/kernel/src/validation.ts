import { DomainError } from './errors.ts';

/** Minimal payload guards for command inputs (typed callers, defensive at runtime). */
export function requireText(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string') throw new DomainError('INVALID_ARGUMENT', `${field} must be a string`, { field });
  const v = value.trim();
  if (v.length < 1 || v.length > max) throw new DomainError('INVALID_ARGUMENT', `${field} must be 1..${max} characters`, { field });
  return v;
}

export function optionalText(value: unknown, field: string, max = 2000): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  return requireText(value, field, max);
}

export function requireOneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be one of ${allowed.join(', ')}`, { field });
  }
  return value as T;
}

export function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be a uuid`, { field });
  }
  return value;
}

/** Indian bank account numbers: digits only after removing spaces, 9–18 digits. */
export function normalizeIndianAccountNumber(value: unknown): string {
  const v = typeof value === 'string' ? value.replace(/\s+/g, '') : '';
  if (!/^[0-9]{9,18}$/.test(v)) throw new DomainError('INVALID_ARGUMENT', 'account number must be 9–18 digits', { field: 'accountNumber' });
  return v;
}

/** IFSC: 4 letters, 0, 6 alphanumerics (RBI format). */
export function normalizeIfsc(value: unknown): string {
  const v = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(v)) throw new DomainError('INVALID_ARGUMENT', 'invalid IFSC', { field: 'ifsc' });
  return v;
}

/** E.164-like phone: optional +, 8–15 digits; spaces, dashes and brackets are removed. */
export function normalizePhone(value: unknown, field = 'phone'): string {
  const v = typeof value === 'string' ? value.replace(/[\s()-]/g, '') : '';
  if (!/^\+?[0-9]{8,15}$/.test(v)) throw new DomainError('INVALID_ARGUMENT', `${field} must be 8–15 digits`, { field });
  return v;
}

export function last4(digits: string): string {
  return digits.replace(/\D/g, '').slice(-4);
}
