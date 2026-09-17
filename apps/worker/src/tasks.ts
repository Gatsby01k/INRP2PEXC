import type { Task, TaskList } from 'graphile-worker';
import type { Db } from '@inrp2p/db';
import { sealAudit } from '@inrp2p/audit';
import { dispatchOutbox, type OutboxHandler } from '@inrp2p/outbox';
import { randomUUID } from 'node:crypto';
import { executeCommand } from '@inrp2p/commands';
import type { TxContext } from '@inrp2p/db';
import { releasePastDayReservations } from '@inrp2p/inr-accounts';
import { releaseCooledDownAddresses } from '@inrp2p/treasury';

/** Runs a system job step through the command pipeline (one transaction, audit, retry-safe state guards). */
function systemCommand<R>(db: Db, name: string, fn: (ctx: TxContext) => Promise<R>): Promise<R> {
  const key = randomUUID();
  return executeCommand(db, { authorize: async () => {}, handle: fn }, { name, actor: { type: 'SYSTEM', id: null, surface: 'SYSTEM' }, payload: { run: key }, idempotencyKey: key, financial: true }).then((o) => o.result);
}

/**
 * Durable job definitions (ARCHITECTURE §5): foundation jobs (Phase 1) and reference-data maintenance jobs
 * (Phase 2). Domain handlers for later phases are added with them. Every task is retry-safe.
 */
export function buildTaskList(db: Db, handlers: readonly OutboxHandler[]): TaskList {
  const outboxDispatch: Task = async () => {
    const report = await dispatchOutbox(db, handlers);
    if (report.claimed === 50) {
      // More work is likely pending; the job key coalesces duplicates.
      const { sql } = await import('kysely');
      await sql`select graphile_worker.add_job('outbox_dispatch', '{}'::json, job_key => 'outbox_dispatch')`.execute(db);
    }
  };
  const auditSeal: Task = async () => {
    await sealAudit(db);
  };
  // STATE_MACHINES §6: reservations of past IST days are released, never carried into today.
  const capacityDayRollover: Task = async () => {
    await systemCommand(db, 'capacity.day_rollover', (ctx) => releasePastDayReservations(ctx));
  };
  // STATE_MACHINES §11: cooled-down POOL addresses return to AVAILABLE, DERIVED addresses retire.
  const depositCooldownRelease: Task = async () => {
    await systemCommand(db, 'deposit_address.cooldown_release', (ctx) => releaseCooledDownAddresses(ctx));
  };
  return { outbox_dispatch: outboxDispatch, audit_seal: auditSeal, capacity_day_rollover: capacityDayRollover, deposit_address_cooldown_release: depositCooldownRelease };
}

/**
 * Cron (UTC): sweep the outbox every minute, seal audit hourly, release past-IST-day capacity reservations every
 * 5 minutes (IST midnight is 18:30 UTC; frequent runs keep the job simple and idempotent), release cooled-down
 * deposit addresses every 10 minutes.
 */
export const CRONTAB = [
  '* * * * * outbox_dispatch ?max=1&jobKey=outbox_dispatch',
  '7 * * * * audit_seal ?max=3&jobKey=audit_seal',
  '*/5 * * * * capacity_day_rollover ?max=3&jobKey=capacity_day_rollover',
  '*/10 * * * * deposit_address_cooldown_release ?max=3&jobKey=deposit_address_cooldown_release',
].join('\n');
