import { sql } from 'kysely';
import { DomainError } from '@inrp2p/kernel';
import type { Executor, TxContext } from '@inrp2p/db';

export interface CursorState {
  readonly lastScannedBlock: bigint;
  readonly lastSolidifiedBlock: bigint;
}

/** The scanner's progress, or `null` when this scanner has never run. */
export async function readCursor(ex: Executor, scanner: string): Promise<CursorState | null> {
  const row = await ex
    .selectFrom('chain_cursor')
    .select(['last_scanned_block', 'last_solidified_block'])
    .where('network', '=', 'TRON')
    .where('scanner', '=', scanner)
    .executeTakeFirst();
  return row ? { lastScannedBlock: row.last_scanned_block, lastSolidifiedBlock: row.last_solidified_block } : null;
}

/**
 * Returns the cursor, creating it at `startBlock` on the first run. Two workers starting at once is fine: the
 * loser of the insert reads the winner's row.
 */
export async function ensureCursorInTx(ctx: TxContext, scanner: string, startBlock: bigint): Promise<CursorState> {
  const existing = await readCursor(ctx.tx, scanner);
  if (existing) return existing;
  await ctx.tx
    .insertInto('chain_cursor')
    .values({ network: 'TRON', scanner, last_scanned_block: startBlock < 0n ? 0n : startBlock })
    .onConflict((oc) => oc.columns(['network', 'scanner']).doNothing())
    .execute();
  const created = await readCursor(ctx.tx, scanner);
  if (!created) throw new DomainError('NOT_FOUND', `chain cursor ${scanner} could not be created`);
  return created;
}

/**
 * Moves the cursor forward. The database refuses a backwards move (IX066): a provider that suddenly reports a
 * lower head is lagging, and rewinding on its word would re-emit work and hide the regression.
 */
export async function advanceCursorInTx(ctx: TxContext, scanner: string, to: { scannedThrough: bigint; solidified: bigint }): Promise<void> {
  const current = await readCursor(ctx.tx, scanner);
  if (!current) throw new DomainError('NOT_FOUND', `chain cursor ${scanner} does not exist`);
  const scanned = to.scannedThrough > current.lastScannedBlock ? to.scannedThrough : current.lastScannedBlock;
  const solidified = to.solidified > current.lastSolidifiedBlock ? to.solidified : current.lastSolidifiedBlock;
  await ctx.tx
    .updateTable('chain_cursor')
    .set({ last_scanned_block: scanned, last_solidified_block: solidified, last_run_at: sql<Date>`inrp2p_now()` })
    .where('network', '=', 'TRON')
    .where('scanner', '=', scanner)
    .execute();
}
