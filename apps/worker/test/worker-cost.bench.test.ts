import { createServer, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { Logger, run, type Runner } from 'graphile-worker';
import { createDb, createPool } from '@inrp2p/db';
import { FAKE_USDT_CONTRACT, FakeTronGrid } from '@inrp2p/adapters/testing';
import { TronSendNetwork } from '@inrp2p/adapters';
import { acknowledgedSignalHandler, clientNotificationHandler, traderNotificationHandler } from '@inrp2p/notifications';
import { traderReviewHandler, traderRoutingHandler } from '@inrp2p/traders';
import { rfqAwardHandler } from '@inrp2p/quotes';
import { receiptHandler } from '@inrp2p/reporting';
import { destinationArchivedHandler } from '@inrp2p/settlement';
import { CRONTAB, buildTaskList, onchainWakeup, quoteExpiryScheduler, recordHeartbeat } from '../src/tasks.ts';
import { chainMonitoringFromEnv } from '../src/config.ts';
import { createRailsWorld, type RailsWorld } from '../../../test/integration/rails-world.ts';

/**
 * What the worker costs the database and the TRON providers while the exchange is quiet — the production shape the
 * owner pays for every minute of the month (Neon compute, provider quotas).
 *
 * The real worker task list and the real crontab run under graphile-worker, as `apps/worker/src/main.ts` runs them,
 * through the worker's own database login, against a seeded exchange (treasury wallets, HD account, fees, TRX price)
 * and two TronGrid-compatible HTTP providers in separate independence groups that answer over real sockets with a
 * fixed latency while their chain advances a block every three seconds. Cron fires on real minute boundaries, so a
 * run takes BENCH_MINUTES of wall time.
 *
 *   BENCH_MINUTES=6 BENCH_HISTORY=1 BENCH_OUT=idle.json TEST_DATABASE_URL=… pnpm vitest run --project bench
 *
 * BENCH_HISTORY=1 first loads production-sized history (idempotency keys, audit events, balance observations and
 * permanently failed queue rows in the counts production reported), so query plans meet real table sizes.
 * Nothing here is a measurement of production: it is the same code on a local PostgreSQL 18.
 */

const MINUTES = Number.parseInt(process.env.BENCH_MINUTES ?? '5', 10);
const HISTORY = process.env.BENCH_HISTORY === '1';
const LATENCY_PRIMARY = Number.parseInt(process.env.BENCH_LATENCY_PRIMARY_MS ?? '60', 10);
const LATENCY_SECONDARY = Number.parseInt(process.env.BENCH_LATENCY_SECONDARY_MS ?? '150', 10);
const POLL_MS = Number.parseInt(process.env.BENCH_POLL_MS ?? '2000', 10);
const enabled = process.env.BENCH_MINUTES !== undefined;

function urlFor(base: string, db: string, user?: { name: string; password: string }): string {
  const u = new URL(base);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}

/** A FakeTronGrid behind a real HTTP socket, answering after `latencyMs`, its head moving every three seconds. */
async function serveGrid(grid: FakeTronGrid, latencyMs: number): Promise<{ url: string; server: Server; tick: NodeJS.Timeout }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    await new Promise((r) => setTimeout(r, latencyMs));
    const answer = await grid.fetch(`${grid.baseUrl}${req.url}`, { method: req.method ?? 'GET', ...(chunks.length ? { body: Buffer.concat(chunks).toString('utf8') } : {}) });
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(await answer.text());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const tick = setInterval(() => grid.advance(1n), 3_000);
  return { url: `http://127.0.0.1:${port}`, server, tick };
}

