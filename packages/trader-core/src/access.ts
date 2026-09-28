import { DomainError, requireUuid } from '@inrp2p/kernel';
import { type Executor, type TraderStatus, type TxContext, assertLockOrder } from '@inrp2p/db';
import type { ClientActor, DomainCommand } from '@inrp2p/identity';

/**
 * Who is acting for a trader. A trader is a client, so the person is a client user of that client, and the
 * authority each action needs already exists in the client model:
 *
 * - `VIEW`: any active user of the client sees its trader screens.
 * - `ADMIN`: applying commits the organisation to the programme, so only a `CLIENT_ADMIN` applies.
 * - `COMMIT`: switching on, changing capacity or rates, accepting or declining an order, sending a payment
 *   reference and withdrawing reserve all bind the client to money — the same authority as accepting a quote
 *   (`can_accept_quotes`, D-01). No new permission is invented for it.
 *
 * The client id always comes from the membership, never from a payload or a URL.
 */
export type TraderAuthority = 'VIEW' | 'ADMIN' | 'COMMIT';

export interface TraderMember {
  readonly userId: string;
  readonly clientUserId: string;
  readonly clientId: string;
  readonly role: 'CLIENT_ADMIN' | 'CLIENT_TRADER';
  readonly canCommit: boolean;
}

export async function traderMembership(ex: Executor, userId: string): Promise<TraderMember> {
  const row = await ex
    .selectFrom('client_user as cu')
    .innerJoin('client as c', 'c.id', 'cu.client_id')
    .innerJoin('auth_user as u', 'u.id', 'cu.user_id')
    .select(['cu.id', 'cu.client_id', 'cu.role', 'cu.can_accept_quotes', 'cu.status', 'c.status as client_status', 'u.status as user_status', 'u.kind'])
    .where('cu.user_id', '=', requireUuid(userId, 'userId'))
    .executeTakeFirst();
  if (!row || row.status !== 'ACTIVE' || row.user_status !== 'ACTIVE' || row.kind !== 'CLIENT') throw new DomainError('FORBIDDEN', 'this account is not linked to a client');
  if (row.client_status !== 'ACTIVE') throw new DomainError('CLIENT_NOT_ACTIVE', 'this client is not active');
  return { userId, clientUserId: row.id, clientId: row.client_id, role: row.role, canCommit: row.can_accept_quotes };
}

export function assertAuthority(member: TraderMember, need: TraderAuthority): void {
  if (need === 'ADMIN' && member.role !== 'CLIENT_ADMIN') {
    throw new DomainError('TRADER_ACTION_NOT_PERMITTED', 'only an administrator of this account can apply to be a trader');
  }
  if (need === 'COMMIT' && !member.canCommit) {
    throw new DomainError('TRADER_ACTION_NOT_PERMITTED', 'this needs someone who can accept quotes for your account');
  }
}

/**
 * A client-side trader command. Authorization runs inside the command transaction before any lock or write, and
 * the handler receives the member it was authorized as — the only source of the client id.
 */
export function traderClientCommand<P, R>(actor: ClientActor, need: TraderAuthority, handle: (ctx: TxContext, payload: P, member: TraderMember) => Promise<R>): DomainCommand<P, R> {
  let member: TraderMember | undefined;
  return {
    authorize: async (ctx) => {
      if (ctx.actor.surface !== 'CLIENT') throw new DomainError('SESSION_SURFACE_MISMATCH');
      member = await traderMembership(ctx.tx, actor.userId);
      assertAuthority(member, need);
    },
    handle: async (ctx, payload) => {
      if (!member) throw new Error('trader command executed without authorization');
      return handle(ctx, payload, member);
    },
  };
}

export interface TraderRow {
  readonly id: string;
  readonly ref: string;
  readonly client_id: string;
  readonly status: TraderStatus;
  readonly available: boolean;
  readonly assignments_enabled: boolean;
  readonly bank_account_id: string;
  readonly wallet_id: string;
  readonly required_reserve_minor: bigint | null;
  readonly version: number;
}

const TRADER_COLUMNS = ['id', 'ref', 'client_id', 'status', 'available', 'assignments_enabled', 'bank_account_id', 'wallet_id', 'required_reserve_minor', 'version'] as const;

/** The trader profile of a client, locked `FOR UPDATE` in the global lock order (ARCHITECTURE §4). */
export async function lockTraderOfClient(ctx: TxContext, clientId: string): Promise<TraderRow> {
  assertLockOrder(ctx.tx, 'trader_profile');
  const row = await ctx.tx.selectFrom('trader_profile').select(TRADER_COLUMNS).where('client_id', '=', clientId).forUpdate().executeTakeFirst();
  if (!row) throw new DomainError('NOT_FOUND', 'this account is not a trader');
  return row;
}

export async function lockTrader(ctx: TxContext, traderId: string): Promise<TraderRow> {
  assertLockOrder(ctx.tx, 'trader_profile');
  const row = await ctx.tx.selectFrom('trader_profile').select(TRADER_COLUMNS).where('id', '=', requireUuid(traderId, 'traderId')).forUpdate().executeTakeFirst();
  if (!row) throw new DomainError('NOT_FOUND', 'trader not found');
  return row;
}
