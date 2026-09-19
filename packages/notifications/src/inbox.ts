import { DomainError, requireUuid } from '@inrp2p/kernel';
import type { Db, Executor, NotificationKind } from '@inrp2p/db';
import type { NotificationDraft } from './messages.ts';

/**
 * A client's in-app inbox: what they were told, and whether they have seen it.
 *
 * Notifications are written by the outbox handler from events the domain already emitted, one row per event, so
 * a redelivered event cannot tell a client the same thing twice. Nothing in here decides anything or moves money.
 */
export interface ClientNotification {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
  readonly subjectRef: string | null;
  readonly href: string | null;
  readonly createdAt: string;
  readonly read: boolean;
}

export interface RecordInput extends NotificationDraft {
  readonly clientId: string;
  /** Null addresses every authorized user of the client; a user id narrows it to one person. */
  readonly userId?: string | null;
  readonly outboxEventId: string;
}

/**
 * Records one notification, keyed by the event that caused it. At-least-once delivery at the outbox boundary
 * means this runs again after a crash; the unique event id makes the second run a no-op rather than a duplicate.
 * Returns whether a row was written, which is what makes the handler's own idempotency visible in tests.
 */
export async function recordNotification(ex: Executor, input: RecordInput): Promise<boolean> {
  const written = await ex
    .insertInto('client_notification')
    .values({
      client_id: requireUuid(input.clientId, 'clientId'),
      user_id: input.userId ?? null,
      kind: input.kind,
      title: input.title,
      body: input.body,
      subject_ref: input.subjectRef,
      href: input.href,
      outbox_event_id: requireUuid(input.outboxEventId, 'outboxEventId'),
    })
    .onConflict((oc) => oc.column('outbox_event_id').doNothing())
    .returning('id')
    .executeTakeFirst();
  return Boolean(written);
}

export interface InboxQuery {
  readonly limit?: number;
  readonly unreadOnly?: boolean;
  /** The signed-in user, so notifications addressed to one person stay with that person. */
  readonly userId?: string;
}

export async function clientInbox(ex: Executor, clientId: string, query: InboxQuery = {}): Promise<readonly ClientNotification[]> {
  let q = ex
    .selectFrom('client_notification')
    .select(['id', 'kind', 'title', 'body', 'subject_ref', 'href', 'created_at', 'read_at'])
    .where('client_id', '=', requireUuid(clientId, 'clientId'))
    .orderBy('created_at', 'desc')
    // Messages written by one dispatch share a timestamp; the id keeps the inbox in one stable order.
    .orderBy('id', 'desc')
    .limit(Math.min(query.limit ?? 30, 100));
  if (query.unreadOnly) q = q.where('read_at', 'is', null);
  if (query.userId) q = q.where((eb) => eb.or([eb('user_id', 'is', null), eb('user_id', '=', query.userId!)]));
  else q = q.where('user_id', 'is', null);
  const rows = await q.execute();
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    subjectRef: r.subject_ref,
    href: r.href,
    createdAt: r.created_at.toISOString(),
    read: r.read_at !== null,
  }));
}

export async function unreadCount(ex: Executor, clientId: string, userId?: string): Promise<number> {
  let q = ex
    .selectFrom('client_notification')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('client_id', '=', requireUuid(clientId, 'clientId'))
    .where('read_at', 'is', null);
  q = userId ? q.where((eb) => eb.or([eb('user_id', 'is', null), eb('user_id', '=', userId)])) : q.where('user_id', 'is', null);
  const row = await q.executeTakeFirstOrThrow();
  return Number.parseInt(row.n, 10);
}

/**
 * Marks notifications read for one client.
 *
 * Deliberately not a domain command: it moves no money, changes no state of record and appends no audit event —
 * it records that a person looked at a message. The database allows it to touch `read_at` and nothing else, and
 * the client id is part of the predicate, so one client can never mark another's inbox.
 */
export async function markNotificationsRead(db: Db, clientId: string, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  if (ids.length > 200) throw new DomainError('INVALID_ARGUMENT', 'too many notifications in one request');
  const rows = await db
    .updateTable('client_notification')
    .set({ read_at: new Date() })
    .where('client_id', '=', requireUuid(clientId, 'clientId'))
    .where('read_at', 'is', null)
    .where(
      'id',
      'in',
      ids.map((id) => requireUuid(id, 'notificationId')),
    )
    .returning('id')
    .execute();
  return rows.length;
}