const byPath = (requests: readonly string[]) => {
  const out: Record<string, number> = {};
  for (const r of requests) {
    const path = r.replace(/\/v1\/accounts\/[^/]+\//, '/v1/accounts/{address}/').split('?')[0]!;
    out[path] = (out[path] ?? 0) + 1;
  }
  return out;
};

describe.skipIf(!enabled)('worker cost while the exchange is quiet', () => {
  let w: RailsWorld;
  let admin: pg.Client;
  let runner: Runner | undefined;
  const grids: { grid: FakeTronGrid; served: Awaited<ReturnType<typeof serveGrid>> }[] = [];
  let workerPool: pg.Pool;

  beforeAll(async () => {
    w = await createRailsWorld('bench');
    admin = new pg.Client({ connectionString: urlFor(inject('pgAdminUrl'), w.t.name) });
    await admin.connect();
    await admin.query('create extension if not exists pg_stat_statements');
    if (HISTORY) await loadHistory(admin);
    for (const latency of [LATENCY_PRIMARY, LATENCY_SECONDARY]) {
      const grid = new FakeTronGrid({ head: 80_000_000n, genesisMs: Date.now() - 80_000_000 * 3_000 });
      grids.push({ grid, served: await serveGrid(grid, latency) });
    }
  }, 600_000);

  afterAll(async () => {
    await runner?.stop().catch(() => undefined);
    for (const g of grids) {
      clearInterval(g.served.tick);
      g.served.server.close();
    }
    await admin?.end().catch(() => undefined);
  });

  it(`runs ${MINUTES} quiet minutes and reports what they cost`, async () => {
    const workerUrl = urlFor(inject('pgAdminUrl'), w.t.name, { name: 'inrp2p_worker_login', password: 'inrp2p-test-only' });
    workerPool = createPool({ connectionString: workerUrl, applicationName: 'inrp2p-worker', max: 10 });
    const db = createDb(workerPool);
    const monitoring = chainMonitoringFromEnv({
      INRP2P_TRON_MONITORING: 'enabled',
      INRP2P_USDT_CONTRACT: FAKE_USDT_CONTRACT,
      INRP2P_TRON_PRIMARY_URL: grids[0]!.served.url, INRP2P_TRON_PRIMARY_NAME: 'trongrid', INRP2P_TRON_PRIMARY_GROUP: 'trongrid',
      INRP2P_TRON_SECONDARY_URL: grids[1]!.served.url, INRP2P_TRON_SECONDARY_NAME: 'quicknode', INRP2P_TRON_SECONDARY_GROUP: 'quicknode',
    });
    expect(monitoring.state).toBe('READY');
    const config = monitoring.config!;
    const rails = { network: new TronSendNetwork(config.gateways), signer: null, chain: config.chain };
    const identity = { workerId: `${hostname()}:bench`, startedAt: new Date(), release: 'bench', config: { chain: monitoring.state } };
    await recordHeartbeat(db, identity);

    const handlers = [quoteExpiryScheduler(db), clientNotificationHandler(db), traderNotificationHandler(db), traderRoutingHandler(db), traderReviewHandler(db), rfqAwardHandler(db), receiptHandler(db, undefined), destinationArchivedHandler(db), acknowledgedSignalHandler(), onchainWakeup(db)];
    const taskList = buildTaskList(db, handlers, { monitoring, scanner: config, heartbeat: identity, rails });

    // Start five seconds before a minute boundary and stop five seconds before the last one after it, so the run
    // covers exactly MINUTES cron ticks of every per-minute job.
    const toBoundary = (60_000 - (Date.now() % 60_000) - 5_000 + 60_000) % 60_000;
    await new Promise((r) => setTimeout(r, toBoundary));
    await admin.query('select pg_stat_statements_reset()');
    await admin.query('select pg_stat_reset()');
    for (const g of grids) g.grid.requests.length = 0;
    const walStart = (await admin.query<{ lsn: string }>('select pg_current_wal_lsn()::text as lsn')).rows[0]!.lsn;
    const deadBefore = await deadJobs(admin);
    const started = Date.now();

    runner = await run({
      connectionString: workerUrl,
      concurrency: 5,
      noHandleSignals: true,
      pollInterval: POLL_MS,
      taskList,
      crontab: CRONTAB,
      logger: new Logger(() => () => {}),
    });
    await new Promise((r) => setTimeout(r, MINUTES * 60_000));
    await runner.stop();
    runner = undefined;
    await workerPool.end();
    const wallMs = Date.now() - started;
    await new Promise((r) => setTimeout(r, 1_500));

    const walBytes = Number((await admin.query<{ b: string }>('select pg_wal_lsn_diff(pg_current_wal_lsn(), $1::pg_lsn)::text as b', [walStart])).rows[0]!.b);
    const statements = (await admin.query<{ calls: string; ms: string; rows: string; wal: string }>(`
      select sum(calls)::text as calls, round(sum(total_exec_time)::numeric, 1)::text as ms, sum(rows)::text as rows, sum(wal_bytes)::text as wal
        from pg_stat_statements s join pg_database d on d.oid = s.dbid where d.datname = current_database()`)).rows[0]!;
    const top = (await admin.query<{ calls: string; ms: string; query: string }>(`
      select calls::text, round(total_exec_time::numeric, 1)::text as ms, left(regexp_replace(query, '\\s+', ' ', 'g'), 140) as query
        from pg_stat_statements s join pg_database d on d.oid = s.dbid where d.datname = current_database()
       order by calls desc limit 25`)).rows;
    const slow = (await admin.query<{ calls: string; ms: string; mean: string; query: string }>(`
      select calls::text, round(total_exec_time::numeric, 1)::text as ms, round(mean_exec_time::numeric, 3)::text as mean, left(regexp_replace(query, '\\s+', ' ', 'g'), 140) as query
        from pg_stat_statements s join pg_database d on d.oid = s.dbid where d.datname = current_database()
       order by total_exec_time desc limit 15`)).rows;
    const tables = (await admin.query<{ table: string; ins: string; upd: string; del: string; seq_scan: string; seq_tup_read: string; idx_scan: string; live: string }>(`
      select schemaname || '.' || relname as table, n_tup_ins::text as ins, n_tup_upd::text as upd, n_tup_del::text as del,
             seq_scan::text, seq_tup_read::text, coalesce(idx_scan, 0)::text as idx_scan, n_live_tup::text as live
        from pg_stat_all_tables
       where schemaname in ('public', 'graphile_worker') and (n_tup_ins + n_tup_upd + n_tup_del + seq_scan + coalesce(idx_scan, 0)) > 0
       order by (n_tup_ins + n_tup_upd + n_tup_del) desc, seq_tup_read desc`)).rows;
    const deadAfter = await deadJobs(admin);
    const observations = (await admin.query<{ quality: string; n: string }>(`
      select quality, count(*)::text as n from custody_balance_observation where observed_at >= to_timestamp($1 / 1000.0) group by quality order by quality`, [started])).rows;
    const keysByScope = (await admin.query<{ scope: string; n: string }>(`
      select scope, count(*)::text as n from idempotency_key where created_at >= to_timestamp($1 / 1000.0) group by scope order by count(*) desc`, [started])).rows;
    const auditByAction = (await admin.query<{ action: string; n: string }>(`
      select action, count(*)::text as n from audit_event where at >= to_timestamp($1 / 1000.0) group by action order by count(*) desc`, [started])).rows;
    const providers = (await admin.query('select provider, last_ok_at is not null as ok, consecutive_failures, last_error from chain_provider_status order by provider')).rows;

    const perMinute = (n: number) => Math.round((n / (wallMs / 60_000)) * 10) / 10;
    const writes = tables.reduce((t, r) => t + Number(r.ins) + Number(r.upd) + Number(r.del), 0);
    const report = {
      minutes: Math.round((wallMs / 60_000) * 100) / 100,
      history: HISTORY,
      pollIntervalMs: POLL_MS,
      perMinute: {
        statements: perMinute(Number(statements.calls)),
        dbExecMs: perMinute(Number(statements.ms)),
        rowWrites: perMinute(writes),
        walBytes: perMinute(walBytes),
        tronRequestsPrimary: perMinute(grids[0]!.grid.requests.length),
        tronRequestsSecondary: perMinute(grids[1]!.grid.requests.length),
      },
      totals: { statements: Number(statements.calls), dbExecMs: Number(statements.ms), statementWalBytes: Number(statements.wal), walBytes, rowWrites: writes, deadJobsCreated: deadAfter - deadBefore },
      tron: { primary: byPath(grids[0]!.grid.requests), secondary: byPath(grids[1]!.grid.requests) },
      observations,
      keysByScope,
      auditByAction,
      providers,
      tables,
      topByCalls: top,
      topByTime: slow,
    };
    console.log(JSON.stringify(report.perMinute), JSON.stringify(report.totals));
    if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, JSON.stringify(report, null, 2));
  }, (MINUTES + 3) * 60_000);
});

