/** PostgreSQL error helpers. */
export interface PgError extends Error {
  code?: string;
  constraint?: string;
  table?: string;
}

export function pgErrorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as PgError).code) : undefined;
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  return pgErrorCode(err) === '23505' && (constraint === undefined || (err as PgError).constraint === constraint);
}

/** Raised by append-only guards (IX001). */
export function isAppendOnlyViolation(err: unknown): boolean {
  return pgErrorCode(err) === 'IX001';
}
