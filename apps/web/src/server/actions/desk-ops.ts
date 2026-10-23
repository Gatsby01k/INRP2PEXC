'use server';

import { revalidatePath } from 'next/cache';
import { decideFeePolicy, hideDeskPage, proposeFeePolicy, renameDesk, resumeDesk, showDeskPage, suspendDesk, withdrawFeePolicy } from '@inrp2p/quotes';
import { type CommandResult, runCommand } from '../command.ts';

/**
 * INRP2P's desk over the desks (block 11): suspend or resume a desk, hide or show its page, rename it, and change the
 * platform's fee by proposal and approval. Each a command that authorizes itself; every page that shows a desk redraws.
 */
const done = <R>(out: CommandResult<R>): CommandResult<R> => {
  if (out.ok) revalidatePath('/', 'layout');
  return out;
};

export async function suspendDeskAction(input: { deskId: string; reason: string }, key: string) {
  return done(await runCommand((ctx) => suspendDesk(ctx.actor), input, { name: 'desk.suspend', idempotencyKey: key }));
}

export async function resumeDeskAction(input: { deskId: string; note?: string | null }, key: string) {
  return done(await runCommand((ctx) => resumeDesk(ctx.actor), input, { name: 'desk.resume', idempotencyKey: key, financial: false }));
}

export async function hideDeskPageAction(input: { deskId: string; reason: string }, key: string) {
  return done(await runCommand((ctx) => hideDeskPage(ctx.actor), input, { name: 'desk.hide_page', idempotencyKey: key, financial: false }));
}

export async function showDeskPageAction(input: { deskId: string; note?: string | null }, key: string) {
  return done(await runCommand((ctx) => showDeskPage(ctx.actor), input, { name: 'desk.show_page', idempotencyKey: key, financial: false }));
}

export async function renameDeskAction(input: { deskId: string; displayName?: string | null; handle?: string | null; reason: string }, key: string) {
  return done(await runCommand((ctx) => renameDesk(ctx.actor), input, { name: 'desk.rename', idempotencyKey: key, financial: false }));
}

export async function proposeFeeAction(input: { ownDealBps: number; networkDealBps: number; reason: string }, key: string) {
  return done(await runCommand((ctx) => proposeFeePolicy(ctx.actor), input, { name: 'fee_policy.propose', idempotencyKey: key, financial: false }));
}

export async function decideFeeAction(input: { proposalId: string; decision: 'APPROVE' | 'REJECT'; note?: string | null }, key: string) {
  return done(await runCommand((ctx) => decideFeePolicy(ctx.actor), input, { name: 'fee_policy.decide', idempotencyKey: key }));
}

export async function withdrawFeeAction(input: { proposalId: string }, key: string) {
  return done(await runCommand((ctx) => withdrawFeePolicy(ctx.actor), input, { name: 'fee_policy.withdraw', idempotencyKey: key, financial: false }));
}