async function deadJobs(c: pg.Client): Promise<number> {
  return Number((await c.query<{ n: string }>('select count(*)::text as n from graphile_worker._private_jobs where not is_available and locked_at is null')).rows[0]!.n);
}

/**
 * Production-sized history (owner's Neon findings, 2026-11-22): ~265k idempotency keys, ~165k audit events, ~138k
 * custody balance observations and ~4,100 permanently failed queue rows — written straight into the tables, spread over
 * the forty days before now, so indexes and plans meet the volumes production has.
 */
async function loadHistory(c: pg.Client): Promise<void> {
  const wallets = (await c.query<{ address: string }>(`select address from treasury_wallet where network = 'TRON' and status = 'ACTIVE' order by created_at`)).rows.map((r) => r.address);
  await c.query(`
    insert into idempotency_key (scope, key, request_hash, actor_id, status, response, created_at, completed_at)
    select 'custody.observe_balance', gen_random_uuid()::text, encode(sha256(g::text::bytea), 'hex'), null, 'COMPLETED', '{"result":{}}'::jsonb,
           now() - make_interval(secs => g * 13), now() - make_interval(secs => g * 13)
      from generate_series(1, 265000) g`);
  await c.query(`
    insert into audit_event (at, actor_type, actor_id, surface, action, entity_type, entity_id, after, correlation_id)
    select now() - make_interval(secs => g * 21), 'SYSTEM', null, 'SYSTEM', 'custody.balance_observed', 'treasury_wallet', gen_random_uuid()::text,
           jsonb_build_object('quality', 'SINGLE_SOURCE', 'balance', '0'), gen_random_uuid()::text
      from generate_series(1, 165000) g`);
  await c.query(`
    insert into custody_balance_observation (network, address, token_contract, quality, balance_minor, solidified_block, trx_sun, providers, independent_sources, detail, observed_by, observed_at)
    select 'TRON', ($1::text[])[1 + (g % cardinality($1::text[]))], $2, 'SINGLE_SOURCE', 0, 79000000 + g, 0, 'trongrid', 1, 'unavailable: quicknode: history', 'SYSTEM:custody.observe_balance',
           now() - make_interval(secs => 120 + g * 25)
      from generate_series(1, 138000) g`, [wallets, FAKE_USDT_CONTRACT]);
  // Rows graphile-worker leaves when a keyed job is not available as the next one is added: key cleared, attempts spent.
  await c.query(`
    insert into graphile_worker._private_tasks (identifier) values ('tron_scan'), ('custody_observe'), ('escrow_deadlines'), ('trader_orders_sweep') on conflict do nothing`);
  await c.query(`
    insert into graphile_worker._private_jobs (task_id, payload, run_at, attempts, max_attempts, last_error, created_at, updated_at, key)
    select t.id, '{}'::json, now() - make_interval(mins => g), 1, 1, 'error: relation "obsolete_table" does not exist', now() - make_interval(mins => g), now() - make_interval(mins => g), null
      from generate_series(1, 4100) g
      join graphile_worker._private_tasks t on t.identifier = (array['tron_scan', 'custody_observe', 'escrow_deadlines', 'trader_orders_sweep'])[1 + g % 4]`);
  await c.query('analyze');
}
