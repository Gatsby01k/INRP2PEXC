import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import type pg from 'pg';
import type { Database } from './schema.ts';

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;
export type Executor = Db | Tx;

export interface DbOptions {
  /**
   * Awaited before this handle takes its first connection from the pool, and never again: what must hold before the
   * process may use the database at all (the web app's start-up check, production task E3). A rejection, or a process
   * that exits inside it, means no statement is ever sent through this handle.
   */
  readonly ready?: () => Promise<void>;
}

export function createDb(pool: pg.Pool, opts: DbOptions = {}): Db {
  const { ready } = opts;
  // Kysely asks for a pool given as a function once, when the first connection is acquired.
  const source = ready ? async () => (await ready(), pool) : pool;
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool: source }) });
}
