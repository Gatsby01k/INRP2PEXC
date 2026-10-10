import { sql } from 'kysely';
import { DomainError, normalizeTronAddress, requireText, requireUuid } from '@inrp2p/kernel';
import type { Db } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { type OperatorActor, actorLabel, operatorCommand } from '@inrp2p/identity';
import { type ScannerDeps, scannerPolicyOf } from './policy.ts';
import { ProviderTracker } from './providers.ts';
import { detect, readAddress } from './scan.ts';
import { systemStep } from './system.ts';
import { isExchangeAddress } from './balances.ts';

/** Longest range one backfill may cover (about 70 days of TRON blocks); the database checks the same bound. */
export const MAX_BACKFILL_BLOCKS = 2_000_000n;

export interface RequestBackfillPayload {
  /** Decimal block numbers, inclusive. */
  readonly fromBlock: string;
  readonly toBlock: string;
  readonly addresses: readonly string[];
  readonly reason: string;
}

const block = (value: unknown, field: string): bigint => {
  if (typeof value !== 'string' || !/^[0-9]{1,15}$/.test(value.trim())) throw new DomainError('INVALID_ARGUMENT', `${field} must be a block number`);
  return BigInt(value.trim());
};

/**
 * `chain.backfill_request` — `chain:backfill` (⧗). TD-06: reads a historical block range for a named set of this
 * exchange's own addresses — a deposit address watched only after funds reached it, an import of an old range —
 * through exactly the scanner's detection path (attribution by address, one idempotent step per chain event, no
 * second journal for anything already recorded). It has its own progress and never moves the main cursor.
 *
 * Refused: a range beyond the solidified head the scanner last recorded (a backfill reads history, not the live
 * edge), a range above `MAX_BACKFILL_BLOCKS`, an address that is not a deposit address or treasury wallet of this
 * exchange, a second backfill while one runs.
 */
