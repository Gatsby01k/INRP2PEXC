/**
 * The point-in-time recovery drill (production task E4, TD-16) — on the reference stack, with Docker.
 *
 * A logical dump is not point-in-time recovery. This drill runs PostgreSQL 18.6 the way a production database must run —
 * WAL archived continuously — takes a base backup, keeps writing, picks a moment, writes past it, and then recovers a
 * **separate** server from the base backup and the archive to exactly that moment. The recovered copy must hold
 * everything written before the moment and nothing after, and must answer the questions every restore answers here:
 * the schema version, the grants, sign-in data, the money journal and the audit chain, the job queue and the chain
 * cursor; the application's own logins must pass the checks a production process runs before it serves; and a restore
 * must not cause a second payout — outgoing payments are held on the recovered copy from the moment it exists, and the
 * worker's first heartbeat raises the restore fence (migration 0034).
 *
 * It measures what a drill can measure on one machine — the base backup, the recovery, the checks — and records the
 * result in the source database (`backup_verification`), which is what `restore_drill_age_days` reads. A managed
 * database recovers through its own console; `RUNBOOKS backup-restore-drill` says how to run the same checks against it.
 *
 * Usage: node scripts/pitr-drill.ts [--keep] [--image inrp2p-web:<tag>]
 *   --image: also start that web image against the recovered database and ask it whether it is ready.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { createDb, createPool, databaseDeploymentProblems, type Db } from '@inrp2p/db';
import { migrate } from '@inrp2p/db/migrate';
import { installQueue } from '@inrp2p/outbox';
import { executeCommand } from '@inrp2p/commands';
import { appendAudit, sealAudit } from '@inrp2p/audit';
import { Accounts, postJournal } from '@inrp2p/ledger';
import { Money } from '@inrp2p/kernel';
import { payoutsHeld, recordWorkerBeat } from '@inrp2p/trades';
import { restoreProblems } from './restore-checks.ts';

const IMAGE = 'postgres:18.6';
const keep = process.argv.includes('--keep');
const webImageFlag = process.argv.indexOf('--image');
const webImage = webImageFlag >= 0 ? process.argv[webImageFlag + 1] : undefined;
const run = `pitr-${Date.now().toString(36)}`;
const NET = `${run}-net`;
const SOURCE = `${run}-source`;
const RESTORED = `${run}-restored`;
const secret = () => randomBytes(18).toString('base64url');
const pw = { postgres: secret(), migrator: secret(), app: secret(), worker: secret(), readonly: secret() };
const ROLES = fileURLToPath(new URL('../deploy/reference/postgres/01-roles.sh', import.meta.url));

function docker(args: string[], opts: { allowFail?: boolean } = {}): string {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`docker ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  return (r.stdout ?? '').trim();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = (container: string) => docker(['port', container, '5432/tcp']).split('\n')[0]!.split(':').pop()!;
const url = (container: string, user: string, password: string, db = 'inrp2p') => `postgres://${user}:${encodeURIComponent(password)}@127.0.0.1:${port(container)}/${db}`;

/** Ready on TCP: the image's initialisation runs a server on the socket only, so this waits for the real one. */
async function ready(container: string, timeoutMs = 120_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1'], { encoding: 'utf8' }).status === 0) return;
    await sleep(500);
  }
  throw new Error(`${container} did not become ready`);
}

async function withDb<T>(connection: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const pool = createPool({ connectionString: connection, applicationName: 'inrp2p-pitr-drill', max: 2 });
  try {
    return await fn(createDb(pool));
  } finally {
    await pool.end();
  }
}

const SYSTEM = { type: 'SYSTEM' as const, id: null, surface: 'SYSTEM' as const };
const holder = randomUUID();
/** One marked movement: an audited, balanced journal whose posting key names the phase it belongs to. */
async function write(db: Db, phase: string): Promise<void> {
  const amount = Money.parse('100.00', 'INR');
  await executeCommand(db, {
    authorize: async () => {},
    handle: async (ctx) => {
      await postJournal(ctx, {
        postingKey: `drill:${phase}`, eventType: 'drill.movement',
        entries: [
          { account: Accounts.suspenseUnallocated('INR'), direction: 'DR', amount },
          { account: Accounts.clientPayable(holder, 'INR'), direction: 'CR', amount },
        ],
      });
      await appendAudit(ctx, { action: 'drill.write', entityType: 'drill', entityId: phase, after: { phase } });
    },
  }, { name: 'drill.write', actor: SYSTEM, payload: { phase }, idempotencyKey: randomUUID(), financial: true });
}

