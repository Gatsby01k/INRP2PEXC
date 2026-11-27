import { sql } from 'kysely';
import { DomainError, optionalText, requireUuid } from '@inrp2p/kernel';
import type { Executor, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import type { ClientActor, DomainCommand } from '@inrp2p/identity';

/**
 * Web Push (ADR 0033 §2.6): a person turns on notifications in a browser of theirs, and that browser is told what the
 * person's Telegram would be told. A subscription is a person's — a client user's — like a Telegram link; it carries no
 * authority, opens nothing by itself and is dropped the moment the push service says it is gone.
 */
async function activeMember(ex: Executor, userId: string): Promise<string> {
  const row = await ex.selectFrom('client_user as cu').innerJoin('auth_user as u', 'u.id', 'cu.user_id')
    .select(['cu.id', 'cu.status', 'u.status as user_status', 'u.kind'])
    .where('cu.user_id', '=', requireUuid(userId, 'userId')).executeTakeFirst();
  if (!row || row.status !== 'ACTIVE' || row.user_status !== 'ACTIVE' || row.kind !== 'CLIENT') throw new DomainError('FORBIDDEN', 'this account is not linked to a client');
  return row.id;
}

function personCommand<P, R>(actor: ClientActor, handle: (ctx: TxContext, payload: P, clientUserId: string) => Promise<R>): DomainCommand<P, R> {
  let clientUserId: string | undefined;
  return {
    authorize: async (ctx) => {
      if (ctx.actor.surface !== 'CLIENT') throw new DomainError('SESSION_SURFACE_MISMATCH');
      clientUserId = await activeMember(ctx.tx, actor.userId);
    },
    handle: async (ctx, payload) => {
      if (!clientUserId) throw new Error('push command executed without authorization');
      return handle(ctx, payload, clientUserId);
    },
  };
}

export interface PushSubscribePayload {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly userAgent?: string | null;
}

const B64U = /^[A-Za-z0-9_-]+$/;

/**
 * `push.subscribe` — this browser of the signed-in person is told from now on. The same browser subscribing again is
 * the same subscription (by its endpoint), now this person's and active.
 */
export function subscribePush(actor: ClientActor) {
  return personCommand(actor, async (ctx, p: PushSubscribePayload, clientUserId) => {
    let endpoint: URL;
    try {
      endpoint = new URL(String(p.endpoint));
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'not a push endpoint', { field: 'endpoint' });
    }
    if (endpoint.protocol !== 'https:' || endpoint.toString().length > 1000) throw new DomainError('INVALID_ARGUMENT', 'not a push endpoint', { field: 'endpoint' });
    const p256dh = String(p.p256dh ?? '');
    const auth = String(p.auth ?? '');
    if (!B64U.test(p256dh) || p256dh.length < 80 || p256dh.length > 100 || !B64U.test(auth) || auth.length < 16 || auth.length > 30) {
      throw new DomainError('INVALID_ARGUMENT', 'the browser’s keys are not valid', { field: 'keys' });
    }
    const userAgent = optionalText(p.userAgent ?? null, 'userAgent', 200);
    const row = await ctx.tx.insertInto('push_subscription')
      .values({ client_user_id: clientUserId, endpoint: endpoint.toString(), p256dh, auth, user_agent: userAgent })
      .onConflict((oc) => oc.column('endpoint').doUpdateSet({
        client_user_id: clientUserId, p256dh, auth, user_agent: userAgent, status: 'ACTIVE', failures: 0, revoked_at: null, revoke_reason: null,
      }))
      .returning(['id'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, { action: 'push.subscribed', entityType: 'push_subscription', entityId: row.id, after: { client_user_id: clientUserId, origin: endpoint.origin } });
    return { subscriptionId: row.id };
  });
}

/** `push.unsubscribe` — this browser is told nothing more. Only the person's own subscription. */
export function unsubscribePush(actor: ClientActor) {
  return personCommand(actor, async (ctx, p: { endpoint: string }, clientUserId) => {
    const row = await ctx.tx.updateTable('push_subscription')
      .set({ status: 'REVOKED', revoked_at: sql<Date>`inrp2p_now()`, revoke_reason: 'turned off by its person' })
      .where('endpoint', '=', String(p.endpoint)).where('client_user_id', '=', clientUserId).where('status', '=', 'ACTIVE')
      .returning(['id']).executeTakeFirst();
    if (row) await appendAudit(ctx, { action: 'push.unsubscribed', entityType: 'push_subscription', entityId: row.id, after: { by: 'PERSON' } });
    return { off: true };
  });
}

/** Whether a person has notifications on in any browser — the Account screen and the wait's "Tell me" say so. */
export async function pushOnFor(ex: Executor, userId: string): Promise<boolean> {
  const r = await ex.selectFrom('push_subscription as s').innerJoin('client_user as cu', 'cu.id', 's.client_user_id')
    .select('s.id').where('cu.user_id', '=', requireUuid(userId, 'userId')).where('s.status', '=', 'ACTIVE').executeTakeFirst();
  return r !== undefined;
}
