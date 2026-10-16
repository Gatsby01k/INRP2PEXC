'use server';

import { revalidatePath } from 'next/cache';
import type { DirectionValue } from '@inrp2p/db';
import { markNotificationsRead } from '@inrp2p/notifications';
import { quoteIdForRef, requestIdForRef } from '@inrp2p/portal';
import { acceptQuote, createRequest, rejectQuote, withdrawRequest } from '@inrp2p/quotes';
import { addBankAccount, addWallet, archiveBankAccount, archiveWallet, setCanAcceptQuotes } from '@inrp2p/clients';
import { claimIncomingFiat } from '@inrp2p/settlement';
import { type CommandResult, failure } from '../command.ts';
import { runClientCommand, withClient, withMember } from '../client.ts';

/**
 * What a client can do, as server actions.
 *
 * Every one of them runs a domain command as the signed-in client user: the client id is resolved from their
 * membership inside the transaction, never taken from the browser, and the command re-checks authority of its
 * own accord (D-01 for quote decisions). Nothing here decides anything; it only carries the payload.
 */
function refresh(): void {
  revalidatePath('/exchange', 'layout');
}

export async function requestQuoteAction(
  input: { direction: DirectionValue; fixedSide: 'BASE' | 'QUOTE'; amount: string; targetRate?: string | null; bankAccountId?: string | null; walletId?: string | null },
  key: string,
): Promise<CommandResult<{ requestId: string; ref: string }>> {
  const out = await withClient(async (ctx) => ctx.access.clientId);
  if (!out.ok) return out;
  const result = await runClientCommand((ctx) => createRequest(ctx.actor, {}), { ...input, clientId: out.result }, { name: 'request.create', idempotencyKey: key });
  if (result.ok) refresh();
  return result as CommandResult<{ requestId: string; ref: string }>;
}

