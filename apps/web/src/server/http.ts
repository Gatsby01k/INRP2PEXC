import { NextResponse } from 'next/server';
import { isDomainError } from '@inrp2p/kernel';

const STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  SESSION_IDLE_TIMEOUT: 401,
  SESSION_SURFACE_MISMATCH: 401,
  MFA_ENROLLMENT_REQUIRED: 403,
  MFA_VERIFICATION_REQUIRED: 403,
  STEP_UP_REQUIRED: 403,
  FORBIDDEN: 403,
};

/** Maps auth/authorization domain errors to uniform JSON responses without leaking internals. */
export function authErrorResponse(err: unknown): NextResponse {
  const status = isDomainError(err) ? STATUS[err.code] : undefined;
  if (isDomainError(err) && status !== undefined) {
    return NextResponse.json({ error: err.code }, { status, headers: { 'cache-control': 'no-store' } });
  }
  return NextResponse.json({ error: 'INTERNAL' }, { status: 500, headers: { 'cache-control': 'no-store' } });
}
