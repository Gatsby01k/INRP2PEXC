import { DomainError } from '@inrp2p/kernel';
import type { Executor, RobotAnswers, RobotOutreach } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { type OperatorActor, operatorCommand } from '@inrp2p/identity';
import { PLAYBOOK_KEYS } from './playbooks.ts';

/**
 * What the robot may do on its own (ADR 0034 §2.1): reach people outside the app — not at all, as a dry run that decides
 * and records what it would send, or for real — answer questions with rules alone or with a model as well, the hours in
 * India it stays quiet, how many model answers a day it may give, and the playbooks a person switched off. Append-only:
 * the latest row is in force, and every change is a person's, with a reason, audited.
 */
export interface RobotPolicy {
  readonly id: string;
  readonly outreach: RobotOutreach;
  readonly answers: RobotAnswers;
  /** IST hours: nothing leaves the app from `quietFrom` up to `quietTo` (wrapping midnight). Equal: never quiet. */
  readonly quietFrom: number;
  readonly quietTo: number;
  readonly aiDailyLimit: number;
  readonly playbooksOff: readonly string[];
  readonly reason: string | null;
  readonly setBy: string;
  readonly setAt: string;
}

export async function currentRobotPolicy(ex: Executor): Promise<RobotPolicy> {
  const r = await ex.selectFrom('robot_policy').selectAll().orderBy('set_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  if (!r) throw new DomainError('NOT_FOUND', 'no robot policy is recorded');
  return {
    id: r.id, outreach: r.outreach, answers: r.answers, quietFrom: r.quiet_from, quietTo: r.quiet_to, aiDailyLimit: r.ai_daily_limit,
    playbooksOff: r.playbooks_off, reason: r.reason, setBy: r.set_by, setAt: r.set_at.toISOString(),
  };
}

export interface SetRobotPolicyPayload {
  readonly expectedPolicyId: string;
  /** Why, in the person's words — kept with the change. */
  readonly reason: string;
  readonly outreach?: RobotOutreach;
  readonly answers?: RobotAnswers;
  readonly quietFrom?: number;
  readonly quietTo?: number;
  readonly aiDailyLimit?: number;
  readonly playbooksOff?: readonly string[];
}

const OUTREACH: ReadonlySet<string> = new Set(['OFF', 'DRY_RUN', 'ON']);
const ANSWERS: ReadonlySet<string> = new Set(['RULES', 'AI']);
const hour = (v: unknown, field: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 23) throw new DomainError('INVALID_ARGUMENT', 'an hour is 0 to 23', { field });
  return v;
};

/**
 * `robot_policy.set` (`robot:configure`, step-up). Refuses a change made against a policy someone else has since changed
 * (`expectedPolicyId`), so two people never overwrite each other's switch unseen.
 */
export function setRobotPolicy(actor: OperatorActor) {
  return operatorCommand(actor, 'robot:configure', async (ctx, p: SetRobotPolicyPayload) => {
    const before = await currentRobotPolicy(ctx.tx);
    if (p.expectedPolicyId !== before.id) throw new DomainError('STALE_VERSION', 'the robot policy changed since you opened it; reload and try again');
    const reason = typeof p.reason === 'string' ? p.reason.trim() : '';
    if (reason.length < 3) throw new DomainError('INVALID_ARGUMENT', 'say why', { field: 'reason' });
    const outreach = p.outreach ?? before.outreach;
    if (!OUTREACH.has(outreach)) throw new DomainError('INVALID_ARGUMENT', 'outreach is OFF, DRY_RUN or ON', { field: 'outreach' });
    const answers = p.answers ?? before.answers;
    if (!ANSWERS.has(answers)) throw new DomainError('INVALID_ARGUMENT', 'answers are RULES or AI', { field: 'answers' });
    const quietFrom = p.quietFrom === undefined ? before.quietFrom : hour(p.quietFrom, 'quietFrom');
    const quietTo = p.quietTo === undefined ? before.quietTo : hour(p.quietTo, 'quietTo');
    const aiDailyLimit = p.aiDailyLimit ?? before.aiDailyLimit;
    if (!Number.isInteger(aiDailyLimit) || aiDailyLimit < 0 || aiDailyLimit > 10_000) throw new DomainError('INVALID_ARGUMENT', 'the daily limit is 0 to 10,000', { field: 'aiDailyLimit' });
    const off = [...new Set(p.playbooksOff ?? before.playbooksOff)].sort();
    for (const k of off) if (!PLAYBOOK_KEYS.has(k)) throw new DomainError('INVALID_ARGUMENT', `no playbook ${k}`, { field: 'playbooksOff' });
    const row = await ctx.tx.insertInto('robot_policy')
      .values({ outreach, answers, quiet_from: quietFrom, quiet_to: quietTo, ai_daily_limit: aiDailyLimit, playbooks_off: off, reason: reason.slice(0, 500), set_by: actor.userId })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, {
      action: 'robot_policy.set', entityType: 'robot_policy', entityId: row.id,
      before: { outreach: before.outreach, answers: before.answers, quiet: [before.quietFrom, before.quietTo], ai_daily_limit: before.aiDailyLimit, playbooks_off: before.playbooksOff },
      after: { outreach, answers, quiet: [quietFrom, quietTo], ai_daily_limit: aiDailyLimit, playbooks_off: off, reason },
    });
    return { id: row.id };
  });
}