export async function withdrawRequestAction(input: { requestRef: string }, key: string): Promise<CommandResult<unknown>> {
  const id = await withClient(async (ctx) => requestIdForRef(ctx.db, ctx.access.clientId, input.requestRef));
  if (!id.ok) return id;
  const out = await runClientCommand((ctx) => withdrawRequest(ctx.actor), { requestId: id.result }, { name: 'request.withdraw', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

/**
 * `quote.accept` in the app (D-01). The client's own session is the authority here — the OTP belongs to the
 * shareable link, where there is no session to be the authority.
 */
export async function acceptQuoteAction(input: { quoteRef: string }, key: string): Promise<CommandResult<{ tradeRef: string }>> {
  const id = await withClient(async (ctx) => quoteIdForRef(ctx.db, ctx.access.clientId, input.quoteRef));
  if (!id.ok) return id;
  const out = await runClientCommand((ctx, deps) => acceptQuote(ctx.actor, deps), { quoteId: id.result }, { name: 'quote.accept', idempotencyKey: key });
  if (out.ok) refresh();
  return out as CommandResult<{ tradeRef: string }>;
}

export async function rejectQuoteAction(input: { quoteRef: string }, key: string): Promise<CommandResult<unknown>> {
  const id = await withClient(async (ctx) => quoteIdForRef(ctx.db, ctx.access.clientId, input.quoteRef));
  if (!id.ok) return id;
  const out = await runClientCommand((ctx) => rejectQuote(ctx.actor), { quoteId: id.result }, { name: 'quote.reject', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

/**
 * `fiat_in.claim` (ADR 0018) — "I paid": the client files its INR payment itself, from one of its own registered
 * accounts, under the reference its bank gave it. The refusals are worded for the client, so they are shown as they
 * are.
 */
const CLAIM_MESSAGES: ReadonlySet<string> = new Set(['INVALID_UTR', 'DUPLICATE_UTR', 'NOT_OWN_ACCOUNT', 'ACCOUNT_NOT_ACTIVE', 'NOTHING_OWED', 'NO_COLLECTION', 'INVALID_AMOUNT', 'INVALID_TRANSITION']);

export async function claimPaymentAction(
  input: { tradeRef: string; rail: 'IMPS' | 'NEFT' | 'RTGS' | 'UPI'; utr: string; fromBankAccountId: string; amount?: string | null },
  key: string,
): Promise<CommandResult<{ legRef: string }>> {
  const out = await runClientCommand((ctx) => claimIncomingFiat(ctx.actor), input, { name: 'fiat_in.claim', idempotencyKey: key, keepMessages: CLAIM_MESSAGES });
  if (out.ok) revalidatePath(`/trades/${encodeURIComponent(input.tradeRef)}`);
  return out.ok ? { ok: true, result: { legRef: out.result.legRef } } : out;
}

/**
 * Destinations are **not** managed from the client product in V1.
 *
 * Adding or archiving one is a sensitive client-admin action that needs an enrolled authenticator and a fresh
 * TOTP step-up (SECURITY §2.2, D-08), and client TOTP enrolment is not built yet (TD-11). Exposing a server
 * action that every call would refuse is not a smaller gap than exposing none — it is the same gap with an
 * attack surface — so the client actions do not exist. The desk acts on the client's behalf through
 * `client_bank:add` and `client_wallet:manage`, both of which already do.
 */

/**
 * Marking notifications read. Deliberately not a domain command: it moves no money and changes no state of
 * record. The client id still comes from the session, so one client can never mark another's inbox.
 */
export async function markNotificationsReadAction(ids: readonly string[]): Promise<CommandResult<{ marked: number }>> {
  try {
    const out = await withMember(async (ctx, member) => ({ marked: await markNotificationsRead(ctx.db, member.clientId, ids) }));
    if (out.ok) revalidatePath('/notifications', 'layout');
    return out;
  } catch (e) {
    return failure(e);
  }
}

/**
 * Destinations and quote authority, changed by the client's own administrator (TD-11, D-08). Each is a sensitive
 * client-admin action: the command itself refuses anyone but an active CLIENT_ADMIN of this client, without an
 * authenticator (`MFA_ENROLLMENT_REQUIRED`), or without a step-up in the last ten minutes (`STEP_UP_REQUIRED`, which
 * the page answers with the authenticator dialog and the same key). The client id comes from the membership.
 */
function refreshDestinations(): void {
  revalidatePath('/destinations');
}

export async function addBankAccountAction(input: { holderName: string; bankName: string; ifsc: string; accountNumber: string }, key: string): Promise<CommandResult<unknown>> {
  const id = await withClient(async (ctx) => ctx.access.clientId);
  if (!id.ok) return id;
  const out = await runClientCommand((ctx, deps) => addBankAccount(ctx.actor, deps.protector), { ...input, clientId: id.result }, { name: 'client_bank.add', idempotencyKey: key, financial: false });
  if (out.ok) refreshDestinations();
  return out;
}

export async function archiveBankAccountAction(input: { bankAccountId: string; reason: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runClientCommand((ctx) => archiveBankAccount(ctx.actor), input, { name: 'client_bank.archive', idempotencyKey: key, financial: false });
  if (out.ok) refreshDestinations();
  return out;
}

export async function addWalletAction(input: { address: string; purpose: 'DESTINATION' | 'SOURCE' | 'BOTH'; label: string }, key: string): Promise<CommandResult<unknown>> {
  const id = await withClient(async (ctx) => ctx.access.clientId);
  if (!id.ok) return id;
  const out = await runClientCommand((ctx) => addWallet(ctx.actor), { ...input, network: 'TRON' as const, clientId: id.result }, { name: 'client_wallet.add', idempotencyKey: key, financial: false });
  if (out.ok) refreshDestinations();
  return out;
}

export async function archiveWalletAction(input: { walletId: string; reason: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runClientCommand((ctx) => archiveWallet(ctx.actor), input, { name: 'client_wallet.archive', idempotencyKey: key, financial: false });
  if (out.ok) refreshDestinations();
  return out;
}

export async function setCanAcceptQuotesAction(input: { clientUserId: string; canAcceptQuotes: boolean }, key: string): Promise<CommandResult<unknown>> {
  const out = await runClientCommand((ctx) => setCanAcceptQuotes(ctx.actor), input, { name: 'client_user.set_accept_quotes', idempotencyKey: key, financial: false });
  if (out.ok) refreshDestinations();
  return out;
}

