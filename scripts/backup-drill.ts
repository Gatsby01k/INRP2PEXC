/**
 * The backup and restore drill (launch checklist: "Backups + PITR restore drill completed").
 *
 * A backup nobody has restored is a hope, not a backup. This script takes one, restores it into a throwaway
 * database and then asks the restored copy the only questions that matter:
 *
 *   1. Is the schema at the same migration as the source? A restore that silently lands a version behind is a
 *      restore that will be "fixed" under pressure by running migrations against production data nobody has
 *      looked at yet.
 *   2. Does the ledger still net to zero, per currency and globally (FI-40, FI-44)? A dump taken without a
 *      consistent snapshot can tear a transaction in half; the ledger is where that shows.
 *   3. Is the audit seal chain intact (SECURITY §8)? The chain is what makes the audit trail evidence rather
 *      than a log, and it is recomputed here from the restored rows.
 *   4. Does the restored copy carry the same number of trades, journals and audit events as the source?
 *
 * It restores **into a new database and never over an existing one**, so running it by accident cannot destroy
 * anything. It also never touches the source beyond reading it.
 *
 * Usage:
 *   DATABASE_MIGRATOR_URL=postgres://…/inrp2p node scripts/backup-drill.ts [--keep] [--dir /var/backups]
 *
 * `pg_dump` refuses to dump a server newer than itself, and the machine running a drill is rarely the machine
 * running the database. `PG_BIN` names the directory holding client tools of the server's own major version;
 * without it the tools on `PATH` are used and the version mismatch is reported as what it is.
 *
 * `--keep` leaves the restored database and the dump file in place for inspection; by default both are removed,
 * because a drill that fills the disk is a drill nobody runs twice.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, createPool } from '@inrp2p/db';
import { type RestoreCounts, countDifferences, restoreCounts, restoreProblems } from './restore-checks.ts';

const url = process.env.DATABASE_MIGRATOR_URL;
if (!url) {
  console.error('DATABASE_MIGRATOR_URL is required (a role that may read every table and create a database)');
  process.exit(1);
}
const keep = process.argv.includes('--keep');
const dirFlag = process.argv.indexOf('--dir');
const outDir = dirFlag >= 0 ? process.argv[dirFlag + 1] : undefined;

const source = new URL(url);
const sourceName = source.pathname.replace(/^\//, '');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
const restoredName = `${sourceName}_drill_${stamp}`;

const adminUrl = (): string => {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
};
const restoredUrl = (): string => {
  const u = new URL(url);
  u.pathname = `/${restoredName}`;
  return u.toString();
};

/** `PG_BIN` lets a drill use client tools matching the server rather than whatever the host happens to ship. */
const pgBin = process.env.PG_BIN;
const tool = (name: string): string => (pgBin ? path.join(pgBin, name) : name);

function run(command: string, args: string[], env: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ...env } });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
  });
}

/** One connection's worth of the checks in `restore-checks.ts`, which is where they are tested. */
async function withDb<R>(connection: string, fn: (db: ReturnType<typeof createDb>) => Promise<R>): Promise<R> {
  const db = createDb(createPool({ connectionString: connection, applicationName: 'inrp2p-backup-drill', int8: 'bigint' }));
  try {
    return await fn(db);
  } finally {
    await db.destroy();
  }
}

const dumpDir = outDir ?? (await mkdtemp(path.join(tmpdir(), 'inrp2p-drill-')));
const dumpFile = path.join(dumpDir, `${sourceName}-${stamp}.dump`);
let restored = false;

try {
  console.log(`source      ${sourceName}`);
  const before: RestoreCounts = await withDb(url, restoreCounts);

  // `--format=custom` so the restore can be parallelised and inspected; a single transaction snapshot so the
  // dump is consistent even while the desk is working.
  console.log(`dump        ${dumpFile}`);
  await run(tool('pg_dump'), ['--format=custom', '--no-owner', '--no-privileges', '--file', dumpFile, url]);
  const size = (await stat(dumpFile)).size;
  console.log(`dump size   ${(size / 1_000_000).toFixed(1)} MB`);

  console.log(`restore     ${restoredName}`);
  await run(tool('psql'), ['--quiet', '--no-psqlrc', '--command', `create database "${restoredName}"`, adminUrl()]);
  restored = true;
  await run(tool('pg_restore'), ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname', restoredUrl(), dumpFile]);

  const after = await withDb(restoredUrl(), restoreCounts);
  const failures = [...(await withDb(restoredUrl(), restoreProblems)), ...countDifferences(before, after)];

  for (const key of ['migration', 'trades', 'journals', 'entries', 'auditEvents', 'auditSeals'] as const) {
    console.log(`${before[key] === after[key] ? 'ok  ' : 'FAIL'}        ${key}: source ${before[key]} · restore ${after[key]}`);
  }
  for (const failure of failures) console.error(`FAIL        ${failure}`);

  if (failures.length > 0) {
    console.error(`\ndrill FAILED with ${failures.length} problem(s). The restored copy is ${keep ? `kept as ${restoredName}` : 'about to be dropped'}.`);
    process.exitCode = 1;
  } else {
    console.log('\ndrill passed: the restore is at the same migration, its ledger balances, its audit chain verifies and its counts match.');
  }
} finally {
  if (!keep) {
    if (restored) await run(tool('psql'), ['--quiet', '--no-psqlrc', '--command', `drop database if exists "${restoredName}"`, adminUrl()]).catch(() => {});
    if (!outDir) await rm(dumpDir, { recursive: true, force: true });
  } else {
    console.log(`\nkept: database ${restoredName}, dump ${dumpFile}`);
  }
}