export function requestChainBackfill(actor: OperatorActor) {
  return operatorCommand(actor, 'chain:backfill', async (ctx, p: RequestBackfillPayload) => {
    const from = block(p.fromBlock, 'fromBlock');
    const to = block(p.toBlock, 'toBlock');
    if (to < from) throw new DomainError('INVALID_ARGUMENT', 'the range ends before it starts');
    if (to - from > MAX_BACKFILL_BLOCKS) throw new DomainError('INVALID_ARGUMENT', `a backfill covers at most ${MAX_BACKFILL_BLOCKS} blocks; split the range`);
    const reason = requireText(p.reason, 'reason', 500);
    if (reason.length < 10) throw new DomainError('INVALID_ARGUMENT', 'say why this range is read again (at least 10 characters)');
    if (!Array.isArray(p.addresses) || p.addresses.length === 0 || p.addresses.length > 200) throw new DomainError('INVALID_ARGUMENT', 'name 1 to 200 addresses');
    const addresses = [...new Set(p.addresses.map((a) => normalizeTronAddress(a)))];
    for (const address of addresses) {
      if (!(await isExchangeAddress(ctx.tx, address))) throw new DomainError('INVALID_ARGUMENT', `${address} is not an address of this exchange`);
    }
    const cursor = await ctx.tx.selectFrom('chain_cursor').select(['last_solidified_block']).where('network', '=', 'TRON').orderBy('last_solidified_block', 'desc').executeTakeFirst();
    const solidified = cursor?.last_solidified_block ?? 0n;
    if (to > solidified) {
      throw new DomainError('INVALID_ARGUMENT', `the range must end at or below the solidified head the scanner last recorded (${solidified}); the live edge is the scanner's`);
    }
    const running = await ctx.tx.selectFrom('chain_backfill').select('ref').where('network', '=', 'TRON').where('status', '=', 'RUNNING').executeTakeFirst();
    if (running) throw new DomainError('INVALID_TRANSITION', `backfill ${running.ref} is still running; cancel it or let it finish`);
    const row = await ctx.tx
      .insertInto('chain_backfill')
      .values({ network: 'TRON', from_block: from, to_block: to, addresses, reason, next_block: from, requested_by: actorLabel(ctx) })
      .returning(['id', 'ref'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, {
      action: 'chain.backfill_requested', entityType: 'chain_backfill', entityId: row.id,
      after: { ref: row.ref, from_block: from.toString(), to_block: to.toString(), addresses, reason },
    });
    return { backfillId: row.id, ref: row.ref };
  });
}

/** `chain.backfill_cancel` — `chain:backfill` (⧗). What it already detected stays detected. */
export function cancelChainBackfill(actor: OperatorActor) {
  return operatorCommand(actor, 'chain:backfill', async (ctx, p: { backfillId: string; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    const row = await ctx.tx.selectFrom('chain_backfill').selectAll().where('id', '=', requireUuid(p.backfillId, 'backfillId')).forUpdate().executeTakeFirst();
    if (!row) throw new DomainError('NOT_FOUND', 'backfill not found');
    if (row.status !== 'RUNNING') throw new DomainError('INVALID_TRANSITION', `backfill is ${row.status}`);
    await ctx.tx
      .updateTable('chain_backfill')
      .set({ status: 'CANCELLED', closed_by: actorLabel(ctx), closed_at: sql<Date>`inrp2p_now()`, close_reason: reason })
      .where('id', '=', row.id)
      .execute();
    await appendAudit(ctx, { action: 'chain.backfill_cancelled', entityType: 'chain_backfill', entityId: row.id, before: { status: 'RUNNING', next_block: row.next_block.toString() }, after: { status: 'CANCELLED', reason } });
    return { status: 'CANCELLED' as const };
  });
}

export interface BackfillReport {
  readonly ref: string;
  readonly from: bigint;
  readonly to: bigint;
  /** First block not yet proved read for every address, after this run. */
  readonly nextBlock: bigint;
  readonly detected: number;
  readonly alreadyKnown: number;
  readonly status: 'RUNNING' | 'COMPLETED';
  readonly incompleteReasons: readonly string[];
}

/**
 * `tron_backfill` (worker cron): one bounded slice of the running backfill. The slice's progress moves only as far
 * as every listed address was proved read (the same completeness the scanner applies), so an interrupted provider
 * makes the next run repeat the slice, and the repeat records nothing twice.
 */
export async function runChainBackfill(db: Db, deps: ScannerDeps): Promise<BackfillReport | null> {
  const job = await db.selectFrom('chain_backfill').selectAll().where('network', '=', 'TRON').where('status', '=', 'RUNNING').orderBy('requested_at').executeTakeFirst();
  if (!job) return null;
  if (deps.providers.length === 0) throw new DomainError('CHAIN_MONITORING_UNCONFIGURED', 'no TRON provider is configured');
  const policy = scannerPolicyOf(deps);
  const from = job.next_block;
  const sliceEnd = from + policy.backfillBlocksPerRun - 1n;
  const to = sliceEnd < job.to_block ? sliceEnd : job.to_block;
  const tracker = new ProviderTracker(deps.providers);
  let detected = 0;
  let alreadyKnown = 0;
  const reasons: string[] = [];
  let proven = to;
  try {
    for (const address of job.addresses) {
      const read = await readAddress(deps, tracker, address, from, to);
      if (read.reason) reasons.push(`${address}: ${read.reason}`);
      for (const transfer of read.transfers) {
        if (transfer.tokenContract !== deps.chain.tokenContract || transfer.toAddress !== address) continue;
        const outcome = await detect(db, transfer);
        if (outcome.existing) alreadyKnown += 1;
        else detected += 1;
      }
      if (read.provenThrough < proven) proven = read.provenThrough;
    }
  } finally {
    await tracker.flush(db);
  }
  const nextBlock = proven + 1n > job.next_block ? proven + 1n : job.next_block;
  const completed = nextBlock > job.to_block;
  await systemStep(db, 'chain.backfill_progress', { backfillId: job.id, from: from.toString(), to: to.toString() }, async (ctx) => {
    const current = await ctx.tx.selectFrom('chain_backfill').select(['status', 'next_block', 'runs', 'detected', 'already_known']).where('id', '=', job.id).forUpdate().executeTakeFirstOrThrow();
    if (current.status !== 'RUNNING') return { applied: false };
    const next = nextBlock > current.next_block ? nextBlock : current.next_block;
    await ctx.tx
      .updateTable('chain_backfill')
      .set({
        next_block: next,
        runs: current.runs + 1,
        detected: current.detected + detected,
        already_known: current.already_known + alreadyKnown,
        last_run_at: sql<Date>`inrp2p_now()`,
        last_error: reasons.length ? reasons.join(' | ').slice(0, 500) : null,
        ...(completed ? { status: 'COMPLETED' as const, closed_by: `SYSTEM:${ctx.commandName}`, closed_at: sql<Date>`inrp2p_now()`, close_reason: 'range read' } : {}),
      })
      .where('id', '=', job.id)
      .execute();
    await appendAudit(ctx, {
      action: completed ? 'chain.backfill_completed' : 'chain.backfill_progressed', entityType: 'chain_backfill', entityId: job.id,
      before: { next_block: current.next_block.toString() },
      after: { next_block: next.toString(), detected, already_known: alreadyKnown, ...(reasons.length ? { incomplete: reasons } : {}) },
    });
    return { applied: true };
  });
  return { ref: job.ref, from, to, nextBlock, detected, alreadyKnown, status: completed ? 'COMPLETED' : 'RUNNING', incompleteReasons: reasons };
}
