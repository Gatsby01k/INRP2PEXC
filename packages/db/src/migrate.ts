import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type pg from 'pg';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const out: MigrationFile[] = [];
  for (const f of files) {
    const m = FILE_RE.exec(f);
    if (!m) throw new Error(`invalid migration file name: ${f}`);
    const sql = await readFile(path.join(dir, f), 'utf8');
    out.push({ version: Number(m[1]), name: m[2]!, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  out.forEach((mig, i) => {
    if (mig.version !== i + 1) throw new Error(`migration versions must be contiguous from 1; found ${mig.version} at position ${i + 1}`);
  });
  return out;
}

/**
 * Applies explicit SQL migrations in order, each in its own transaction, under an advisory lock.
 * Applied migrations are immutable: a changed checksum aborts the run.
 */
export async function migrate(pool: pg.Pool, opts: { dir?: string; log?: (msg: string) => void } = {}): Promise<number[]> {
  const log = opts.log ?? (() => {});
  const migrations = await loadMigrations(opts.dir);
  const client = await pool.connect();
  const applied: number[] = [];
  try {
    await client.query(`select pg_advisory_lock(hashtext('inrp2p.migrations'))`);
    await client.query(`
      create table if not exists schema_migration (
        version    integer primary key,
        name       text not null,
        checksum   text not null,
        applied_at timestamptz not null default statement_timestamp()
      )`);
    const { rows } = await client.query<{ version: number; checksum: string }>('select version, checksum from schema_migration order by version');
    const done = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const mig of migrations) {
      const existing = done.get(mig.version);
      if (existing !== undefined) {
        if (existing !== mig.checksum) throw new Error(`migration ${mig.version}_${mig.name} was modified after being applied`);
        continue;
      }
      await client.query('begin');
      try {
        await client.query(mig.sql);
        await client.query('insert into schema_migration (version, name, checksum) values ($1, $2, $3)', [mig.version, mig.name, mig.checksum]);
        await client.query('commit');
      } catch (e) {
        await client.query('rollback');
        throw new Error(`migration ${mig.version}_${mig.name} failed: ${(e as Error).message}`, { cause: e });
      }
      applied.push(mig.version);
      log(`applied ${mig.version}_${mig.name}`);
    }
  } finally {
    await client.query(`select pg_advisory_unlock(hashtext('inrp2p.migrations'))`).catch(() => {});
    client.release();
  }
  return applied;
}
