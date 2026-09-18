import { sql } from 'kysely';
import type { Db } from '@inrp2p/db';
import { lockTrade } from '@inrp2p/trades';
import { markCryptoOrphaned, revertClientLegInTx } from '@inrp2p/settlement';
import { type ScannerDeps, scannerPolicyOf } from './policy.ts';
import { systemStep } from './system.ts';

export interface OrphanReport {
  readonly examined: number;
  readonly orphaned: number;
  readonly legsReverted: number;
}

interface Aged {
  readonly id: string;
  readonly tx_hash: string;
  readonly log_index: number;
}

/**
 * `tron_orphan_sweep` (T3). A transfer we detected but that the providers no longer know was in a block that did
 * not survive: the leg fails, its evidence link is voided and the trade goes back to awaiting the client. Only
 * DETECTED transfers are swept — a CONFIRMED one sat in a solidified block, which by TRON's finality rule cannot
 * be reorganized, so its disappearance would be a reconciliation case for a human, not an automatic reversal.
 */
export async function runOrphanSweep(db: Db, deps: ScannerDeps): Promise<OrphanReport> {
  const policy = scannerPolicyOf(deps);
  const aged = await sql<Aged>`
    select id, tx_hash, log_index from crypto_transfer
    where network = 'TRON' and state = 'DETECTED'
      and detected_at <= inrp2p_now() - make_interval(mins => ${policy.orphanAfterMinutes})
    order by detected_at
    limit ${policy.confirmBatch}`.execute(db);

  const report = { examined: 0, orphaned: 0, legsReverted: 0 };
  for (const row of aged.rows) {
    report.examined += 1;
    const onChain = await deps.chain.lookupTransfer('TRON', row.tx_hash, row.log_index);
    if (onChain) continue;
    const step = await systemStep(
      db,
      'chain.transfer_orphaned',
      { transferId: row.id },
      async (ctx) => {
        const allocation = await ctx.tx
          .selectFrom('transfer_allocation')
          .select('settlement_leg_id')
          .where('crypto_transfer_id', '=', row.id)
          .where('dimension', '=', 'CLIENT')
          .where('voided_at', 'is', null)
          .executeTakeFirst();
        const leg = allocation?.settlement_leg_id
          ? await ctx.tx.selectFrom('settlement_leg').select(['id', 'trade_id', 'side', 'status']).where('id', '=', allocation.settlement_leg_id).executeTakeFirst()
          : undefined;
        if (leg) await lockTrade(ctx.tx, leg.trade_id);
        const marked = await markCryptoOrphaned(ctx, row.id, 'the providers no longer report this transfer');
        let reverted = false;
        if (marked.orphaned && leg && leg.side === 'CLIENT_TO_EXCHANGE' && leg.status === 'PROCESSING') {
          await revertClientLegInTx(ctx, leg.id, 'the transfer was orphaned by a chain reorganization');
          reverted = true;
        }
        return { orphaned: marked.orphaned, reverted };
      },
      { financial: true },
    );
    if (step.result.orphaned) report.orphaned += 1;
    if (step.result.reverted) report.legsReverted += 1;
  }
  return report;
}
