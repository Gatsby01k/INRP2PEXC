/**
 * Whether migration 46 (ADR 0027) would accept this database, answered without changing it.
 *
 * It runs the migration's own preflight block in a read-only transaction: the same checks, not a copy of them. Nothing is
 * locked beyond what reading takes, and nothing can be written. Run it before stopping anything for the release:
 *
 *   DATABASE_MIGRATOR_URL=… node scripts/p2p-only-preflight.ts
 *
 * Exit 0: the migration will accept this database. Exit 1: it would refuse; the reasons are printed, with the rows behind
 * the ones a person has to look at. Exit 2: this tool could not answer, for instance because the database is not at schema 45.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { createPool } from '@inrp2p/db';
import { MIGRATIONS_DIR } from '@inrp2p/db/migrate';

const BEFORE = 45;

export interface PreflightResult {
  readonly accepted: boolean;
  /** Each thing the migration would refuse over, in its own words. */
  readonly reasons: readonly string[];
}

/** The migration's preflight block, exactly as it is in the file. */
export async function preflightBlock(): Promise<string> {
  const migration = await readFile(path.join(MIGRATIONS_DIR, '0046_p2p_only.sql'), 'utf8');
  const start = migration.indexOf('-- preflight:begin');
  const end = migration.indexOf('-- preflight:end');
  if (start < 0 || end < start) throw new Error('migration 46 has no preflight block');
  return migration.slice(start, end);
}

export async function preflight(pool: pg.Pool): Promise<PreflightResult> {
  const block = await preflightBlock();
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ version: number | null }>('select max(version)::int as version from schema_migration');
    if (rows[0]!.version !== BEFORE) throw new Error(`the database is at schema ${rows[0]!.version ?? 'none'}, not ${BEFORE}`);
    await client.query('begin transaction read only');
    try {
      await client.query(block);
      return { accepted: true, reasons: [] };
    } catch (e) {
      const message = (e as Error).message;
      const refused = 'migration 46 refuses, nothing was changed: ';
      if (!message.startsWith(refused)) throw e;
      return { accepted: false, reasons: message.slice(refused.length).split('; ') };
    } finally {
      await client.query('rollback');
    }
  } finally {
    client.release();
  }
}

/** What a person needs to decide about what was found: no sealed value, no name of a person, read only. */
export async function preflightDetails(pool: pg.Pool): Promise<Record<string, readonly unknown[]>> {
  const client = await pool.connect();
  try {
    await client.query('begin transaction read only');
    const rows = async (text: string) => (await client.query(text)).rows;
    try {
      return {
        'treasury reservations': await rows(`
          select r.status, r.amount_minor::text as amount_minor, r.consumed_minor::text as consumed_minor, r.created_at, t.ref as trade, t.direction, t.lifecycle_state as trade_state
            from treasury_reservation r left join trade t on t.id = r.trade_id order by r.created_at`),
        'live quotes on a route that is not P2P': await rows(`
          select q.ref, q.status, q.created_at, q.expires_at, r.name as route, r.execution_mode, r.status as route_status, r.trader_id is not null as trader_route
            from quote q join liquidity_route r on r.id = q.route_id
           where r.execution_mode <> 'P2P' and q.status in ('DRAFT', 'SENT') order by q.created_at`),
        'routes': await rows(`select execution_mode, status, trader_id is not null as trader_route, count(*)::int as n from liquidity_route group by 1, 2, 3 order by 1, 2, 3`),
        'trades': await rows(`select e.route_execution_mode, t.lifecycle_state, count(*)::int as n from trade t join trade_economics e on e.trade_id = t.id group by 1, 2 order by 1, 2`),
      };
    } finally {
      await client.query('rollback');
    }
  } finally {
    client.release();
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_MIGRATOR_URL;
  if (!url) {
    console.error('DATABASE_MIGRATOR_URL is required');
    process.exit(2);
  }
  const pool = createPool({ connectionString: url, applicationName: 'inrp2p-p2p-only-preflight' });
  try {
    const result = await preflight(pool);
    if (result.accepted) {
      console.log('migration 46 will accept this database: nothing it removes ever carried money');
    } else {
      console.error('migration 46 would refuse this database:');
      for (const reason of result.reasons) console.error(`  - ${reason}`);
      for (const [title, rows] of Object.entries(await preflightDetails(pool))) {
        console.error(`\n${title}:`);
        console.table(rows);
      }
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(`could not answer: ${(e as Error).message}`);
    process.exitCode = 2;
  } finally {
    await pool.end();
  }
}
