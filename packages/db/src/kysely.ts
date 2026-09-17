import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import type pg from 'pg';
import type { Database } from './schema.ts';

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;
export type Executor = Db | Tx;

export function createDb(pool: pg.Pool): Db {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
