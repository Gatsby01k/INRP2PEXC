'use server';

import { revalidatePath } from 'next/cache';
import type { DirectionValue, FiatRail } from '@inrp2p/db';
import { setDayCapacity } from '@inrp2p/inr-accounts';
import { publishRouteRate } from '@inrp2p/pricing';
import { cancelQuote, createQuote, createQuoteLink, createRequest, declineRequest, sendQuote } from '@inrp2p/quotes';
import {
  type NON_FINANCIAL_RESOLUTIONS, approveAdjustment, cancelPayoutLeg, cancelTrade, confirmFirstLeg, confirmPayout,
  confirmRefundLeg, confirmRouteSettlement, createPayoutLeg, createRefundLeg, failPayoutLeg, recordIncomingFiat,
  recordLegEvidence, recordRouteSettlement, refundAndCancel, requestAdjustment, resolveException, revertFirstLeg, sendPayoutLeg,
  takeException, voidException,
} from '@inrp2p/settlement';
import { type CommandResult, failure, runCommand, withOperator } from '../command.ts';

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

export async function declineRequestAction(input: { requestId: string; reason: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => declineRequest(ctx.actor), input, { name: 'request.decline', idempotencyKey: key });
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

export async function createPayoutLegAction(
  input: { tradeId: string; amount: string; payer: 'EXCHANGE_ACCOUNT' | 'ROUTE'; inrAccountId?: string | null; treasuryWalletId?: string | null; notes?: string | null },
  key: string,
): Promise<CommandResult<{ legId: string; ref: string; remainingAfter: string }>> {
  const out = await runCommand((ctx) => createPayoutLeg(ctx.actor, {}), input, { name: 'payout_leg.create', idempotencyKey: key });
  if (out.ok) refresh();
  return out as CommandResult<{ legId: string; ref: string; remainingAfter: string }>;
}

export async function sendPayoutLegAction(input: { legId: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => sendPayoutLeg(ctx.actor), input, { name: 'payout_leg.send', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

export async function recordEvidenceAction(
  input: { legId: string; rail?: FiatRail; utr?: string; valueDate?: string | null; txHash?: string; logIndex?: number; fromAddress?: string; replaceReason?: string | null },
  key: string,
): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx, deps) => recordLegEvidence(ctx.actor, deps), input, { name: 'payout_leg.record_evidence', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

/**
 * The payout confirm (T6/T7). It goes through settlement's own wrapper, which opens the
 * `ROUTE_DIRECT_PAYOUT_MISMATCH` case in its own transaction after the confirm has rolled back — the desk must
 * not have to remember to do that.
 */
export async function confirmPayoutAction(input: { legId: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await withOperator((ctx, deps) => confirmPayout(ctx.db, ctx.actor, deps, { legId: input.legId, idempotencyKey: key }));
  if (out.ok) refresh();
  return out;
}

export async function failPayoutAction(input: { legId: string; reason: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => failPayoutLeg(ctx.actor), input, { name: 'payout_leg.fail', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

export async function cancelPayoutAction(input: { legId: string; reason: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => cancelPayoutLeg(ctx.actor), input, { name: 'payout_leg.cancel', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

export async function recordIncomingFiatAction(
  input: { tradeId: string; rail: FiatRail; utr: string; amount: string; inrAccountId: string; valueDate?: string | null },
  key: string,
): Promise<CommandResult<{ legId: string; ref: string }>> {
  const out = await runCommand((ctx) => recordIncomingFiat(ctx.actor), input, { name: 'fiat_in.record', idempotencyKey: key });
  if (out.ok) refresh();
  return out as CommandResult<{ legId: string; ref: string }>;
}

export async function confirmIncomingAction(input: { legId: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx, deps) => confirmFirstLeg(ctx.actor, deps), input, { name: 'settlement.confirm_incoming', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

/**
 * The other answer to a recorded INR payment: it never arrived. The leg fails, the recorded transfer is closed as
 * FAILED, and the trade goes back to awaiting the client — which is also what makes it cancellable again (T3).
 */
export async function revertIncomingAction(input: { legId: string; reason: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => revertFirstLeg(ctx.actor), input, { name: 'settlement.revert_incoming', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

export async function takeExceptionAction(input: { exceptionId: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => takeException(ctx.actor), input, { name: 'exception.take', idempotencyKey: key });
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
    deltaBaseUsdt?: string; deltaClientInr?: string; deltaRouteInr?: string; reason: string; exceptionId?: string | null;
  },
  key: string,
): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => requestAdjustment(ctx.actor), input, { name: 'adjustment.request', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

/** The second half of FI-31: a different person approves, and only then does the adjustment post. */
export async function approveAdjustmentAction(input: { adjustmentId: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => approveAdjustment(ctx.actor), input, { name: 'adjustment.approve', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

export async function cancelTradeAction(input: { tradeId: string; reason: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => cancelTrade(ctx.actor), input, { name: 'trade.cancel', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

/** T10 step 1: create the refund leg that sends the client's own funds back. */
export async function createRefundLegAction(
  input: { tradeId: string; inrAccountId?: string | null; treasuryWalletId?: string | null; notes?: string | null },
  key: string,
): Promise<CommandResult<{ legId: string; ref: string }>> {
  const out = await runCommand((ctx) => createRefundLeg(ctx.actor), input, { name: 'refund_leg.create', idempotencyKey: key });
  if (out.ok) refresh();
  return out as CommandResult<{ legId: string; ref: string }>;
}

/** T10 step 2: a different person approves the refund and records its evidence (⧗✱). */
export async function confirmRefundLegAction(
  input: { legId: string; rail?: FiatRail; utr?: string; txHash?: string; logIndex?: number },
  key: string,
): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx, deps) => confirmRefundLeg(ctx.actor, deps), input, { name: 'refund_leg.confirm', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

/** T10 step 3: with every confirmed rupee back, the trade is cancelled and the accept journal reversed. */
export async function refundAndCancelAction(input: { tradeId: string; exceptionId?: string | null; reason: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => refundAndCancel(ctx.actor), input, { name: 'trade.refund_and_cancel', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

export async function publishRouteRateAction(input: { routeId: string; direction: DirectionValue; rate: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => publishRouteRate(ctx.actor), input, { name: 'rates.publish_route', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

export async function recordRouteSettlementAction(
  input: {
    routeObligationId: string; flow: 'FROM_ROUTE_TO_EXCHANGE' | 'TO_ROUTE'; amount: string;
    rail?: FiatRail; utr?: string; txHash?: string; logIndex?: number; fromAddress?: string; inrAccountId?: string | null; treasuryWalletId?: string | null;
  },
  key: string,
): Promise<CommandResult<{ routeSettlementId: string; ref: string }>> {
  const out = await runCommand((ctx, deps) => recordRouteSettlement(ctx.actor, deps), input, { name: 'route_settlement.record', idempotencyKey: key });
  if (out.ok) refresh();
  return out as CommandResult<{ routeSettlementId: string; ref: string }>;
}

export async function confirmRouteSettlementAction(input: { routeSettlementId: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx, deps) => confirmRouteSettlement(ctx.actor, deps), input, { name: 'route_settlement.confirm', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

export async function setDayCapacityAction(input: { accountId: string; capacity: string; day?: string; reason: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx) => setDayCapacity(ctx.actor), input, { name: 'capacity.set_day', idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}
