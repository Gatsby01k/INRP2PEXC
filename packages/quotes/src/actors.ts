import { sql } from 'kysely';
import { DomainError } from '@inrp2p/kernel';
import { type Executor, type LockResource, type Tx, type TxContext, assertLockOrder } from '@inrp2p/db';
import type { ClientActor, DomainCommand, OperatorActor, Permission } from '@inrp2p/identity';
import { authorizeOperator } from '@inrp2p/identity';

export interface ClientMembership {
  readonly clientUserId: string;
  readonly userId: string;
  readonly role: 'CLIENT_ADMIN' | 'CLIENT_TRADER';
  readonly canAcceptQuotes: boolean;
  readonly email: string;
  readonly emailVerified: boolean;
}

/** Active membership of an active CLIENT login in a client; `null` when the user does not belong to it. */
export async function clientMembership(ex: Executor, userId: string, clientId: string): Promise<ClientMembership | null> {
  const row = await ex
    .selectFrom('client_user as cu')
    .innerJoin('auth_user as u', 'u.id', 'cu.user_id')
    .select(['cu.id', 'cu.role', 'cu.can_accept_quotes', 'cu.status', 'u.id as user_id', 'u.kind', 'u.status as user_status', 'u.email', 'u.email_verified'])
    .where('cu.user_id', '=', userId)
    .where('cu.client_id', '=', clientId)
    .executeTakeFirst();
  if (!row || row.kind !== 'CLIENT' || row.status !== 'ACTIVE' || row.user_status !== 'ACTIVE') return null;
  return { clientUserId: row.id, userId: row.user_id, role: row.role, canAcceptQuotes: row.can_accept_quotes, email: row.email, emailVerified: row.email_verified };
}

export async function requireClientMember(ex: Executor, actor: ClientActor, clientId: string): Promise<ClientMembership> {
  const m = await clientMembership(ex, actor.userId, clientId);
  if (!m) throw new DomainError('FORBIDDEN', 'not a user of this client');
  return m;
}

/** Quote acceptance/rejection authority (D-01, D-15): active client user with `can_accept_quotes`. */
export async function requireQuoteDecider(ex: Executor, userId: string, clientId: string, opts: { requireVerifiedEmail: boolean }): Promise<ClientMembership> {
  const m = await clientMembership(ex, userId, clientId);
  if (!m || !m.canAcceptQuotes || (opts.requireVerifiedEmail && !m.emailVerified)) {
    throw new DomainError('NOT_AUTHORIZED_TO_ACCEPT', 'this user may not accept or reject quotes for the client');
  }
  return m;
}

export type QuoteActor = OperatorActor | ClientActor;

/** Operator permission or active membership of the client the payload resolves to (checked in the transaction). */
export function operatorOrMemberCommand<P, R>(
  actor: QuoteActor,
  permission: Permission,
  clientIdOf: (ctx: TxContext, payload: P) => Promise<string>,
  handle: (ctx: TxContext, payload: P, clientId: string) => Promise<R>,
): DomainCommand<P, R> {
  let authorized: string | undefined;
  return {
    authorize: async (ctx, payload) => {
      const clientId = await clientIdOf(ctx, payload);
      if (actor.kind === 'OPERATOR') {
        if (ctx.actor.surface !== 'OPERATOR') throw new DomainError('SESSION_SURFACE_MISMATCH');
        await authorizeOperator(ctx.tx, actor, permission);
      } else {
        if (ctx.actor.surface !== 'CLIENT') throw new DomainError('SESSION_SURFACE_MISMATCH');
        await requireClientMember(ctx.tx, actor, clientId);
      }
      authorized = clientId;
    },
    handle: async (ctx, payload) => {
      if (!authorized) throw new Error('command executed without authorization');
      return handle(ctx, payload, authorized);
    },
  };
}

/** `SELECT … FOR UPDATE` of one row after asserting the global lock order (ARCHITECTURE §4). */
export async function lockRow(tx: Tx, resource: LockResource, table: 'trade_request' | 'quote' | 'acceptance_challenge', id: string): Promise<void> {
  assertLockOrder(tx, resource);
  const r = await sql`select 1 from ${sql.table(table)} where id = ${id} for update`.execute(tx);
  if (r.rows.length === 0) throw new DomainError('NOT_FOUND', `${table} not found`);
}
