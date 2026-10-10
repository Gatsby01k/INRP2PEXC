'use server';

import { revalidatePath } from 'next/cache';
import { type OpenAccountPayload, type OpenAccountResult, openExchangeAccount } from '@inrp2p/clients';
import type { CommandResult } from '../command.ts';
import { runWorkspaceCommand } from '../client.ts';

/**
 * Opens the signed-in person's own account (D-17). The command decides everything — who may, one account per
 * person, the Exchange open, the person its administrator — and runs as them, from their session.
 */
export async function openAccountAction(input: OpenAccountPayload, key: string): Promise<CommandResult<OpenAccountResult>> {
  const out = await runWorkspaceCommand((ctx) => openExchangeAccount(ctx.actor), input, { name: 'client.open_account', idempotencyKey: key, financial: false });
  if (out.ok) revalidatePath('/', 'layout');
  return out;
}
