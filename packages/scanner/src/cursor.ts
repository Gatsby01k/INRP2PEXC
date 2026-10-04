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

export interface CursorAdvance {
  /** Highest block every watched address was proved read through. */
  readonly scannedThrough: bigint;
  readonly solidified: bigint;
  readonly window: { readonly from: bigint; readonly to: bigint };
  readonly complete: boolean;
  readonly incompleteReason: string | null;
  readonly servedBy: string | null;
}

/**
 * Moves the cursor forward — never backwards (the database refuses that too, IX066) — and records what the run
 * proved. The row is locked first, so two scanner runs that finish together are applied one after the other and
 * the later one can only keep or raise what the earlier one wrote.
 */
export async function advanceCursorInTx(ctx: TxContext, scanner: string, to: CursorAdvance): Promise<{ lastScannedBlock: bigint }> {
  const locked = await sql<{ last_scanned_block: bigint; last_solidified_block: bigint }>`
    select last_scanned_block, last_solidified_block from chain_cursor where network = 'TRON' and scanner = ${scanner} for update`.execute(ctx.tx);
  const current = locked.rows[0];
  if (!current) throw new DomainError('NOT_FOUND', `chain cursor ${scanner} does not exist`);
  const scanned = to.scannedThrough > current.last_scanned_block ? to.scannedThrough : current.last_scanned_block;
  const solidified = to.solidified > current.last_solidified_block ? to.solidified : current.last_solidified_block;
  await ctx.tx
    .updateTable('chain_cursor')
    .set({
      last_scanned_block: scanned,
      last_solidified_block: solidified,
      last_run_at: sql<Date>`inrp2p_now()`,
      last_window_from: to.window.from,
      last_window_to: to.window.to,
      last_complete: to.complete,
      last_incomplete_reason: to.incompleteReason ? to.incompleteReason.slice(0, 500) : null,
      last_served_by: to.servedBy ? to.servedBy.slice(0, 200) : null,
    })
    .where('network', '=', 'TRON')
    .where('scanner', '=', scanner)
    .execute();
  return { lastScannedBlock: scanned };
}
