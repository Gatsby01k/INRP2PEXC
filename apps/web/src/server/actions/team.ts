'use server';

import { revalidatePath } from 'next/cache';
import type { TeamRole } from '@inrp2p/db';
import { acceptTeamInvite, inviteTeamMember, removeTeamMember, revokeTeamInvite, setTeamMemberRole } from '@inrp2p/clients';
import type { CommandResult } from '../command.ts';
import { runWorkspaceCommand } from '../client.ts';

/**
 * A client's team (docs/adr/0020-desks.md §2.11), as server actions. Changing who can act for the client asks for the
 * administrator's authenticator: the command answers `STEP_UP_REQUIRED` and the screen asks for a code, then sends the
 * same intent again. Accepting an invitation is the invited person's own, signed in with the address it names.
 */
function refresh(): void {
  revalidatePath('/', 'layout');
}

const TEAM_WORDING: ReadonlySet<string> = new Set(['INVALID_TRANSITION', 'RATE_LIMITED', 'FORBIDDEN']);

async function run<P, R>(name: string, build: Parameters<typeof runWorkspaceCommand<P, R>>[0], payload: P, key: string): Promise<CommandResult<R>> {
  // Team changes move no money: they are not counted against the financial ceiling.
  const out = await runWorkspaceCommand(build, payload, { name, idempotencyKey: key, financial: false, keepMessages: TEAM_WORDING });
  if (out.ok) refresh();
  return out;
}

export async function inviteTeamMemberAction(input: { email: string; role: TeamRole }, key: string): Promise<CommandResult<{ inviteId: string; expiresAt: string }>> {
  return run('client_invite.create', (ctx) => inviteTeamMember(ctx.actor), input, key);
}

export async function revokeTeamInviteAction(input: { inviteId: string }, key: string): Promise<CommandResult<unknown>> {
  return run('client_invite.revoke', (ctx) => revokeTeamInvite(ctx.actor), input, key);
}

export async function setTeamMemberRoleAction(input: { clientUserId: string; role: TeamRole }, key: string): Promise<CommandResult<{ changed: boolean }>> {
  return run('client_user.set_team_role', (ctx) => setTeamMemberRole(ctx.actor), input, key);
}

export async function removeTeamMemberAction(input: { clientUserId: string }, key: string): Promise<CommandResult<{ removed: boolean }>> {
  return run('client_user.remove', (ctx) => removeTeamMember(ctx.actor), input, key);
}

export async function acceptTeamInviteAction(input: { inviteId: string }, key: string): Promise<CommandResult<{ clientId: string; role: TeamRole }>> {
  return run('client_invite.accept', (ctx) => acceptTeamInvite(ctx.actor), input, key);
}
