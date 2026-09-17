import { readFile } from 'node:fs/promises';
import { runMigrations } from 'graphile-worker';
import type pg from 'pg';

/** Installs/upgrades graphile-worker's schema, then applies INRP2P queue privileges. Run as the migrator. */
export async function installQueue(pool: pg.Pool): Promise<void> {
  await runMigrations({ pgPool: pool });
  const privileges = await readFile(new URL('../sql/queue_privileges.sql', import.meta.url), 'utf8');
  await pool.query(privileges);
}
