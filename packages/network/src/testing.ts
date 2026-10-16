import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '@inrp2p/db';
import { executeCommand } from '@inrp2p/commands';
import { recordFeeSnapshot } from './policy.ts';

/**
 * Fixtures for worlds that are not about the network: what the chain charges, a TRX price, and TRX in a budget — so a
 * quote can be priced and a trade accepted, as in production where the worker reads the chain and the desk publishes the
 * price. The default price makes the network fee a paisa, so a world's own margins stay what its tests say they are; the
 * network's own tests set real numbers.
 */
export async function seedNetworkCosts(db: Db, opts: { usdtPerTrxMicro?: bigint; energyPriceSun?: bigint } = {}): Promise<void> {
  await executeCommand(db, {
    authorize: async () => {},
    handle: (ctx) => recordFeeSnapshot(ctx, {
      energyPriceSun: opts.energyPriceSun ?? 100n, bandwidthPriceSun: 1000n, createAccountFeeSun: 100_000n, createNewAccountFeeSun: 1_000_000n, freeNetLimit: 600,
    }, ['test-fixture']),
  }, { name: 'network.fees_observed', actor: { type: 'SYSTEM', id: null, surface: 'SYSTEM' }, payload: {}, idempotencyKey: randomBytes(8).toString('hex'), financial: false });
  await db.insertInto('network_trx_rate').values({ usdt_per_trx_micro: opts.usdtPerTrxMicro ?? 1n, source: 'test fixture', published_by: 'test' }).execute();
}

/** TRX credited to a funder's budget as if it had been deposited (a trader's from its registered wallet). */
export async function fundBudget(db: Db, input: { traderId: string | null; amountSun: bigint; from: string }): Promise<string> {
  const txHash = createHash('sha256').update(`fixture-deposit:${randomBytes(16).toString('hex')}`).digest('hex');
  await db.insertInto('network_budget_entry').values({
    trader_id: input.traderId, kind: 'DEPOSIT', amount_sun: input.amountSun, tx_hash: txHash, from_address: input.from,
    posting_key: `trx_deposit:${txHash}`, note: 'test fixture', created_by: 'test',
  }).execute();
  return txHash;
}
