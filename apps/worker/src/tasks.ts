import type { Task, TaskList } from 'graphile-worker';
import type { Db } from '@inrp2p/db';
import { sealAudit } from '@inrp2p/audit';
import { dispatchOutbox, type OutboxHandler } from '@inrp2p/outbox';

/**
 * Durable job definitions (ARCHITECTURE §5). Phase 1 registers only foundation jobs;
 * domain handlers are added by later phases. Every task is retry-safe.
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
  return { outbox_dispatch: outboxDispatch, audit_seal: auditSeal };
}

/** Cron: sweep the outbox every minute (in case an enqueue signal was lost) and seal audit hourly. */
export const CRONTAB = ['* * * * * outbox_dispatch ?max=1&jobKey=outbox_dispatch', '7 * * * * audit_seal ?max=3&jobKey=audit_seal'].join('\n');
