import { DomainError } from '@inrp2p/kernel';
import type { Executor, TxContext } from '@inrp2p/db';
import { sql } from 'kysely';
import { type AuthorizationDecision, CLIENT_MFA_ENROLMENT_MAX_SESSION_AGE_SECONDS, type ClientActor, type DomainCommand, type OperatorActor, type Permission, authorizeOperator, hasFreshStepUp } from '@inrp2p/identity';

/** A mutation on a client's own data may come from the desk or from that client's admin (SECURITY §2.2, D-08). */
export type ClientDataActor = OperatorActor | ClientActor;

export interface ClientAdminCheck {
  readonly clientUserId: string;
  /** What confirmed the person for this action: a fresh TOTP, a sign-in by email code minutes ago, or nothing asked. */
  readonly confirmedBy: 'TOTP' | 'EMAIL_SIGN_IN' | 'NONE';
}

/** The kinds of destination a client adds: where it is paid rupees, and where it sends or receives USDT. */
export type DestinationKind = 'BANK_ACCOUNT' | 'WALLET';

export interface ClientAdminStepUp {
  readonly stepUp: boolean;
  /**
   * ADR 0020: the client's first destination of this kind may be confirmed by a sign-in with a code from its own email
   * in the last ten minutes, instead of an authenticator — a client who came through a desk's page or link can then set
   * up where it is paid without installing an app first. Any further one, and every archive, still needs the
   * authenticator: what replaces where a client is paid is never confirmed by email alone.
   */
  readonly firstDestination?: DestinationKind;
}

async function hasLiveDestination(ex: Executor, clientId: string, kind: DestinationKind): Promise<boolean> {
  const table = kind === 'BANK_ACCOUNT' ? 'bank_account' : 'crypto_wallet';
  const r = await ex.selectFrom(table).select('id').where('client_id', '=', clientId).where('status', 'in', ['ACTIVE', 'PENDING_REVIEW']).executeTakeFirst();
  return r !== undefined;
}

/** True when this session was opened — by an email code, the only way a client signs in (D-08) — within `maxAgeSeconds`. */
async function signedInWithin(ex: Executor, sessionId: string, maxAgeSeconds: number): Promise<boolean> {
  const r = await sql<{ fresh: boolean }>`
    select exists (select 1 from auth_session where id = ${sessionId} and expires_at > statement_timestamp()
                    and created_at > statement_timestamp() - make_interval(secs => ${maxAgeSeconds})) as fresh`.execute(ex);
  return r.rows[0]!.fresh;
}

/** Client-side authorization: active CLIENT_ADMIN of this client, optionally with a fresh TOTP step-up. */
export async function authorizeClientAdmin(ex: Executor, actor: ClientActor, clientId: string, opts: ClientAdminStepUp): Promise<ClientAdminCheck> {
  const row = await ex
    .selectFrom('client_user as cu')
    .innerJoin('auth_user as u', 'u.id', 'cu.user_id')
    .select(['cu.id', 'cu.role', 'cu.status', 'u.status as user_status', 'u.kind', 'u.two_factor_enabled'])
    .where('cu.user_id', '=', actor.userId)
    .where('cu.client_id', '=', clientId)
    .executeTakeFirst();
  if (!row || row.kind !== 'CLIENT' || row.status !== 'ACTIVE' || row.user_status !== 'ACTIVE' || row.role !== 'CLIENT_ADMIN') {
    throw new DomainError('FORBIDDEN', 'requires an active CLIENT_ADMIN of this client');
  }
  if (!opts.stepUp) return { clientUserId: row.id, confirmedBy: 'NONE' };
  // Sensitive client-admin actions (SECURITY §2.2): TOTP must be enrolled, then verified within the step-up window.
  if (row.two_factor_enabled && (await hasFreshStepUp(ex, actor.sessionId))) return { clientUserId: row.id, confirmedBy: 'TOTP' };
  if (opts.firstDestination) {
    // Two first destinations cannot both pass at once: the client row serializes them.
    await ex.selectFrom('client').select('id').where('id', '=', clientId).forUpdate().executeTakeFirstOrThrow();
    if (!(await hasLiveDestination(ex, clientId, opts.firstDestination))) {
      if (await signedInWithin(ex, actor.sessionId, CLIENT_MFA_ENROLMENT_MAX_SESSION_AGE_SECONDS)) return { clientUserId: row.id, confirmedBy: 'EMAIL_SIGN_IN' };
      throw new DomainError('STEP_UP_REQUIRED', 'confirm it is you with a fresh code from your email', { via: 'EMAIL' });
    }
  }
  if (!row.two_factor_enabled) throw new DomainError('MFA_ENROLLMENT_REQUIRED', 'client admin must enroll TOTP before this action');
  throw new DomainError('STEP_UP_REQUIRED', 'client admin must verify TOTP within the step-up window');
}

/**
 * Command guarded either by an operator permission or by client-admin authorization on the client that the
 * payload targets. `clientIdOf` resolves the client inside the transaction (never trusted from the UI).
 */
export function clientDataCommand<P, R>(
  actor: ClientDataActor,
  operatorPermission: Permission,
  clientAdmin: ClientAdminStepUp,
  clientIdOf: (ctx: TxContext, payload: P) => Promise<string>,
  handle: (ctx: TxContext, payload: P, clientId: string, via: AuthorizationDecision | ClientAdminCheck) => Promise<R>,
): DomainCommand<P, R> {
  let via: AuthorizationDecision | ClientAdminCheck | undefined;
  let authorizedClientId: string | undefined;
  return {
    authorize: async (ctx, payload) => {
      const clientId = await clientIdOf(ctx, payload);
      if (actor.kind === 'OPERATOR') {
        if (ctx.actor.surface !== 'OPERATOR') throw new DomainError('SESSION_SURFACE_MISMATCH');
        via = await authorizeOperator(ctx.tx, actor, operatorPermission);
      } else {
        if (ctx.actor.surface !== 'CLIENT') throw new DomainError('SESSION_SURFACE_MISMATCH');
        via = await authorizeClientAdmin(ctx.tx, actor, clientId, clientAdmin);
      }
      authorizedClientId = clientId;
    },
    handle: async (ctx, payload) => {
      if (!via || !authorizedClientId) throw new Error('client data command executed without authorization');
      return handle(ctx, payload, authorizedClientId, via);
    },
  };
}
