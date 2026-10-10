'use server';

import { revalidatePath } from 'next/cache';
import type { NewBusinessState, RestoreFenceState } from '@inrp2p/trades';
import { decideRestoreFenceLift, raiseRestoreFence, requestRestoreFenceLift, setNewBusiness } from '@inrp2p/settlement';
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

/**
 * Hold outgoing payments by hand (`operations:restore_fence`, OWNER or FINANCE, ⧗) — the restore procedure's first step
 * where the platform hides the database's identity, or whenever records are known to be lost (RUNBOOKS `restore-fence`).
 */
export async function raiseRestoreFenceAction(input: { reason: string }, key: string): Promise<CommandResult<RestoreFenceState>> {
  const out = await runCommand((ctx) => raiseRestoreFence(ctx.actor), input, { name: 'operations.raise_restore_fence', idempotencyKey: key });
  if (out.ok) revalidatePath('/', 'layout');
  return out;
}

/** Record the reconciliation and ask a second person to release outgoing payments (`operations:restore_fence`, ⧗). */
export async function requestRestoreFenceLiftAction(input: { reconciliation: string }, key: string): Promise<CommandResult<RestoreFenceState>> {
  const out = await runCommand((ctx) => requestRestoreFenceLift(ctx.actor), input, { name: 'operations.request_restore_fence_lift', idempotencyKey: key });
  if (out.ok) revalidatePath('/', 'layout');
  return out;
}

/** Approve or decline releasing outgoing payments (`operations:approve_restore_fence_lift`, ⧗✱ — never the person who reconciled). */
export async function decideRestoreFenceLiftAction(input: { liftId: string; approve: boolean; note: string }, key: string): Promise<CommandResult<RestoreFenceState>> {
  const out = await runCommand((ctx) => decideRestoreFenceLift(ctx.actor), input, { name: input.approve ? 'operations.approve_restore_fence_lift' : 'operations.decline_restore_fence_lift', idempotencyKey: key });
  if (out.ok) revalidatePath('/', 'layout');
  return out;
}
