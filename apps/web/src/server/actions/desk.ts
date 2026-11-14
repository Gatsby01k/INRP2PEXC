'use server';

import { revalidatePath } from 'next/cache';
import type { DirectionValue } from '@inrp2p/db';
import { archiveBankAccount, archiveUpiId, reviewUpiId } from '@inrp2p/clients';
import { cancelQuote, createQuote, createQuoteLink, createRequest, declineRequest, sendQuote, withdrawRequest } from '@inrp2p/quotes';
import {
  type NON_FINANCIAL_RESOLUTIONS, approveAdjustment, cancelTrade, confirmRefundLeg, createRefundLeg, openException, refundAndCancel, rejectAdjustment, requestAdjustment, resolveException,
  takeException, voidException, approveDestinationChange, cancelDestinationChange, refundExcess, rejectDestinationChange, requestDestinationChange, decideP2pPayment, postDeskDealMessage,
} from '@inrp2p/settlement';
import { type CommandResult, failure, runCommand } from '../command.ts';
import { attachmentOf, formText } from '../deal-files.ts';

/** Every mutation redraws the desk: the queue, the strip and the panels all read from the same rows. */
function refresh(): void {
  revalidatePath('/', 'layout');
}

export async function createRequestAction(
  input: { clientId: string; direction: DirectionValue; fixedSide: 'BASE' | 'QUOTE'; amount: string; targetRate?: string | null; bankAccountId?: string | null; walletId?: string | null },
  key: string,
): Promise<CommandResult<{ requestId: string; ref: string }>> {
  const out = await runCommand((ctx) => createRequest(ctx.actor, {}), input, { name: 'request.create', idempotencyKey: key });
  if (out.ok) refresh();
  return out as CommandResult<{ requestId: string; ref: string }>;
}

/**
 * Archives one of a client's bank accounts from the desk (`client_bank:add`: OWNER or SUPPORT, with step-up), with a
 * reason; audited, and the client is told. A client whose Exchange is closed — a trader only — cannot reach its own
 * Destinations page, so this is how the desk retires such an account (D-18: production's test accounts).
 */
export async function archiveClientBankAccountAction(input: { bankAccountId: string; reason: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => archiveBankAccount(ctx.actor), input, { name: 'client_bank.archive', idempotencyKey: key, financial: false });
  if (out.ok) refresh();
  return out;
}

/**
 * ADR 0029/0030: the desk decides a UPI ID a payer's report paused — put back with the name the address resolves to in a UPI app,
 * or rejected with a note the client reads (`client_bank:add`, with step-up).
 */
export async function reviewUpiIdAction(input: { upiId: string; decision: 'VERIFY' | 'REJECT'; resolvedName?: string | null; note?: string | null }, key: string): Promise<CommandResult<{ status: string }>> {
  const out = await runCommand((ctx) => reviewUpiId(ctx.actor), input, { name: 'client_upi.review', idempotencyKey: key, financial: false });
  if (out.ok) refresh();
  return out;
}

/** The desk retires a client's UPI ID (a compromised address): a deal paid to it then offers a bank transfer instead. */
export async function archiveClientUpiIdAction(input: { upiId: string; reason: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => archiveUpiId(ctx.actor), input, { name: 'client_upi.archive', idempotencyKey: key, financial: false });
  if (out.ok) refresh();
  return out;
}

