import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { DomainError, requireUuid } from '@inrp2p/kernel';
import type { Db, Executor, RobotConsent, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import type { ClientActor, DomainCommand } from '@inrp2p/identity';

/**
 * A person's say over the robot (ADR 0034 §2.4). Inside the app the robot always shows what it knows — that is the
 * product. Outside it, it writes only with consent:
 *
 * - `SERVICE` (the default): about something the person started — an account half opened, a request that found no
 *   trader, a reserve not sent. Never about anything new.
 * - `ALL`: that, and what is new for them — someone waiting to buy what they sold before, today's rate after a month away.
 * - `NONE`: nothing outside the app.
 *
 * "Not now" on one of the robot's suggestions snoozes that playbook for the person; what of its news they opened is kept
 * so a mark of something new is never a mark of something seen.
 */
export interface RobotPreference {
  readonly outreach: RobotConsent;
  /** Playbook → until when it is snoozed (ISO). */
  readonly snoozed: Readonly<Record<string, string>>;
  readonly seenKey: string | null;
}

export const DEFAULT_PREFERENCE: RobotPreference = Object.freeze({ outreach: 'SERVICE' as const, snoozed: Object.freeze({}), seenKey: null });

function snoozedOf(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, until] of Object.entries(v as Record<string, unknown>)) if (typeof until === 'string' && /^[a-z_]{3,40}$/.test(k)) out[k] = until;
  return out;
}

export async function robotPreferenceOf(ex: Executor, userId: string): Promise<RobotPreference> {
  const r = await ex.selectFrom('robot_preference').select(['outreach', 'snoozed', 'seen_key']).where('user_id', '=', requireUuid(userId, 'userId')).executeTakeFirst();
  return r ? { outreach: r.outreach, snoozed: snoozedOf(r.snoozed), seenKey: r.seen_key } : DEFAULT_PREFERENCE;
}

/** Many people's preferences at once, for the sweep; a person with no row has the default. */
export async function robotPreferencesOf(ex: Executor, userIds: readonly string[]): Promise<Map<string, RobotPreference>> {
  const out = new Map<string, RobotPreference>();
  if (userIds.length === 0) return out;
  const rows = await ex.selectFrom('robot_preference').select(['user_id', 'outreach', 'snoozed', 'seen_key']).where('user_id', 'in', [...userIds]).execute();
  for (const r of rows) out.set(r.user_id, { outreach: r.outreach, snoozed: snoozedOf(r.snoozed), seenKey: r.seen_key });
  return out;
}

async function upsert(ex: Executor, userId: string, set: { outreach?: RobotConsent; snoozed?: Record<string, string>; via: 'APP' | 'TELEGRAM' | 'EMAIL' }): Promise<void> {
  await ex.insertInto('robot_preference')
    .values({ user_id: userId, ...(set.outreach ? { outreach: set.outreach } : {}), ...(set.snoozed ? { snoozed: JSON.stringify(set.snoozed) } : {}), set_via: set.via })
    .onConflict((oc) => oc.column('user_id').doUpdateSet({
      ...(set.outreach ? { outreach: set.outreach } : {}),
      ...(set.snoozed ? { snoozed: JSON.stringify(set.snoozed) } : {}),
      set_via: set.via,
      updated_at: sql<Date>`inrp2p_now()`,
    }))
    .execute();
}

/** Any active client-side person, a member of a client or not yet — consent is the person's own, not their client's. */
function selfCommand<P, R>(actor: ClientActor, handle: (ctx: TxContext, payload: P) => Promise<R>): DomainCommand<P, R> {
  return {
    authorize: async (ctx) => {
      if (ctx.actor.surface !== 'CLIENT') throw new DomainError('SESSION_SURFACE_MISMATCH');
      const u = await ctx.tx.selectFrom('auth_user').select(['kind', 'status']).where('id', '=', requireUuid(actor.userId, 'userId')).executeTakeFirst();
      if (!u || u.kind !== 'CLIENT' || u.status !== 'ACTIVE') throw new DomainError('FORBIDDEN', 'this account cannot use the workspace');
    },
    handle,
  };
}

const CONSENT: ReadonlySet<string> = new Set(['ALL', 'SERVICE', 'NONE']);

/** `robot.consent` — the person chooses what the robot may send them outside the app. */
export function setRobotConsent(actor: ClientActor) {
  return selfCommand(actor, async (ctx, p: { outreach: RobotConsent }) => {
    if (!CONSENT.has(p.outreach)) throw new DomainError('INVALID_ARGUMENT', 'ALL, SERVICE or NONE', { field: 'outreach' });
    const before = await robotPreferenceOf(ctx.tx, actor.userId);
    await upsert(ctx.tx, actor.userId, { outreach: p.outreach, via: 'APP' });
    await appendAudit(ctx, { action: 'robot.consent_set', entityType: 'auth_user', entityId: actor.userId, before: { outreach: before.outreach }, after: { outreach: p.outreach, via: 'APP' } });
    return { outreach: p.outreach };
  });
}

