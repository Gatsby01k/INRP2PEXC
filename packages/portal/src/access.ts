import { DomainError } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';
import { assertClientSafe } from '@inrp2p/quotes';

/**
 * Who is asking, on the client side.
 *
 * A signed-in client user belongs to exactly one client in V1, and every read in this package starts from that
 * membership rather than from anything the browser sent. A client id is never taken from a URL or a payload: it
 * is resolved from the session, so one client cannot read another's trades by changing a link.
 */
export interface PortalAccess {
  readonly userId: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly role: 'CLIENT_ADMIN' | 'CLIENT_TRADER' | 'CLIENT_VIEWER';
  /** D-01: only a user with this may accept or reject a quote. The product never shows an action they lack. */
  readonly canAcceptQuotes: boolean;
}

export async function portalAccess(ex: Executor, userId: string): Promise<PortalAccess> {
  const row = await ex
    .selectFrom('client_user as cu')
    .innerJoin('client as c', 'c.id', 'cu.client_id')
    .select(['cu.client_id', 'cu.role', 'cu.can_accept_quotes', 'cu.status', 'c.display_name', 'c.status as client_status'])
    .where('cu.user_id', '=', userId)
    .executeTakeFirst();
  if (!row || row.status !== 'ACTIVE') throw new DomainError('FORBIDDEN', 'this account is not linked to a client');
  if (row.client_status !== 'ACTIVE') throw new DomainError('FORBIDDEN', 'this client is not active');
  return {
    userId,
    clientId: row.client_id,
    clientName: row.display_name,
    role: row.role,
    canAcceptQuotes: row.can_accept_quotes,
  };
}

/**
 * The fuse on every payload this package returns.
 *
 * `assertClientSafe` walks the value and refuses keys that belong to the desk — route, margin, provider, dealer
 * and the rest (SECURITY §5). Running it here, not only in tests, means a read model cannot leak in production
 * even if a future join adds a column nobody reviewed: the request fails instead of the client learning what the
 * exchange paid for their USDT.
 */
export function clientSafe<T>(value: T): T {
  assertClientSafe(value);
  return value;
}
