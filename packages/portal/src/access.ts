import { DomainError } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';
import { TELEGRAM_PROVIDER, isTelegramPlaceholderEmail, signInLabel } from '@inrp2p/identity';
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
  /**
   * Exchange, History, Destinations and quotes. The desk grants it; a client that exists only because someone
   * applied to be a trader does not have it (migration 0023), and sees Traders alone.
   */
  readonly exchangeAccess: boolean;
}

/**
 * Everyone who can hold a client session: a member of a client, or a person who verified their email to apply as a
 * trader and has not submitted an application yet (`NEW`) — they have no client, and so nothing to read but their
 * own application.
 */
export type WorkspaceAccess =
  | ({ readonly kind: 'MEMBER'; readonly member: PortalAccess } & SignedInAs)
  | ({ readonly kind: 'NEW' } & SignedInAs);

/** Who is signed in, as the workspace shows and uses it (ADR 0026). */
interface SignedInAs {
  readonly userId: string;
  /** Their email, or null for an account Telegram opened that has not added one (its address is a placeholder). */
  readonly email: string | null;
  /** How they are shown: their email, or their Telegram (`@username`) when they have no email yet. */
  readonly label: string;
  /** Their name before they have an account to show: the email, or the name Telegram gave for an account it opened. */
  readonly name: string;
}

export async function workspaceAccess(ex: Executor, userId: string): Promise<WorkspaceAccess> {
  // The user and their membership in one statement: a user has at most one membership and a membership one client
  // (both unique), so the joins add no rows — they only save the second round trip.
  const row = await ex
    .selectFrom('auth_user as u')
    .leftJoin('client_user as cu', 'cu.user_id', 'u.id')
    .leftJoin('client as c', 'c.id', 'cu.client_id')
    .leftJoin('auth_account as tg', (j) => j.onRef('tg.user_id', '=', 'u.id').on('tg.provider_id', '=', TELEGRAM_PROVIDER))
    .select([
      'u.email', 'u.name', 'u.kind', 'u.status', 'tg.telegram_username',
      'cu.client_id', 'cu.role', 'cu.can_accept_quotes', 'cu.status as member_status',
      'c.display_name', 'c.status as client_status', 'c.exchange_access',
    ])
    .where('u.id', '=', userId)
    .executeTakeFirst();
  if (!row || row.kind !== 'CLIENT' || row.status !== 'ACTIVE') throw new DomainError('FORBIDDEN', 'this account cannot use the workspace');
  const placeholder = isTelegramPlaceholderEmail(row.email);
  const label = signInLabel(row.email, row.telegram_username);
  const who: SignedInAs = { userId, email: placeholder ? null : row.email, label, name: placeholder ? row.name.trim() || label : row.email };
  if (row.client_id === null) return { kind: 'NEW', ...who };
  if (row.member_status !== 'ACTIVE') throw new DomainError('FORBIDDEN', 'this account is not linked to a client');
  if (row.client_status !== 'ACTIVE') throw new DomainError('FORBIDDEN', 'this client is not active');
  return {
    kind: 'MEMBER',
    ...who,
    member: {
      userId,
      clientId: row.client_id,
      clientName: row.display_name!,
      role: row.role!,
      canAcceptQuotes: row.can_accept_quotes!,
      exchangeAccess: row.exchange_access!,
    },
  };
}

/**
 * The Exchange's own gate: a member of a client the desk has opened the Exchange for. Anyone else — a new trader
 * applicant, or a client that provides capacity only — is refused with `EXCHANGE_NOT_ENABLED`, which the app turns
 * into a way to Traders rather than an error.
 */
export async function portalAccess(ex: Executor, userId: string): Promise<PortalAccess> {
  return exchangeMember(await workspaceAccess(ex, userId));
}

/** The same gate, over access already read for this request — so a page inside the workspace does not read it twice. */
export function exchangeMember(access: WorkspaceAccess): PortalAccess {
  if (access.kind !== 'MEMBER') throw new DomainError('EXCHANGE_NOT_ENABLED', 'this account is not linked to a client');
  if (!access.member.exchangeAccess) throw new DomainError('EXCHANGE_NOT_ENABLED', 'the Exchange is not open for this account');
  return access.member;
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
