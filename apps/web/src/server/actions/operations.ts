'use server';

import { revalidatePath } from 'next/cache';
import type { NewBusinessState } from '@inrp2p/trades';
import { setNewBusiness } from '@inrp2p/settlement';
import { type CommandResult, runCommand } from '../command.ts';

/**
 * Pause or resume new business (`settings:new_business`, OWNER or FINANCE, ⧗), with the reason (RUNBOOKS
 * `pause-new-business`). Started trades are never touched by either.
 */
export async function setNewBusinessAction(input: { paused: boolean; reason: string }, key: string): Promise<CommandResult<NewBusinessState>> {
  const out = await runCommand((ctx) => setNewBusiness(ctx.actor), input, { name: input.paused ? 'settings.pause_new_business' : 'settings.resume_new_business', idempotencyKey: key });
  if (out.ok) revalidatePath('/', 'layout');
  return out;
}

