import { DomainError } from '@inrp2p/kernel';
import type { Executor, TxContext } from '@inrp2p/db';
import { type AuthorizationDecision, type ClientActor, type Confirmation, type DomainCommand, type OperatorActor, type Permission, type StepUpPurpose, authorizeOperator, requireConfirmation } from '@inrp2p/identity';

/** A mutation on a client's own data may come from the desk or from that client's admin (SECURITY §2.2, D-08). */
export type ClientDataActor = OperatorActor | ClientActor;

export interface ClientAdminCheck {
  readonly clientUserId: string;
  /**
   * What confirmed the person for this action (ADR 0026): a fresh step-up by a factor other than their sign-in (TOTP,
   * EMAIL, TELEGRAM), a sign-in or code minutes ago for a first destination, or nothing asked.
   */
  readonly confirmedBy: Confirmation | 'NONE';
}

/** The kinds of destination a client adds: where it is paid rupees — an account, a UPI ID — and where it sends or receives USDT. */
export type DestinationKind = 'BANK_ACCOUNT' | 'WALLET' | 'UPI_ID';

export interface ClientAdminStepUp {
  readonly stepUp: boolean;
  /**
   * ADR 0020: the client's first destination of this kind may be confirmed by a sign-in, or a code, in the last ten
   * minutes — a client who came through a desk's page or link sets up where it is paid without a second factor first.
   * Any further one, and every archive, needs a step-up by a factor other than the sign-in (ADR 0026): what replaces
   * where a client is paid is never confirmed by the one factor that opened the session.
   */
  readonly firstDestination?: DestinationKind;
  /** What the confirmation is for, said in the code's message. */
  readonly purpose?: StepUpPurpose;
}

async function hasLiveDestination(ex: Executor, clientId: string, kind: DestinationKind): Promise<boolean> {
  const table = kind === 'BANK_ACCOUNT' ? 'bank_account' : kind === 'UPI_ID' ? 'upi_id' : 'crypto_wallet';
  const r = await ex.selectFrom(table).select('id').where('client_id', '=', clientId).where('status', 'in', ['ACTIVE', 'PENDING_REVIEW']).executeTakeFirst();
  return r !== undefined;
}

/** Client-side authorization: active CLIENT_ADMIN of this client, optionally confirmed again (ADR 0026, `requireConfirmation`). */
export async function authorizeClientAdmin(ex: Executor, actor: ClientActor, clientId: string, opts: ClientAdminStepUp): Promise<ClientAdminCheck> {
  const row = await ex
    .selectFrom('client_user as cu')
    .innerJoin('auth_user as u', 'u.id', 'cu.user_id')
    .select(['cu.id', 'cu.role', 'cu.status', 'u.status as user_status', 'u.kind'])
    .where('cu.user_id', '=', actor.userId)
    .where('cu.client_id', '=', clientId)
    .executeTakeFirst();
  if (!row || row.kind !== 'CLIENT' || row.status !== 'ACTIVE' || row.user_status !== 'ACTIVE' || row.role !== 'CLIENT_ADMIN') {
    throw new DomainError('FORBIDDEN', 'requires an active CLIENT_ADMIN of this client');
  }
  if (!opts.stepUp) return { clientUserId: row.id, confirmedBy: 'NONE' };
  if (opts.firstDestination) {
    // Two first destinations cannot both pass at once: the client row serializes them.
    await ex.selectFrom('client').select('id').where('id', '=', clientId).forUpdate().executeTakeFirstOrThrow();
    if (!(await hasLiveDestination(ex, clientId, opts.firstDestination))) return { clientUserId: row.id, confirmedBy: await requireConfirmation(ex, actor.sessionId, 'RECENT', 'DESTINATION') };
  }
  return { clientUserId: row.id, confirmedBy: await requireConfirmation(ex, actor.sessionId, 'INDEPENDENT', opts.purpose ?? (opts.firstDestination ? 'DESTINATION' : 'CHANGE')) };
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
