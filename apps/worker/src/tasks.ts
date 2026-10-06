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
import { type ScannerDeps, observeBalances, runChainBackfill, runOrphanSweep, runTronConfirm, runTronScan } from '@inrp2p/scanner';
import { runTraderSweep } from '@inrp2p/traders';
import { type ReceiptObjectStore, type ReceiptPdfPrinter, receiptsNotStored, storeReceiptObjects } from '@inrp2p/reporting';
import { DomainError } from '@inrp2p/kernel';
import type { ChainMonitoring } from './config.ts';
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
export function buildTaskList(
  db: Db,
  handlers: readonly OutboxHandler[],
  opts: {
    policy?: Partial<QuotePolicy>;
    scanner?: ScannerDeps;
    monitoring?: ChainMonitoring;
    receipts?: { readonly store: ReceiptObjectStore; readonly pdf?: ReceiptPdfPrinter | null; readonly retainDays?: number | null };
    heartbeat?: WorkerIdentity;
  } = {},
): TaskList {
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
  // Phase 5 (STATE_MACHINES §5). Chain monitoring is either deliberately off, in which case the jobs do nothing
  // and that is healthy, or it is on, in which case it must actually work: an enabled-but-unconfigured worker
  // fails these jobs loudly instead of returning quietly and looking healthy.
  const chain = opts.scanner;
  const state = opts.monitoring?.state ?? (chain ? 'READY' : 'DISABLED');
  const chainJob = (run: (deps: ScannerDeps) => Promise<unknown>): Task => async () => {
    if (state === 'DISABLED') return;
    if (!chain || state === 'UNCONFIGURED') {
      throw new DomainError(
        'CHAIN_MONITORING_UNCONFIGURED',
        `TRON monitoring is enabled but not usable (${state}): ${(opts.monitoring?.reasons ?? ['no provider configuration']).join('; ')}`,
      );
    }
    await run(chain);
  };
  // DEGRADED (a single independent source) still scans and still confirms below the D-05 threshold; what it
  // cannot do is confirm a large amount, and `verifyCryptoTransfer` refuses that on its own.
  const tronScan = chainJob((deps) => runTronScan(db, deps));
  const tronConfirm = chainJob((deps) => runTronConfirm(db, deps));
  const tronOrphanSweep = chainJob((deps) => runOrphanSweep(db, deps));
  // TD-06: one bounded slice of a requested historical backfill per run; nothing to do is the common case.
  const tronBackfill = chainJob((deps) => runChainBackfill(db, deps));
  // B2: what each exchange address actually holds, as of a solidified block, from every configured provider. A USDT
  // payout or refund leaves an address only against a fresh, usable reading; this keeps one there.
  const custodyObserve = chainJob((deps) => observeBalances(db, { sources: deps.providers, contract: deps.chain.tokenContract }));
  // Traders (docs/TRADERS.md): offers that lapsed are routed on, ended holds give capacity back, started orders
  // catch up with their route obligation (completed, cancelled, the trader's side confirmed).
  // One order's failure never stops the rest (each is its own step); the failures are logged here, retried next
  // minute, and an order that keeps failing surfaces as the `trader_orders_overdue` health signal.
  const traderOrdersSweep: Task = async (_payload, helpers) => {
    const report = await runTraderSweep(db);
    for (const f of report.failures) helpers.logger.error(`trader_orders_sweep: ${f.step} ${f.orderId} failed (${f.code}): ${f.message}`);
  };
  // TD-12: receipts issued before a bucket was configured, or whose write failed, are stored here, a few at a time.
  const receiptStoreBackfill: Task = async (_payload, helpers) => {
    const storage = opts.receipts;
    if (!storage) return;
    for (const id of await receiptsNotStored(db, 50)) {
      try {
        await storeReceiptObjects(db, storage.store, id, { pdf: storage.pdf ?? null, retainDays: storage.retainDays ?? null });
      } catch (e) {
        helpers.logger.error(`receipt_store_backfill: receipt ${id} not stored (${(e as { code?: string }).code ?? 'ERROR'})`);
      }
    }
  };
  // E3: the worker says it is alive, and what it runs, once a minute (readiness and `worker_heartbeat_age_seconds`).
  const workerHeartbeat: Task = async () => {
    if (opts.heartbeat) await recordHeartbeat(db, opts.heartbeat);
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
    tron_backfill: tronBackfill,
    custody_observe: custodyObserve,
    trader_orders_sweep: traderOrdersSweep,
    receipt_store_backfill: receiptStoreBackfill,
    worker_heartbeat: workerHeartbeat,
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
 * orphans every 10 minutes; a requested historical backfill reads one bounded slice a minute (TD-06). The balance
 * of every exchange address that decides something is read every minute (B2: a reading older than five minutes
 * stops USDT payouts from that address). The trader sweep runs every minute (an offer's own expiry is minutes,
 * not hours).
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
  '* * * * * tron_backfill ?max=1&jobKey=tron_backfill',
  '* * * * * custody_observe ?max=1&jobKey=custody_observe',
  '* * * * * trader_orders_sweep ?max=1&jobKey=trader_orders_sweep',
  '41 * * * * receipt_store_backfill ?max=2&jobKey=receipt_store_backfill',
  '* * * * * worker_heartbeat ?max=1&jobKey=worker_heartbeat',
].join('\n');

/** Who this worker is and what it runs — names and states only, never a secret, an address or a key. */
export interface WorkerIdentity {
  readonly workerId: string;
  readonly startedAt: Date;
  readonly release: string | null;
  readonly config: Readonly<Record<string, string>>;
}

export async function recordHeartbeat(db: Db, id: WorkerIdentity): Promise<void> {
  await sql`
    insert into worker_heartbeat (worker_id, started_at, beat_at, release, config)
    values (${id.workerId}, ${id.startedAt}, inrp2p_now(), ${id.release}, ${JSON.stringify(id.config)}::jsonb)
    on conflict (worker_id) do update set started_at = excluded.started_at, beat_at = excluded.beat_at, release = excluded.release, config = excluded.config`.execute(db);
}

