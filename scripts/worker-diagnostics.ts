/**
 * What the worker has been writing and failing at, read from the database without changing it: a read-only
 * transaction, aggregates only (no address, key, payload or person), safe to run against production.
 *
 *   DATABASE_URL=… node scripts/worker-diagnostics.ts [--json]
 *
 * Any login that can read the tables works; the queue rows need the worker's login or the migrator's
 * (`graphile_worker` belongs to inrp2p_worker). It reports:
 *
 * - the TRON providers as the worker last recorded them, and how the latest balance readings were made — with the
 *   reason the second source dropped out, grouped (`custody_balance_observation.detail`);
 * - write volume per day of the last week: idempotency keys by scope, audit events by action, readings by quality;
 * - the queue: jobs waiting, running and permanently failed, the failed ones grouped by task and by the first line of
 *   their error, each group classified by what replaying it would mean (see `classify`). Nothing is replayed or removed.
 */
import pg from 'pg';

const json = process.argv.includes('--json');
const url = process.env.DATABASE_URL ?? process.env.DATABASE_MIGRATOR_URL;
if (!url) {
  console.error('set DATABASE_URL (or DATABASE_MIGRATOR_URL)');
  process.exit(2);
}

/** Cron jobs of `apps/worker/src/tasks.ts`: each run re-reads the database and does whatever is due then. */
export const PERIODIC_TASKS = new Set([
  'outbox_dispatch', 'audit_seal', 'deposit_address_cooldown_release', 'quote_expiry_sweep', 'settlement_sla', 'escrow_deadlines',
  'settlement_reconcile', 'tron_scan', 'tron_confirm', 'tron_orphan_sweep', 'tron_backfill', 'custody_observe', 'trader_orders_sweep',
  'receipt_store_backfill', 'worker_heartbeat', 'audit_seal_export', 'onchain_cycle', 'network_fee_refresh', 'gasfree_fee_refresh',
  'trx_rate_refresh', 'reference_rate_refresh', 'rfq_sweep', 'telegram_deadlines',
]);

export type FailedJobClass = 'SUPERSEDED_PERIODIC_RUN' | 'SUPERSEDED_BY_SWEEP' | 'REVIEW';

/**
 * What a permanently failed queue row means for recovery:
 *
 * - `SUPERSEDED_PERIODIC_RUN` — one run of a periodic sweep (payload `{}` or cron metadata). It carried no work of its
 *   own: the next run re-read the database and did what was due. graphile-worker cleared its job key when the next run
 *   was added (`add_jobs`: a key whose job is not available is moved to the new job). Replaying it would only run the
 *   sweep once more; removing it loses only its error text.
 * - `SUPERSEDED_BY_SWEEP` — a `quote_expire` for one quote: `quote_expiry_sweep` expires every SENT quote past its time
 *   each minute, so the quote's state, not this row, says whether it was expired.
 * - `REVIEW` — anything else: a person reads it before anything is done with it.
 */
export function classify(task: string, payload: string): FailedJobClass {
  const empty = payload === '{}' || /^\{"_cron":/.test(payload);
  if (PERIODIC_TASKS.has(task) && empty) return 'SUPERSEDED_PERIODIC_RUN';
  if (task === 'quote_expire') return 'SUPERSEDED_BY_SWEEP';
  return 'REVIEW';
}

const firstLine = (s: string | null) => (s ?? '').split('\n')[0]!.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<uuid>').replace(/\b\d{4,}\b/g, '<n>').slice(0, 160);

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: url, application_name: 'inrp2p-worker-diagnostics' });
  await client.connect();
  const out: Record<string, unknown> = {};
  try {
    await client.query('begin transaction read only');
    await client.query("set local statement_timeout = '60s'");
    out.providers = (await client.query(`
      select provider, independence_group, last_ok_at, last_error_at, consecutive_failures, left(last_error, 200) as last_error
        from chain_provider_status order by provider`)).rows;
    out.readingsLast24h = (await client.query(`
      select quality, providers, count(*)::int as readings, max(observed_at) as latest
        from custody_balance_observation where observed_at > now() - interval '24 hours'
       group by quality, providers order by readings desc`)).rows;
    out.secondSourceMissingBecause = (await client.query(`
      select regexp_replace(left(detail, 200), '[0-9]{5,}', '<n>', 'g') as reason, count(*)::int as readings, max(observed_at) as latest
        from custody_balance_observation where observed_at > now() - interval '7 days' and detail is not null
       group by 1 order by readings desc limit 10`)).rows;
    out.keysPerDay = (await client.query(`
      select scope, round(count(*) / 7.0)::int as per_day from idempotency_key where created_at > now() - interval '7 days'
       group by scope order by count(*) desc limit 15`)).rows;
    out.auditPerDay = (await client.query(`
      select action, round(count(*) / 7.0)::int as per_day from audit_event where at > now() - interval '7 days'
       group by action order by count(*) desc limit 15`)).rows;
    out.tables = (await client.query(`
      select relname as table, n_live_tup::bigint as rows, pg_size_pretty(pg_total_relation_size(relid)) as size,
             seq_scan, seq_tup_read, idx_scan
        from pg_stat_user_tables where n_live_tup > 1000 or seq_tup_read > 1000000
       order by seq_tup_read desc limit 20`)).rows;
    try {
      const jobs = await client.query<{ task: string; payload: string; state: string; error: string | null; n: number; first: Date; last: Date }>(`
        select t.identifier as task, j.payload::text as payload,
               case when j.locked_at is not null then 'running' when j.attempts >= j.max_attempts then 'failed' else 'waiting' end as state,
               j.last_error as error, 1 as n, j.created_at as first, j.updated_at as last
          from graphile_worker._private_jobs j join graphile_worker._private_tasks t on t.id = j.task_id`);
      const groups = new Map<string, { task: string; state: string; class: FailedJobClass | null; error: string; jobs: number; first: Date; last: Date }>();
      for (const j of jobs.rows) {
        const cls = j.state === 'failed' ? classify(j.task, j.payload) : null;
        const error = j.state === 'failed' ? firstLine(j.error) : '';
        const key = `${j.task}|${j.state}|${cls}|${error}`;
        const g = groups.get(key) ?? { task: j.task, state: j.state, class: cls, error, jobs: 0, first: j.first, last: j.last };
        g.jobs += 1;
        if (j.first < g.first) g.first = j.first;
        if (j.last > g.last) g.last = j.last;
        groups.set(key, g);
      }
      out.queue = [...groups.values()].sort((a, b) => b.jobs - a.jobs);
    } catch (e) {
      out.queue = `not readable with this login: ${(e as Error).message}`;
      await client.query('rollback');
      await client.query('begin transaction read only');
    }
    await client.query('rollback');
  } finally {
    await client.end();
  }
  if (json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  for (const [k, v] of Object.entries(out)) {
    console.log(`\n== ${k}`);
    if (Array.isArray(v)) console.table(v);
    else console.log(v);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
