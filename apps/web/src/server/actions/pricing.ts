'use server';

import { revalidatePath } from 'next/cache';
import { setPricingPolicy } from '@inrp2p/pricing';
import { type CommandResult, runCommand } from '../command.ts';

/**
 * The exchange's automatic prices (ADR 0025): switched on or off and their guard-rails set by a person with
 * `pricing:configure`, with the reason. The command refuses switching on without a fresh market reference.
 */
export async function setPricingPolicyAction(
  input: {
    expectedPolicyId: string; autoQuote?: boolean; rfq?: boolean; referenceMaxAgeSeconds?: number; maxPremiumBps?: number; binBps?: number; learningDays?: number;
    rfqWindowSeconds?: number; rfqMaxTraders?: number; reason: string;
  },
  key: string,
): Promise<CommandResult<{ policyId: string }>> {
  const out = await runCommand((ctx) => setPricingPolicy(ctx.actor), input, { name: 'pricing.set_policy', idempotencyKey: key, financial: false });
  if (out.ok) revalidatePath('/rates');
  return out;
}
