import { DomainError } from '@inrp2p/kernel';
import type { Executor, TxContext } from '@inrp2p/db';
import { type AuthorizationDecision, type ClientActor, type DomainCommand, type OperatorActor, type Permission, authorizeOperator, hasFreshStepUp } from '@inrp2p/identity';

/** A mutation on a client's own data may come from the desk or from that client's admin (SECURITY §2.2, D-08). */
export type ClientDataActor = OperatorActor | ClientActor;

export interface ClientAdminCheck {
  readonly clientUserId: string;
}

/** Client-side authorization: active CLIENT_ADMIN of this client, optionally with a fresh TOTP step-up. */
export async function authorizeClientAdmin(ex: Executor, actor: ClientActor, clientId: string, opts: { stepUp: boolean }): Promise<ClientAdminCheck> {
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
  // Sensitive client-admin actions (SECURITY §2.2): TOTP must be enrolled, then verified within the step-up window.
  if (opts.stepUp && !row.two_factor_enabled) {
    throw new DomainError('MFA_ENROLLMENT_REQUIRED', 'client admin must enroll TOTP before this action');
  }
  if (opts.stepUp && !(await hasFreshStepUp(ex, actor.sessionId))) {
    throw new DomainError('STEP_UP_REQUIRED', 'client admin must verify TOTP within the step-up window');
  }
  return { clientUserId: row.id };
}

/**
 * Command guarded either by an operator permission or by client-admin authorization on the client that the
 * payload targets. `clientIdOf` resolves the client inside the transaction (never trusted from the UI).
 */
export function clientDataCommand<P, R>(
  actor: ClientDataActor,
  operatorPermission: Permission,
  clientAdmin: { stepUp: boolean },
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
