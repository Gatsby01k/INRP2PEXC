'use server';

import { revalidatePath } from 'next/cache';
import type { DirectionValue } from '@inrp2p/db';
import { markNotificationsRead } from '@inrp2p/notifications';
import { quoteIdForRef, requestIdForRef } from '@inrp2p/portal';
import { type AutoOutcome, acceptQuote, rejectQuote, repriceRequest, requestInstantQuote, withdrawRequest } from '@inrp2p/quotes';
import { addBankAccount, addWallet, archiveBankAccount, archiveWallet, setCanAcceptQuotes } from '@inrp2p/clients';
import { type P2pDisputeReason, answerClientDispute, callClientSupport, chooseClientPayMethod, claimIncomingFiat, confirmClientReceipt, openClientDispute, postClientDealMessage } from '@inrp2p/settlement';
import { chainForWeb } from '../chain.ts';
import { type CommandResult, failure } from '../command.ts';
import { runClientCommand, withClient, withMember } from '../client.ts';
import { attachmentOf, formText } from '../deal-files.ts';

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

/**
 * Asking for a price (ADR 0025): with automatic prices on, the answer is usually a firm quote at once — or the amount goes
 * to traders, or to a person; with them off, the request waits for the desk exactly as before. Either way the screen then
 * shows what the server says, so the result only carries what kind of answer it was.
 */
export async function requestQuoteAction(
  input: { direction: DirectionValue; fixedSide: 'BASE' | 'QUOTE'; amount: string; targetRate?: string | null; bankAccountId?: string | null; walletId?: string | null },
  key: string,
): Promise<CommandResult<{ ref: string; outcome: AutoOutcome['kind'] }>> {
  const result = await runClientCommand((ctx, deps) => requestInstantQuote(ctx.actor, deps), input, { name: 'request.instant_quote', idempotencyKey: key });
  if (result.ok) refresh();
  return result.ok ? { ok: true, result: { ref: result.result.ref, outcome: result.result.outcome.kind } } : result;
}