export async function declineRequestAction(input: { requestId: string; reason: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => declineRequest(ctx.actor), input, { name: 'request.decline', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

/**
 * `request.withdraw` on the client's behalf (`request:withdraw`): the client told the desk they no longer want it.
 * Distinct from a decline, which is the desk's own refusal and is what the client is notified of.
 */
export async function withdrawRequestAction(input: { requestId: string; reason: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => withdrawRequest(ctx.actor), input, { name: 'request.withdraw', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

export interface QuoteDraft {
  readonly requestId: string;
  readonly routeId: string;
  readonly clientRate: string;
  readonly validitySeconds?: number;
  readonly amount?: string;
  readonly negativeMarginReason?: string | null;
  readonly withLink?: boolean;
}

/**
 * Create and send in one intent, which is how a dealer actually works: a draft nobody sees is not a quote. The
 * two commands are separate transactions with keys derived from the one intent, so retrying after a failed send
 * does not create a second quote.
 */
export async function createAndSendQuoteAction(draft: QuoteDraft, key: string): Promise<CommandResult<{ quoteId: string; expiresAt: string; link: string | null }>> {
  const created = await runCommand(
    (ctx) => createQuote(ctx.actor, {}),
    {
      requestId: draft.requestId,
      routeId: draft.routeId,
      clientRate: draft.clientRate,
      ...(draft.validitySeconds !== undefined ? { validitySeconds: draft.validitySeconds } : {}),
      ...(draft.amount ? { amount: draft.amount } : {}),
      ...(draft.negativeMarginReason ? { negativeMarginReason: draft.negativeMarginReason } : {}),
    },
    { name: 'quote.create', idempotencyKey: `${key}:create` },
  );
  if (!created.ok) return created;
  const quoteId = (created.result as { quoteId: string }).quoteId;

  let token: string | null = null;
  const sent = await runCommand(
    (ctx) =>
      sendQuote(ctx.actor, {}, (t) => {
        token = t;
      }),
    { quoteId, ...(draft.withLink ? { withLink: true } : {}) },
    { name: 'quote.send', idempotencyKey: `${key}:send` },
  );
  if (!sent.ok) return sent;
  refresh();
  const result = sent.result as { expiresAt: string };
  return { ok: true, result: { quoteId, expiresAt: result.expiresAt, link: token } };
}

/** Adds a shareable link to a quote that was sent without one. */
export async function createQuoteLinkAction(input: { quoteId: string }, key: string): Promise<CommandResult<{ link: string }>> {
  let token: string | null = null;
  const out = await runCommand(
    (ctx) =>
      createQuoteLink(ctx.actor, {}, (t) => {
        token = t;
      }),
    input,
    { name: 'quote_link.create', idempotencyKey: key },
  );
  if (!out.ok) return out;
  refresh();
  return token ? { ok: true, result: { link: token } } : failure(new Error('no link token was issued'));
}

export async function cancelQuoteAction(input: { quoteId: string; reason: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => cancelQuote(ctx.actor), input, { name: 'quote.cancel', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

export async function takeExceptionAction(input: { exceptionId: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => takeException(ctx.actor), input, { name: 'exception.take', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

/**
 * INRP2P decides a P2P payment its payee disputed or never answered (block 9): paid — with the sender the payee's bank
 * shows — and the escrow releases; or not paid, and the deal unwinds.
 */
export async function decideP2pPaymentAction(
  input: { tradeId: string; decision: 'PAID' | 'NOT_PAID'; notes: string; senderName?: string | null; senderAccount?: string | null },
  key: string,
): Promise<CommandResult<{ decision: 'PAID' | 'NOT_PAID'; legRef: string }>> {
  const out = await runCommand((ctx, deps) => decideP2pPayment(ctx.actor, deps), input, { name: 'escrow_payment.decide', idempotencyKey: key });
  if (out.ok) refresh();
  return out as CommandResult<{ decision: 'PAID' | 'NOT_PAID'; legRef: string }>;
}

/**
 * ADR 0023: INRP2P writes in a P2P deal's chat — `exception:open`, the permission support acts on a case with. The
 * first message after a side called support says INRP2P joined. A form, because a file may travel in it.
 */
export async function postDeskDealMessageAction(form: FormData): Promise<CommandResult<{ id: string }>> {
  let attached;
  try {
    attached = await attachmentOf(form);
  } catch (e) {
    return failure(e);
  }
  const out = await runCommand((ctx) => postDeskDealMessage(ctx.actor, attached.file), { tradeId: formText(form, 'tradeId') ?? '', body: formText(form, 'body'), file: attached.ref }, {
    name: 'deal_chat.post', idempotencyKey: formText(form, 'key') ?? '', financial: false,
  });
  if (out.ok) refresh();
  return out;
}

export async function resolveExceptionAction(
  input: { exceptionId: string; resolution: (typeof NON_FINANCIAL_RESOLUTIONS)[number]; notes: string },
  key: string,
): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => resolveException(ctx.actor), input, { name: 'exception.resolve', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

/**
 * `exception.void` — for a case that should never have been opened: an idempotent replay, or a mismatch whose
 * evidence turned out to be the desk's own. It closes the case without a resolution, so the record says plainly
 * that nothing was done rather than inventing a resolution that was not taken.
 */
export async function voidExceptionAction(input: { exceptionId: string; reason: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => voidException(ctx.actor), input, { name: 'exception.void', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

export async function requestAdjustmentAction(
  input: {
    tradeId: string; type: 'AMOUNT_CORRECTION' | 'RATE_CORRECTION' | 'FEE' | 'WRITE_OFF' | 'REFUND';
    deltaBaseUsdt?: string; deltaClientInr?: string; reason: string; exceptionId?: string | null;
  },
  key: string,
): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => requestAdjustment(ctx.actor), input, { name: 'adjustment.request', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

/** The other answer a second person can give: nothing posts, and the request stays on the record. */
export async function rejectAdjustmentAction(input: { adjustmentId: string; reason: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => rejectAdjustment(ctx.actor), input, { name: 'adjustment.reject', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

/**
 * `exception.open` — the cases the system cannot detect by itself: USDT sent on the wrong network, a client asking
 * to cancel, a mistake the desk made. Each puts the trade on hold.
 */
export async function openTradeExceptionAction(
  input: { tradeId: string; type: 'WRONG_NETWORK' | 'TRADE_CANCELLATION' | 'OPERATOR_MISTAKE'; notes: string },
  key: string,
): Promise<CommandResult<{ exceptionId: string; ref: string; opened: boolean }>> {
  const out = await runCommand(
    (ctx) => openException(ctx.actor),
    { type: input.type, subjectType: 'TRADE' as const, subjectId: input.tradeId, tradeId: input.tradeId, notes: input.notes },
    { name: 'exception.open', idempotencyKey: key },
  );
  if (out.ok) refresh();
  return out as CommandResult<{ exceptionId: string; ref: string; opened: boolean }>;
}

/** The second half of FI-31: a different person approves, and only then does the adjustment post. */
export async function approveAdjustmentAction(input: { adjustmentId: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => approveAdjustment(ctx.actor), input, { name: 'adjustment.approve', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

export async function cancelTradeAction(input: { tradeId: string; reason: string; exceptionId?: string | null }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => cancelTrade(ctx.actor), input, { name: 'trade.cancel', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

/** T10 step 1: create the refund leg that sends the client's own USDT back from the escrow it arrived at. */
export async function createRefundLegAction(
  input: { tradeId: string; sourceDepositAddressId: string; notes?: string | null },
  key: string,
): Promise<CommandResult<{ legId: string; ref: string }>> {
  const out = await runCommand((ctx) => createRefundLeg(ctx.actor), input, { name: 'refund_leg.create', idempotencyKey: key });
  if (out.ok) refresh();
  return out as CommandResult<{ legId: string; ref: string }>;
}

/** T10 step 2: a different person approves the refund and records its evidence (⧗✱). */
export async function confirmRefundLegAction(
  input: { legId: string; txHash: string; logIndex?: number },
  key: string,
): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx, deps) => confirmRefundLeg(ctx.actor, deps), input, { name: 'refund_leg.confirm', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

/** T10 step 3: with every confirmed USDT back, the trade is cancelled and the accept journal reversed. */
export async function refundAndCancelAction(input: { tradeId: string; exceptionId?: string | null; reason: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => refundAndCancel(ctx.actor), input, { name: 'trade.refund_and_cancel', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

/** D1 (TD-18): an open trade pays to another verified destination of its client — one person asks, another approves. */
export async function requestDestinationChangeAction(
  input: { tradeId: string; toBankAccountId?: string | null; toWalletId?: string | null; reason: string; evidence: string; exceptionId?: string | null },
  key: string,
): Promise<CommandResult<{ requestId: string; ref: string }>> {
  const out = await runCommand((ctx) => requestDestinationChange(ctx.actor), input, { name: 'trade.request_destination_change', idempotencyKey: key, financial: false });
  if (out.ok) refresh();
  return out as CommandResult<{ requestId: string; ref: string }>;
}

export async function approveDestinationChangeAction(input: { requestId: string; note?: string | null }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => approveDestinationChange(ctx.actor), input, { name: 'trade.approve_destination_change', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

export async function rejectDestinationChangeAction(input: { requestId: string; note: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => rejectDestinationChange(ctx.actor), input, { name: 'trade.reject_destination_change', idempotencyKey: key, financial: false });
  if (out.ok) refresh();
  return out;
}

export async function cancelDestinationChangeAction(input: { requestId: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => cancelDestinationChange(ctx.actor), input, { name: 'trade.cancel_destination_change', idempotencyKey: key, financial: false });
  if (out.ok) refresh();
  return out;
}

/** D2 (TD-19): return an overpayment to a verified destination of the client; someone else confirms it. */
export async function refundExcessAction(
  input: {
    tradeId: string; amount?: string | null; destinationWalletId: string; sourceDepositAddressId: string; exceptionId?: string | null;
  },
  key: string,
): Promise<CommandResult<{ legId: string; ref: string; amount: string }>> {
  const out = await runCommand((ctx) => refundExcess(ctx.actor), input, { name: 'trade.refund_excess', idempotencyKey: key });
  if (out.ok) refresh();
  return out as CommandResult<{ legId: string; ref: string; amount: string }>;
}