const beat = (db: Db) => recordWorkerBeat(db, { workerId: 'pitr-drill-worker', startedAt: new Date(), release: 'drill', config: { drill: 'yes' } });
const identityOf = async (db: Db) => (await sql<{ i: { cluster: string; timeline: number } | null }>`select inrp2p_database_identity() as i`.execute(db)).rows[0]!.i;

const report: Record<string, unknown> = { run, image: IMAGE };
const findings: string[] = [];
const timings: Record<string, number> = {};
const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    timings[name] = Math.round((Date.now() - start) / 100) / 10;
  }
};

let target = '';
let migratorUrl = '';
try {
  docker(['network', 'create', NET]);
  for (const v of ['archive', 'backup', 'restored-data']) docker(['volume', 'create', `${run}-${v}`]);
  const env = ['-e', `POSTGRES_PASSWORD=${pw.postgres}`, '-e', `INRP2P_MIGRATOR_PASSWORD=${pw.migrator}`, '-e', `INRP2P_APP_PASSWORD=${pw.app}`, '-e', `INRP2P_WORKER_PASSWORD=${pw.worker}`, '-e', `INRP2P_READONLY_PASSWORD=${pw.readonly}`];
  // The source: WAL archived continuously (a segment at least every 10 s so the drill does not wait a minute).
  docker(['run', '-d', '--name', SOURCE, '--network', NET, '-p', '127.0.0.1::5432', ...env,
    '-v', `${run}-archive:/archive`, '-v', `${run}-backup:/backup`, '-v', `${ROLES}:/docker-entrypoint-initdb.d/01-roles.sh:ro`,
    IMAGE, 'postgres', '-c', 'wal_level=replica', '-c', 'archive_mode=on', '-c', 'archive_command=test ! -f /archive/%f && cp %p /archive/%f', '-c', 'archive_timeout=10']);
  docker(['exec', '-u', 'root', SOURCE, 'sh', '-c', 'chown postgres:postgres /archive /backup']);
  await ready(SOURCE);

  migratorUrl = url(SOURCE, 'inrp2p_migrator', pw.migrator);
  await timed('migrate', async () => {
    const pool = createPool({ connectionString: migratorUrl, applicationName: 'inrp2p-pitr-drill' });
    try {
      await migrate(pool);
      await installQueue(pool);
    } finally {
      await pool.end();
    }
  });
  const workerUrl = url(SOURCE, 'inrp2p_worker_login', pw.worker);

  // Before the base backup: a movement, a sign-in record, a queued job, the chain cursor, a sealed audit range, and the
  // worker's heartbeat — which records the cluster and timeline the source is on.
  await withDb(workerUrl, async (db) => {
    await write(db, 'before-backup');
    await sql`insert into auth_user (name, email, email_verified, kind) values ('Drill Operator', ${`drill-${run}@inrp2p.test`}, true, 'OPERATOR')`.execute(db);
    await sql`select graphile_worker.add_job('drill_job', '{}'::json, job_key => 'drill-job')`.execute(db);
    await sql`insert into chain_cursor (network, scanner, last_scanned_block, last_solidified_block, last_run_at) values ('TRON', 'tron_deposits', 1000, 1019, now())`.execute(db);
    await sealAudit(db, { settleSeconds: 0 });
    await beat(db);
    report.sourceIdentity = await identityOf(db);
  });

  await timed('base_backup', async () => {
    docker(['exec', '-u', 'postgres', SOURCE, 'pg_basebackup', '-h', '/var/run/postgresql', '-U', 'postgres', '-D', '/backup/base', '-X', 'stream', '-c', 'fast']);
  });

  // After the backup: one movement before the target (kept), one after it (lost).
  await withDb(workerUrl, async (db) => {
    await write(db, 'kept');
    await sealAudit(db, { settleSeconds: 0 });
    await beat(db);
    await sleep(1500);
    // A numeric offset: recovery_target_time refuses a time zone abbreviation, `Z` included.
    target = (await sql<{ t: string }>`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US"+00"') as t`.execute(db)).rows[0]!.t;
    await sleep(1500);
    await write(db, 'lost');
  });
  // Close the segment that holds the target and wait until it is in the archive.
  await withDb(url(SOURCE, 'postgres', pw.postgres, 'postgres'), async (db) => {
    const seg = (await sql<{ f: string }>`select pg_walfile_name(pg_switch_wal()) as f`.execute(db)).rows[0]!.f;
    const until = Date.now() + 60_000;
    while (docker(['exec', SOURCE, 'sh', '-c', `test -f /archive/${seg} && echo yes || echo no`]) !== 'yes') {
      if (Date.now() > until) throw new Error(`WAL segment ${seg} was not archived within 60 s`);
      await sleep(500);
    }
  });
  report.recoveryTarget = target;

  // The recovered server: the base backup, the archive read-only, and the target — another container and volume.
  docker(['run', '--rm', '-v', `${run}-backup:/backup`, '-v', `${run}-restored-data:/restored`, IMAGE, 'sh', '-c',
    `cp -a /backup/base/. /restored/ && printf "%s\\n" "restore_command = 'cp /archive/%f %p'" "recovery_target_time = '${target}'" "recovery_target_action = 'promote'" >> /restored/postgresql.auto.conf && touch /restored/recovery.signal && chown -R postgres:postgres /restored && chmod 700 /restored`]);
  await timed('recovery', async () => {
    docker(['run', '-d', '--name', RESTORED, '--network', NET, '-p', '127.0.0.1::5432', '-e', 'PGDATA=/restored',
      '-v', `${run}-restored-data:/restored`, '-v', `${run}-archive:/archive:ro`, IMAGE, 'postgres']);
    await ready(RESTORED);
    const until = Date.now() + 120_000;
    while (spawnSync('docker', ['exec', '-u', 'postgres', RESTORED, 'psql', '-tAc', 'select pg_is_in_recovery()'], { encoding: 'utf8' }).stdout.trim() !== 'f') {
      if (Date.now() > until) throw new Error('the recovered server did not finish recovery within 120 s');
      await sleep(500);
    }
  });

  // What the recovered copy must answer.
  await timed('checks', async () => {
    await withDb(url(RESTORED, 'inrp2p_migrator', pw.migrator), async (db) => {
      const keys = (await sql<{ k: string }>`select posting_key as k from ledger_journal where posting_key like 'drill:%' order by k`.execute(db)).rows.map((r) => r.k);
      report.journals = keys;
      if (!keys.includes('drill:before-backup') || !keys.includes('drill:kept')) findings.push('a movement written before the target is missing');
      if (keys.includes('drill:lost')) findings.push('a movement written after the target was recovered: this is not point-in-time');
      findings.push(...(await restoreProblems(db)));
      const facts = (await sql<{ version: number; users: string; jobs: string; cursors: string; seals: string }>`
        select inrp2p_schema_version() as version, (select count(*) from auth_user where email like 'drill-%')::text as users,
               (select count(*) from graphile_worker.jobs where key = 'drill-job')::text as jobs,
               (select count(*) from chain_cursor where scanner = 'tron_deposits')::text as cursors, (select count(*) from audit_seal)::text as seals`.execute(db)).rows[0]!;
      report.facts = facts;
      if (facts.users !== '1') findings.push('sign-in data (auth_user) is missing');
      if (facts.jobs !== '1') findings.push('the queued job is missing');
      if (facts.cursors !== '1') findings.push('the chain cursor is missing');
      if (facts.seals !== '2') findings.push(`expected the two audit seals written before the target, found ${facts.seals}`);
    });
    // Grants survive, and the application's logins pass the checks a production process runs before it serves.
    await withDb(url(RESTORED, 'inrp2p_app_login', pw.app), async (db) => {
      const ddl = await sql`create table drill_evil (id int)`.execute(db).then(() => 'allowed', () => 'refused');
      if (ddl !== 'refused') findings.push('the application login can create tables on the recovered copy');
      const writeLedger = await sql`delete from ledger_entry`.execute(db).then(() => 'allowed', () => 'refused');
      if (writeLedger !== 'refused') findings.push('the application login can delete ledger entries on the recovered copy');
      const problems = await databaseDeploymentProblems(db);
      report.appLogin = problems.length === 0 ? 'ready' : problems;
      findings.push(...problems.map((p) => `application login: ${p}`));
      // A restore must not cause a second payout: held from the moment the recovered copy exists, before any worker.
      const held = await payoutsHeld(db);
      report.heldBeforeWorker = held;
      if (!held.held) findings.push('outgoing payments are not held on the recovered copy');
    });
    await withDb(url(RESTORED, 'inrp2p_worker_login', pw.worker), async (db) => {
      const problems = await databaseDeploymentProblems(db);
      report.workerLogin = problems.length === 0 ? 'ready' : problems;
      findings.push(...problems.map((p) => `worker login: ${p}`));
      report.recoveredIdentity = await identityOf(db);
      const first = await beat(db);
      report.fenceRaised = first.raised;
      if (!first.raised) findings.push('the worker’s first heartbeat on the recovered copy raised no restore fence');
      const paused = (await sql<{ p: boolean }>`select inrp2p_new_business_paused() as p`.execute(db)).rows[0]!.p;
      if (!paused) findings.push('new business is not paused on the recovered copy');
      if ((await beat(db)).raised) findings.push('a second heartbeat raised a second fence');
    });
    await withDb(workerUrl, async (db) => {
      if ((await payoutsHeld(db)).held) findings.push('outgoing payments are held on the source, which never changed');
    });
  });

  // The application reconnects: the web image, pointed at the recovered database, says it is ready.
  if (webImage) {
    await timed('app_reconnect', async () => {
      const web = `${run}-web`;
      docker(['run', '-d', '--name', web, '--network', NET, '-p', '127.0.0.1::3000',
        '-e', `DATABASE_URL=postgres://inrp2p_app_login:${encodeURIComponent(pw.app)}@${RESTORED}:5432/inrp2p`, '-e', 'DESK_HOST=desk.drill.test', '-e', 'APP_HOST=app.drill.test', '-e', 'PUBLIC_HOST=drill.test',
        '-e', `OPERATOR_AUTH_SECRET=${secret()}${secret()}`, '-e', `CLIENT_AUTH_SECRET=${secret()}${secret()}`, webImage]);
      const webPort = docker(['port', web, '3000/tcp']).split('\n')[0]!.split(':').pop();
      const until = Date.now() + 90_000;
      let answer = 0;
      while (Date.now() < until) {
        answer = await fetch(`http://127.0.0.1:${webPort}/api/health/ready`, { headers: { host: 'desk.drill.test' } }).then((r) => r.status, () => 0);
        if (answer === 200) break;
        await sleep(1000);
      }
      report.appReady = answer;
      if (answer !== 200) findings.push(`the web image did not become ready against the recovered database (${answer})`);
      if (!keep) docker(['rm', '-f', web], { allowFail: true });
    });
  }
} catch (e) {
  findings.push(`the drill did not complete: ${(e as Error).message}`);
} finally {
  report.timings = timings;
  report.findings = findings;
  report.ok = findings.length === 0;
  // Remembered where monitoring reads it: the source database (a real drill records it on production's own).
  if (migratorUrl) {
    await withDb(migratorUrl, async (db) => {
      await db.insertInto('backup_verification').values({
        kind: 'POINT_IN_TIME', ok: findings.length === 0, recovered_to: target ? new Date(`${target.replace(' ', 'T')}:00`) : null, restore_seconds: Math.round(timings.recovery ?? 0),
        environment: 'local reference (Docker, postgres:18.6, WAL archive)', findings: JSON.stringify(findings), recorded_by: 'scripts/pitr-drill.ts',
      }).execute();
    }).catch((e: unknown) => findings.push(`the result could not be recorded: ${(e as Error).message}`));
  }
  console.log(JSON.stringify(report, null, 2));
  if (findings.length > 0) process.exitCode = 1;
  if (!keep) {
    for (const c of [RESTORED, SOURCE]) docker(['rm', '-f', c], { allowFail: true });
    for (const v of ['archive', 'backup', 'restored-data']) docker(['volume', 'rm', `${run}-${v}`], { allowFail: true });
    docker(['network', 'rm', NET], { allowFail: true });
  } else {
    console.log(`kept: containers ${SOURCE} and ${RESTORED}, volumes ${run}-*`);
  }
}
