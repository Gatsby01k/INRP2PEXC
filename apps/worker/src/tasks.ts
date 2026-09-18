import type { Task, TaskList } from 'graphile-worker';
import type { Db } from '@inrp2p/db';
import { sealAudit } from '@inrp2p/audit';
import { dispatchOutbox, type OutboxHandler } from '@inrp2p/outbox';
import { randomUUID } from 'node:crypto';
import { executeCommand } from '@inrp2p/commands';
import type { TxContext } from '@inrp2p/db';
import { releasePastDayReservations } from '@inrp2p/inr-accounts';
import { releaseCooledDownAddresses } from '@inrp2p/treasury';
import { type QuotePolicy, expireQuote, runExpirySweep } from '@inrp2p/quotes';
import { runReconciliation, runSettlementSla } from '@inrp2p/settlement';
import { type ScannerDeps, runOrphanSweep, runTronConfirm, runTronScan } from '@inrp2p/scanner';
import { sql } from 'kysely';

/** Runs a system job step through the command pipeline (one transaction, audit, retry-safe state guards). */
function systemCommand<R>(db: Db, name: string, fn: (ctx: TxContext) => Promise<R>): Promise<R> {
  const key = randomUUID();
  return executeCommand(db, { authorize: async () => {}, handle: fn }, { name, actor: { type: 'SYSTEM', id: null, surface: 'SYSTEM' }, payload: { run: key }, idempotencyKey: key, financial: true }).then((o) => o.result);
}

/**
 * Durable job definitions (ARCHITECTURE §5): foundation jobs (Phase 1) and reference-data maintenance jobs
 * (Phase 2). Domain handlers for later phases are added with them. Every task is retry-safe.
 */
export function buildTaskList(db: Db, handlers: readonly OutboxHandler[], opts: { policy?: Partial<QuotePolicy>; scanner?: ScannerDeps } = {}): TaskList {
  const outboxDispatch: Task = async () => {
    const report = await dispatchOutbox(db, handlers);
    if (report.claimed === 50) {
      // More work is likely pending; the job key coalesces duplicates.
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
  // STATE_MACHINES §2: a SENT quote expires at `expires_at`. The job is scheduled for that instant by the
  // `quote.sent` handler; it is idempotent and refuses to act before database time has passed the expiry.
  const quoteExpire: Task = async (payload) => {
    const quoteId = (payload as { quoteId?: unknown } | undefined)?.quoteId;
    if (typeof quoteId !== 'string') throw new Error('quote_expire requires a quoteId');
    await expireQuote(db, quoteId);
  };
  // Safety net: quotes whose scheduled job was lost, inactive requests, spent rate-limit windows.
  const quoteExpirySweep: Task = async () => {
    await runExpirySweep(db, opts.policy ? { policy: opts.policy } : {});
  };
  // FI-44 / FI-64: the ledger balances globally and every open obligation matches its ledger lines.
  const reconcile: Task = async () => {
    await runReconciliation(db);
  };
  // SLA sweep: payouts in flight too long and route obligations past their SLA become desk cases.
  const settlementSla: Task = async () => {
    await runSettlementSla(db);
  };
  // Phase 5 (STATE_MACHINES §5): the chain jobs exist only when TRON providers are configured. Without them
  // nothing pretends to scan — USDT confirmation simply stays unavailable (TD-05).
  const chain = opts.scanner;
  const tronScan: Task = async () => {
    if (!chain) return;
    await runTronScan(db, chain);
  };
  const tronConfirm: Task = async () => {
    if (!chain) return;
    await runTronConfirm(db, chain);
  };
  const tronOrphanSweep: Task = async () => {
    if (!chain) return;
    await runOrphanSweep(db, chain);
  };
  return {
    outbox_dispatch: outboxDispatch,
    audit_seal: auditSeal,
    capacity_day_rollover: capacityDayRollover,
    deposit_address_cooldown_release: depositCooldownRelease,
    quote_expire: quoteExpire,
    quote_expiry_sweep: quoteExpirySweep,
    settlement_reconcile: reconcile,
    settlement_sla: settlementSla,
    tron_scan: tronScan,
    tron_confirm: tronConfirm,
    tron_orphan_sweep: tronOrphanSweep,
  };
}

/**
 * Schedules the expiry job of a quote at its `expires_at` (transactional, inside the dispatcher's transaction).
 * The job key makes a re-dispatch replace rather than duplicate the schedule.
 */
export function quoteExpiryScheduler(db: Db): OutboxHandler {
  return {
    name: 'quote_expiry_scheduler',
    handles: (type) => type === 'quote.sent',
    run: async (event) => {
      const payload = event.payload as { quoteId?: unknown; expiresAt?: unknown };
      if (typeof payload.quoteId !== 'string' || typeof payload.expiresAt !== 'string') throw new Error('quote.sent payload is missing quoteId/expiresAt');
      await sql`
        select graphile_worker.add_job(
          'quote_expire',
          json_build_object('quoteId', ${payload.quoteId}::text),
          run_at => ${payload.expiresAt}::timestamptz,
          job_key => ${`quote_expire:${payload.quoteId}`}::text,
          max_attempts => 5)`.execute(db);
    },
  };
}

/**
 * Cron (UTC): sweep the outbox every minute, seal audit hourly, release past-IST-day capacity reservations every
 * 5 minutes (IST midnight is 18:30 UTC; frequent runs keep the job simple and idempotent), release cooled-down
 * deposit addresses every 10 minutes, sweep quote/request expiry every minute, sweep settlement SLAs every
 * 15 minutes and reconcile the ledger nightly. The TRON scanner reads new transfers every minute, offers
 * detected transfers to the verifier every minute (a transfer solidifies in about a minute) and sweeps for
 * orphans every 10 minutes.
 */
export const CRONTAB = [
  '* * * * * outbox_dispatch ?max=1&jobKey=outbox_dispatch',
  '7 * * * * audit_seal ?max=3&jobKey=audit_seal',
  '*/5 * * * * capacity_day_rollover ?max=3&jobKey=capacity_day_rollover',
  '*/10 * * * * deposit_address_cooldown_release ?max=3&jobKey=deposit_address_cooldown_release',
  '* * * * * quote_expiry_sweep ?max=1&jobKey=quote_expiry_sweep',
  '*/15 * * * * settlement_sla ?max=2&jobKey=settlement_sla',
  '23 1 * * * settlement_reconcile ?max=2&jobKey=settlement_reconcile',
  '* * * * * tron_scan ?max=1&jobKey=tron_scan',
  '* * * * * tron_confirm ?max=1&jobKey=tron_confirm',
  '*/10 * * * * tron_orphan_sweep ?max=2&jobKey=tron_orphan_sweep',
].join('\n');