/** `robot.snooze` — "Not now" on one of the robot's suggestions: that playbook rests for the person for a few days. */
export function snoozeRobot(actor: ClientActor) {
  return selfCommand(actor, async (ctx, p: { playbook: string; days?: number }) => {
    if (typeof p.playbook !== 'string' || !/^[a-z_]{3,40}$/.test(p.playbook)) throw new DomainError('INVALID_ARGUMENT', 'no such suggestion', { field: 'playbook' });
    const days = p.days ?? 7;
    if (!Number.isInteger(days) || days < 1 || days > 30) throw new DomainError('INVALID_ARGUMENT', '1 to 30 days', { field: 'days' });
    const now = (await sql<{ now: Date }>`select inrp2p_now() as now`.execute(ctx.tx)).rows[0]!.now;
    const before = await robotPreferenceOf(ctx.tx, actor.userId);
    const snoozed: Record<string, string> = {};
    // Lapsed snoozes are dropped as a new one is written: the map only ever holds what is still resting.
    for (const [k, until] of Object.entries(before.snoozed)) if (Date.parse(until) > now.getTime()) snoozed[k] = until;
    const until = new Date(now.getTime() + days * 86_400_000).toISOString();
    snoozed[p.playbook] = until;
    await upsert(ctx.tx, actor.userId, { snoozed, via: 'APP' });
    await appendAudit(ctx, { action: 'robot.snoozed', entityType: 'auth_user', entityId: actor.userId, after: { playbook: p.playbook, until } });
    return { until };
  });
}

/**
 * The person opened the robot and saw what it had to say. Deliberately not a domain command — it moves nothing and
 * decides nothing; it records a look, as reading a notification does — and it writes only the person's own row.
 */
export async function markRobotSeen(db: Db, userId: string, key: string): Promise<void> {
  if (!/^[A-Za-z0-9:_-]{1,80}$/.test(key)) throw new DomainError('INVALID_ARGUMENT', 'not a key the robot gave', { field: 'key' });
  await db.insertInto('robot_preference')
    .values({ user_id: requireUuid(userId, 'userId'), seen_key: key, seen_at: sql<Date>`inrp2p_now()` })
    .onConflict((oc) => oc.column('user_id').doUpdateSet({ seen_key: key, seen_at: sql<Date>`inrp2p_now()` }))
    .execute();
}

export const quietTokenHash = (token: string): string => createHash('sha256').update(`inrp2p.robot-quiet:${token}`, 'utf8').digest('hex');

/**
 * The link at the foot of the robot's email (`/robot-quiet/{touchId}.{token}`): whoever holds it may stop the robot's
 * messages to the person it was sent to — and nothing else. The token is 192 random bits, only its hash is stored, it
 * belongs to that one email, and using it twice changes nothing. A system step, audited as the person's choice by email.
 */
export function quietByEmailLink() {
  return {
    authorize: async () => {},
    handle: async (ctx: TxContext, p: { link: string }): Promise<{ stopped: boolean }> => {
      const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{32})$/.exec(typeof p.link === 'string' ? p.link : '');
      if (!m) return { stopped: false };
      const touch = await ctx.tx.selectFrom('robot_touch').select(['user_id', 'quiet_token_hash']).where('id', '=', m[1]!).executeTakeFirst();
      if (!touch?.quiet_token_hash) return { stopped: false };
      // A constant-time comparison is not needed: the stored value is a hash of a random token, and a guess learns nothing.
      if (touch.quiet_token_hash !== quietTokenHash(m[2]!)) return { stopped: false };
      const before = await robotPreferenceOf(ctx.tx, touch.user_id);
      if (before.outreach !== 'NONE') {
        await upsert(ctx.tx, touch.user_id, { outreach: 'NONE', via: 'EMAIL' });
        await appendAudit(ctx, { action: 'robot.consent_set', entityType: 'auth_user', entityId: touch.user_id, before: { outreach: before.outreach }, after: { outreach: 'NONE', via: 'EMAIL' } });
      }
      return { stopped: true };
    },
  } satisfies DomainCommand<{ link: string }, { stopped: boolean }>;
}

/** `/quiet` in the bot's chat, from a person whose chat it is: no more messages from the robot outside the app. */
export function quietViaTelegram() {
  return {
    authorize: async () => {},
    handle: async (ctx: TxContext, p: { userId: string }): Promise<{ outreach: RobotConsent }> => {
      const before = await robotPreferenceOf(ctx.tx, p.userId);
      if (before.outreach !== 'NONE') {
        await upsert(ctx.tx, requireUuid(p.userId, 'userId'), { outreach: 'NONE', via: 'TELEGRAM' });
        await appendAudit(ctx, { action: 'robot.consent_set', entityType: 'auth_user', entityId: p.userId, before: { outreach: before.outreach }, after: { outreach: 'NONE', via: 'TELEGRAM' } });
      }
      return { outreach: 'NONE' };
    },
  } satisfies DomainCommand<{ userId: string }, { outreach: RobotConsent }>;
}
