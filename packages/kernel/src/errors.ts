/**
 * Typed domain errors. Every failed precondition surfaces as a DomainError with a
 * stable machine-readable code (STATE_MACHINES.md "Failure path").
 */
export type DomainErrorCode =
  | 'INVALID_AMOUNT'
  | 'INVALID_AMOUNT_PRECISION'
  | 'INVALID_RATE'
  | 'CURRENCY_MISMATCH'
  | 'NEGATIVE_AMOUNT'
  | 'UNBALANCED_JOURNAL'
  | 'EMPTY_JOURNAL'
  | 'DUPLICATE_POSTING_KEY'
  | 'JOURNAL_ALREADY_REVERSED'
  | 'REVERSAL_OF_REVERSAL'
  | 'JOURNAL_NOT_FOUND'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'MFA_ENROLLMENT_REQUIRED'
  | 'MFA_VERIFICATION_REQUIRED'
  | 'STEP_UP_REQUIRED'
  | 'SECOND_APPROVER_REQUIRED'
  | 'SESSION_SURFACE_MISMATCH'
  | 'SESSION_IDLE_TIMEOUT'
  | 'LOCK_ORDER_VIOLATION'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'STALE_VERSION'
  | 'CLIENT_NOT_ACTIVE'
  | 'DUPLICATE_DESTINATION'
  | 'INVALID_ADDRESS'
  | 'ACCOUNT_NOT_ACTIVE'
  | 'CAPACITY_INSUFFICIENT'
  | 'RESERVATION_NOT_ACTIVE'
  | 'ROUTE_INACTIVE'
  | 'ROUTE_SETTLEMENT_MODEL_UNSUPPORTED'
  | 'ROUTE_DIRECTION_MISMATCH'
  | 'ROUTE_RATE_MISSING'
  | 'WALLET_NOT_ACTIVE'
  | 'CUSTODY_CAPABILITY_UNSUPPORTED'
  | 'CUSTODY_CAPABILITY_MISMATCH'
  | 'DEPOSIT_ADDRESS_UNAVAILABLE'
  | 'DEPOSIT_ASSIGNMENT_EXISTS';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: DomainErrorCode, message?: string, details: Record<string, unknown> = {}) {
    super(message ?? code);
    this.name = 'DomainError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function isDomainError(err: unknown, code?: DomainErrorCode): err is DomainError {
  return err instanceof DomainError && (code === undefined || err.code === code);
}
