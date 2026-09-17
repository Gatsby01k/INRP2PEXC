import { sql } from 'kysely';
import { DomainError } from '@inrp2p/kernel';
import type { Db, Executor, Tx } from './kysely.ts';

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

/** Runs `fn` in one database transaction; any throw rolls back everything. */
export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>, opts: { isolation?: IsolationLevel } = {}): Promise<T> {
  return db.transaction().setIsolationLevel(opts.isolation ?? 'read committed').execute(fn);
}

/** Database time for every business decision (ARCHITECTURE §4 "Time"). */
export async function dbNow(ex: Executor): Promise<Date> {
  const r = await sql<{ now: Date }>`select statement_timestamp() as now`.execute(ex);
  return r.rows[0]!.now;
}

/**
 * Global lock order (ARCHITECTURE §4). Commands acquire row locks only through `lockInOrder`,
 * which rejects acquiring a lower-ranked resource after a higher-ranked one in the same transaction.
 */
export const LOCK_ORDER = [
  'trade_request',
  'quote',
  'acceptance_challenge',
  'trade',
  'route_obligation',
  'settlement_leg',
  'route_settlement',
  'movement',
  'inr_account_day',
  'treasury_wallet',
  'deposit_address',
] as const;
export type LockResource = (typeof LOCK_ORDER)[number];

const highestRank = new WeakMap<object, number>();

export function assertLockOrder(tx: Tx, resource: LockResource): void {
  const rank = LOCK_ORDER.indexOf(resource);
  const current = highestRank.get(tx) ?? -1;
  if (rank < current) {
    throw new DomainError('LOCK_ORDER_VIOLATION', `cannot lock ${resource} after ${LOCK_ORDER[current]}`);
  }
  highestRank.set(tx, rank);
}

/**
 * Locks rows `FOR UPDATE` in primary-key order after checking global lock order.
 * `table` must be the physical table backing `resource`.
 */
export async function lockInOrder(tx: Tx, resource: LockResource, table: string, ids: readonly string[]): Promise<void> {
  assertLockOrder(tx, resource);
  if (ids.length === 0) return;
  const sorted = [...new Set(ids)].sort();
  await sql`select 1 from ${sql.table(table)} where id = any(${sorted}::uuid[]) order by id for update`.execute(tx);
}
