'use server';

import { revalidatePath } from 'next/cache';
import { addUpiId, archiveUpiId, updateUpiId } from '@inrp2p/clients';
import { type CommandResult } from '../command.ts';
import { runWorkspaceCommand, workspaceContext } from '../client.ts';

/**
 * A client's own UPI IDs (ADR 0029), as server actions — for every member of a client, with or without the Exchange, so a
 * trader manages its UPI IDs exactly as a client does. The client is the session's own membership, never the browser's;
 * each command checks again that the person is an administrator, and confirmed (ADR 0026).
 */
function refresh(): void {
  revalidatePath('/destinations');
  revalidatePath('/traders', 'layout');
}

/** The refusals worded for the person who pressed. */
const KEEP: ReadonlySet<string> = new Set(['INVALID_ARGUMENT', 'INVALID_AMOUNT', 'DUPLICATE_DESTINATION', 'DESTINATION_IN_USE', 'INVALID_TRANSITION']);

async function memberClientId(): Promise<string | null> {
  const ctx = await workspaceContext();
  return ctx.access.kind === 'MEMBER' ? ctx.access.member.clientId : null;
}

export async function addUpiIdAction(
  input: { vpa: string; label?: string | null; perPaymentLimit?: string | null; dailyLimit?: string | null },
  key: string,
): Promise<CommandResult<{ upiId: string; status: string }>> {
  const clientId = await memberClientId().catch(() => null);
  if (!clientId) return { ok: false, code: 'FORBIDDEN', message: 'This account is not linked to a client yet.' };
  // The name a payer checks is the client's own (ADR 0030): nothing typed in the browser is sent as it.
  const payload = { vpa: input.vpa, label: input.label ?? null, perPaymentLimit: input.perPaymentLimit ?? null, dailyLimit: input.dailyLimit ?? null, clientId };
  const out = await runWorkspaceCommand((ctx) => addUpiId(ctx.actor), payload, { name: 'client_upi.add', idempotencyKey: key, financial: false, keepMessages: KEEP });
  if (out.ok) refresh();
  return out;
}

export async function updateUpiIdAction(input: { upiId: string; label?: string | null; perPaymentLimit?: string | null; dailyLimit?: string | null }, key: string): Promise<CommandResult<{ updated: true }>> {
  const out = await runWorkspaceCommand((ctx) => updateUpiId(ctx.actor), input, { name: 'client_upi.update', idempotencyKey: key, financial: false, keepMessages: KEEP });
  if (out.ok) refresh();
  return out;
}

export async function archiveUpiIdAction(input: { upiId: string; reason: string }, key: string): Promise<CommandResult<{ archived: true }>> {
  const out = await runWorkspaceCommand((ctx) => archiveUpiId(ctx.actor), input, { name: 'client_upi.archive', idempotencyKey: key, financial: false, keepMessages: KEEP });
  if (out.ok) refresh();
  return out;
}