/** A new automatic price on the client's open request, after the last one ran out. */
export async function repriceAction(input: { requestRef: string }, key: string): Promise<CommandResult<{ outcome: AutoOutcome['kind'] }>> {
  const id = await withClient(async (ctx) => requestIdForRef(ctx.db, ctx.access.clientId, input.requestRef));
  if (!id.ok) return id;
  const out = await runClientCommand((ctx) => repriceRequest(ctx.actor), { requestId: id.result }, { name: 'request.reprice', idempotencyKey: key });
  if (out.ok) refresh();
  return out.ok ? { ok: true, result: { outcome: out.result.kind } } : out;
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
const CLAIM_MESSAGES: ReadonlySet<string> = new Set(['INVALID_UTR', 'DUPLICATE_UTR', 'NOT_OWN_ACCOUNT', 'ACCOUNT_NOT_ACTIVE', 'NOTHING_OWED', 'NO_COLLECTION', 'INVALID_AMOUNT', 'INVALID_TRANSITION', 'ESCROW_NOT_FUNDED']);

export async function claimPaymentAction(
  input: { tradeRef: string; rail: 'IMPS' | 'NEFT' | 'RTGS' | 'UPI'; utr: string; fromBankAccountId: string; amount?: string | null },
  key: string,
): Promise<CommandResult<{ legRef: string }>> {
  const out = await runClientCommand((ctx) => claimIncomingFiat(ctx.actor), input, { name: 'fiat_in.claim', idempotencyKey: key, keepMessages: CLAIM_MESSAGES });
  if (out.ok) revalidatePath(`/trades/${encodeURIComponent(input.tradeRef)}`);
  return out.ok ? { ok: true, result: { legRef: out.result.legRef } } : out;
}

/**
 * `payout.confirm_received` (ADR 0019) — a client selling USDT P2P confirms its counterparty's rupees arrived, and
 * who its bank shows sent them. Confirming releases the escrow, so only a match counts; the verdict comes back as it is.
 */
export async function confirmReceiptAction(
  input: { tradeRef: string; legRef: string; senderName: string; senderAccount?: string | null },
  key: string,
): Promise<CommandResult<{ verdict: string; confirmed: boolean }>> {
  const out = await runClientCommand((ctx) => confirmClientReceipt(ctx.actor, { chain: chainForWeb() }), input, { name: 'payout.confirm_received', idempotencyKey: key, keepMessages: new Set(['INVALID_TRANSITION', 'NOT_THE_PAYEE']) });
  if (out.ok) revalidatePath(`/trades/${encodeURIComponent(input.tradeRef)}`);
  return out.ok ? { ok: true, result: { verdict: out.result.verdict, confirmed: out.result.confirmed } } : out;
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
 * client-admin action: the command itself refuses anyone but an active CLIENT_ADMIN of this client, without a second
 * factor (`MFA_ENROLLMENT_REQUIRED`), or without a step-up by a factor other than their sign-in in the last ten minutes
 * (`STEP_UP_REQUIRED` with the factors that would do, which the page offers, then sends the same key). The client id
 * comes from the membership.
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

const DISPUTE_MESSAGES: ReadonlySet<string> = new Set(['INVALID_TRANSITION', 'NOT_THE_PAYEE', 'NOT_THE_PAYER', 'DISPUTE_EXISTS', 'INVALID_ARGUMENT']);

/**
 * The client of a P2P SELL says the trader's rupees did not reach its account (block 9): the deal stops and INRP2P
 * decides from its bank. What its bank shows, and a note for INRP2P only.
 */
export async function openDisputeAction(input: { tradeRef: string; reason: P2pDisputeReason; note?: string | null }, key: string): Promise<CommandResult<{ ref: string }>> {
  const out = await runClientCommand((ctx) => openClientDispute(ctx.actor), input, { name: 'escrow_dispute.open', idempotencyKey: key, keepMessages: DISPUTE_MESSAGES });
  if (out.ok) revalidatePath(`/trades/${encodeURIComponent(input.tradeRef)}`);
  return out;
}

/** The client of a P2P BUY adds its side for INRP2P when the seller says its payment did not arrive. */
export async function answerDisputeAction(input: { tradeRef: string; note: string }, key: string): Promise<CommandResult<{ ref: string }>> {
  const out = await runClientCommand((ctx) => answerClientDispute(ctx.actor), input, { name: 'escrow_dispute.answer', idempotencyKey: key, keepMessages: DISPUTE_MESSAGES, financial: false });
  if (out.ok) revalidatePath(`/trades/${encodeURIComponent(input.tradeRef)}`);
  return out;
}

/** ADR 0023: the refusals a deal's chat and its time to pay give, worded for the person who pressed. */
const CHAT_MESSAGES: ReadonlySet<string> = new Set(['CHAT_CLOSED', 'FILE_TOO_LARGE', 'FILE_TYPE_NOT_ALLOWED', 'RATE_LIMITED', 'NOT_THE_PAYER', 'INVALID_TRANSITION', 'P2P_METHOD_LOCKED', 'P2P_METHOD_TOO_LATE', 'INVALID_ARGUMENT']);

/**
 * `deal_chat.post` — a message in the trade's chat: words, a file, or the receipt of the client's own payment
 * (`legRef`). A form, because a file travels in it; the key comes in it too, one per press.
 */
export async function postDealMessageAction(form: FormData): Promise<CommandResult<{ id: string }>> {
  const tradeRef = formText(form, 'tradeRef') ?? '';
  let attached;
  try {
    attached = await attachmentOf(form);
  } catch (e) {
    return failure(e, CHAT_MESSAGES);
  }
  const out = await runClientCommand((ctx) => postClientDealMessage(ctx.actor, attached.file), { tradeRef, body: formText(form, 'body'), file: attached.ref, legRef: formText(form, 'legRef') }, {
    name: 'deal_chat.post', idempotencyKey: formText(form, 'key') ?? '', financial: false, keepMessages: CHAT_MESSAGES,
  });
  if (out.ok) revalidatePath(`/trades/${encodeURIComponent(tradeRef)}`);
  return out;
}

/** `deal_chat.call_support` — INRP2P is asked into the trade's chat. */
export async function callSupportAction(input: { tradeRef: string; note?: string | null }, key: string): Promise<CommandResult<{ ref: string; called: boolean }>> {
  const out = await runClientCommand((ctx) => callClientSupport(ctx.actor), input, { name: 'deal_chat.call_support', idempotencyKey: key, financial: false, keepMessages: CHAT_MESSAGES });
  if (out.ok) revalidatePath(`/trades/${encodeURIComponent(input.tradeRef)}`);
  return out;
}

/** `escrow_payment.choose_method` — how the client pays the seller, and so how long it has (ADR 0023). */
export async function choosePayMethodAction(input: { tradeRef: string; method: 'UPI' | 'IMPS' | 'NEFT' | 'RTGS' }, key: string): Promise<CommandResult<{ method: string; dueAt: string; finalUntil: string; changed: boolean }>> {
  const out = await runClientCommand((ctx) => chooseClientPayMethod(ctx.actor), input, { name: 'escrow_payment.choose_method', idempotencyKey: key, financial: false, keepMessages: CHAT_MESSAGES });
  if (out.ok) revalidatePath(`/trades/${encodeURIComponent(input.tradeRef)}`);
  return out;
}
