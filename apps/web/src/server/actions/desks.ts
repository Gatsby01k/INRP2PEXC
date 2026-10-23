'use server';

import { revalidatePath } from 'next/cache';
import type { DeskClientStatus, DirectionValue, FixedSideValue } from '@inrp2p/db';
import { type DeskPriceInput, openDesk, setDeskPrices, setDeskStatus, updateDesk } from '@inrp2p/traders';
import { createDeskDealLink, revokeDeskDealLink, setDeskClient } from '@inrp2p/quotes';
import { type CommandResult, failure } from '../command.ts';
import { runWorkspaceCommand } from '../client.ts';
import { publicOrigin } from '../site.ts';

/**
 * What a desk's people do in its workspace (docs/adr/0020-desks.md), as server actions. Each runs one desk command as
 * the signed-in person; the command finds the desk from the membership and checks the authority it needs — an
 * administrator for the desk itself, whoever can commit for its prices, links and clients. Nothing here decides anything.
 */
function refresh(): void {
  revalidatePath('/desk', 'layout');
}

/** The desk's own wording is right for its people; the shared operator phrasing is not. */
const DESK_WORDING: ReadonlySet<string> = new Set(['INVALID_TRANSITION', 'STALE_VERSION', 'INVALID_AMOUNT', 'DESK_NOT_LIVE']);

async function run<P, R>(name: string, build: Parameters<typeof runWorkspaceCommand<P, R>>[0], payload: P, key: string): Promise<CommandResult<R>> {
  const out = await runWorkspaceCommand(build, payload, { name, idempotencyKey: key, keepMessages: DESK_WORDING });
  if (out.ok) refresh();
  return out;
}

export async function openDeskAction(input: { handle: string; displayName: string; about?: string | null }, key: string): Promise<CommandResult<{ handle: string }>> {
  const out = await run('desk.open', (ctx) => openDesk(ctx.actor), input, key);
  return out.ok ? { ok: true, result: { handle: out.result.handle } } : out;
}

export async function updateDeskAction(input: { expectedVersion: number; displayName?: string; about?: string | null; handle?: string }, key: string): Promise<CommandResult<unknown>> {
  return run('desk.update', (ctx) => updateDesk(ctx.actor), input, key);
}

export async function setDeskStatusAction(input: { expectedVersion: number; status: 'LIVE' | 'PAUSED' }, key: string): Promise<CommandResult<unknown>> {
  return run('desk.set_status', (ctx) => setDeskStatus(ctx.actor), input, key);
}

export async function setDeskPricesAction(input: { prices: readonly DeskPriceInput[]; validForHours?: number }, key: string): Promise<CommandResult<unknown>> {
  return run('desk.set_prices', (ctx) => setDeskPrices(ctx.actor), input, key);
}

/**
 * A deal link for one client. Its secret comes back once, as the full address to share — the page it opens is on the
 * public site (`/d/<token>`). A retry of the same intent cannot show it again: only its hash was kept.
 */
export async function createDeskDealLinkAction(
  input: { direction: DirectionValue; fixedSide: FixedSideValue; amount: string; rate: string; validMinutes?: number; note?: string | null },
  key: string,
): Promise<CommandResult<{ url: string; ref: string; expiresAt: string }>> {
  let token: string | null = null;
  const out = await run(
    'desk_deal_link.create',
    (ctx) =>
      createDeskDealLink(ctx.actor, (t) => {
        token = t;
      }),
    input,
    key,
  );
  if (!out.ok) return out;
  if (!token) return failure(new Error('no deal link token was issued'));
  return { ok: true, result: { url: `${await publicOrigin()}/d/${token}`, ref: out.result.ref, expiresAt: out.result.expiresAt } };
}

export async function revokeDeskDealLinkAction(input: { linkId: string; reason: string }, key: string): Promise<CommandResult<unknown>> {
  return run('desk_deal_link.revoke', (ctx) => revokeDeskDealLink(ctx.actor), input, key);
}

export async function setDeskClientAction(
  input: { clientId: string; expectedVersion: number; status?: DeskClientStatus; maxDeal?: string | null; note?: string | null },
  key: string,
): Promise<CommandResult<{ status: DeskClientStatus; maxDeal: string | null; version: number; withdrawnRequests: number }>> {
  return run('desk_client.update', (ctx) => setDeskClient(ctx.actor), input, key);
}
