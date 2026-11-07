'use server';

import { revalidatePath } from 'next/cache';
import { authorizeOperator } from '@inrp2p/identity';
import { type RefreshedBalance, readRequestedBalance, recordRequestedBalance } from '@inrp2p/scanner';
import type { BalanceObservationInput } from '@inrp2p/treasury';
import { chainForWeb } from '../chain.ts';
import { type CommandResult, failure, runCommand } from '../command.ts';
import { operatorContext } from '../operator.ts';

/**
 * Read what an exchange address holds now (`custody:refresh_balance`, B2). The permission is checked before any
 * provider is asked — a refresh spends provider quota — and again inside the command that records the reading. The
 * reading comes from the providers this server is configured with; the browser sends only the address, so no
 * number it sends can become a balance.
 */
export async function refreshCustodyBalanceAction(input: { address: string }, key: string): Promise<CommandResult<RefreshedBalance>> {
  let reading: BalanceObservationInput;
  try {
    const ctx = await operatorContext();
    await authorizeOperator(ctx.db, ctx.actor, 'custody:refresh_balance');
    reading = await readRequestedBalance(chainForWeb(), input.address);
  } catch (e) {
    return failure(e);
  }
  const out = await runCommand((ctx) => recordRequestedBalance(ctx.actor, reading), { address: input.address }, { name: 'custody.refresh_balance', idempotencyKey: key, financial: false });
  if (out.ok) revalidatePath('/usdt');
  return out;
}
