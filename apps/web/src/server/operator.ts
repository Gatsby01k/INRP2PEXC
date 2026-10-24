import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { DomainError, isDomainError } from '@inrp2p/kernel';
import type { Db } from '@inrp2p/db';
import { type OperatorActor, type Permission, effectiveRequirement, operatorSession } from '@inrp2p/identity';
import { type DeskAccess, accessFor } from '@inrp2p/desk';
import { getRuntime } from './runtime.ts';

export interface OperatorContext {
  readonly actor: OperatorActor;
  readonly db: Db;
  readonly access: DeskAccess;
  /** True when this session's TOTP verification is inside the step-up window (SECURITY §2.1). */
  readonly stepUpFresh: boolean;
  /** Who is signed in, as the sidebar names them. */
  readonly operator: { readonly name: string; readonly email: string };
}

/**
 * The operator behind the current request — the check that decides. The proxy only sends a request without a desk
 * cookie to sign in; whether the session is real, live, MFA-verified and on the desk is read here, next to the
 * database, inside every page, route and action, because a page that trusts routing alone is one mistake away from
 * rendering someone else's desk.
 *
 * Once per request: the layout, the page and anything else rendered for the same request share one read (React
 * `cache` is scoped to a single server request, so nothing about one request or operator reaches another).
 */
export const operatorContext = cache(async (): Promise<OperatorContext> => {
  const rt = getRuntime();
  const session = await operatorSession(rt.operatorAuth, rt.appDb, await headers());
  return {
    actor: session.actor,
    db: rt.appDb,
    access: accessFor(session.actor),
    stepUpFresh: session.stepUpFresh,
    operator: { name: session.name, email: session.email },
  };
});

/** Page-level variant: an expired or missing session sends the operator to sign in rather than showing an error. */
export async function operatorPage(): Promise<OperatorContext> {
  try {
    return await operatorContext();
  } catch (e) {
    if (isDomainError(e) && ['UNAUTHENTICATED', 'SESSION_IDLE_TIMEOUT', 'SESSION_SURFACE_MISMATCH', 'MFA_VERIFICATION_REQUIRED', 'MFA_ENROLLMENT_REQUIRED'].includes(e.code)) {
      redirect('/sign-in');
    }
    throw e;
  }
}

/**
 * What this operator may do, for rendering only. The command re-reads roles and grants in its own transaction
 * and refuses anything this gets wrong, so hiding a button is a courtesy, never the control (SECURITY §3).
 */
export function can(ctx: OperatorContext, permission: Permission): boolean {
  return effectiveRequirement(permission, ctx.actor.roles, ctx.actor.grants) !== 'DENY';
}

/** True when the permission would additionally demand a fresh TOTP right now. */
export function needsStepUp(ctx: OperatorContext, permission: Permission): boolean {
  const req = effectiveRequirement(permission, ctx.actor.roles, ctx.actor.grants);
  return req !== 'DENY' && req !== 'ALLOW' && !ctx.stepUpFresh;
}

export function assertCan(ctx: OperatorContext, permission: Permission): void {
  if (!can(ctx, permission)) throw new DomainError('FORBIDDEN', `missing permission ${permission}`, { permission });
}
