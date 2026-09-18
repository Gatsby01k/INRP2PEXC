import { sql } from 'kysely';
import { DomainError, Money, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import type { FiatRail, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type OperatorActor, operatorCommand } from '@inrp2p/identity';
import { effectiveObligations, legTotals, lockTrade, transitionTrade } from '@inrp2p/trades';
import { openExceptionInTx } from './exceptions.ts';
import { lockLeg, nextLegSeq } from './legs.ts';
import { lockMovement, postMovement, recordCryptoTransfer, recordFiatTransfer, verifyCryptoTransfer } from './movements.ts';
import type { SettlementDeps } from './policy.ts';

/**
 * `fiat_in.record` (T2, BUY) — `settlement:record_incoming`. The client says it sent the INR; the desk records the
 * reference. Recording needs no step-up (nothing is confirmed yet); making it count is `settlement:confirm_incoming`
 * (⧗). The UTR is unique across all fiat movements (FI-22), so the same payment cannot be claimed twice.
 */
export function recordIncomingFiat(actor: OperatorActor) {
  return operatorCommand(actor, 'settlement:record_incoming', async (ctx, p: { tradeId: string; rail: FiatRail; utr: string; amount: string; inrAccountId: string; valueDate?: string | null }) => {
    const trade = await lockTrade(ctx.tx, p.tradeId);
    if (trade.direction !== 'BUY_USDT') throw new DomainError('INVALID_ARGUMENT', 'only a BUY trade receives INR from the client');
    if (trade.lifecycle_state !== 'AWAITING_FIRST_LEG') throw new DomainError('INVALID_TRANSITION', `trade is ${trade.lifecycle_state}`);
    const amount = Money.parse(p.amount, 'INR');
    const inrAccountId = requireUuid(p.inrAccountId, 'inrAccountId');
    const account = await ctx.tx.selectFrom('inr_settlement_account').select(['status', 'direction']).where('id', '=', inrAccountId).forShare().executeTakeFirstOrThrow();
    if (account.status !== 'ACTIVE') throw new DomainError('ACCOUNT_NOT_ACTIVE', `INR account is ${account.status}`);

    const seq = await nextLegSeq(ctx, trade.id);
    const leg = await ctx.tx
      .insertInto('settlement_leg')
      .values({
        trade_id: trade.id, seq, side: 'CLIENT_TO_EXCHANGE', asset: 'INR', amount_minor: amount.minor, status: 'PROCESSING',
        payer: 'CLIENT', inr_account_id: null, created_by: ctx.actor.id ?? 'SYSTEM', sent_at: sql<Date>`inrp2p_now()`,
      })
      .returning(['id', 'ref'])
      .executeTakeFirstOrThrow();
    const movement = await recordFiatTransfer(ctx, {
      rail: requireOneOf(p.rail, 'rail', ['IMPS', 'NEFT', 'RTGS', 'UPI'] as const),
      utr: p.utr,
      amount,
      payerType: 'CLIENT',
      payerId: trade.client_id,
      payeeType: 'EXCHANGE_ACCOUNT',
      payeeId: inrAccountId,
      destinationMasked: 'exchange collection account',
      valueDate: p.valueDate ?? null,
    });
    await ctx.tx
      .insertInto('transfer_allocation')
      .values({ transfer_kind: 'FIAT', fiat_transfer_id: movement.transferId, dimension: 'CLIENT', settlement_leg_id: leg.id, amount_minor: amount.minor, allocated_by: ctx.actor.id ?? 'SYSTEM' })
      .execute();
    await transitionTrade(ctx, trade, 'FIRST_LEG_DETECTED', { extra: { leg_ref: leg.ref, amount } });
    await appendAudit(ctx, { action: 'leg.created', entityType: 'settlement_leg', entityId: leg.id, after: { ref: leg.ref, side: 'CLIENT_TO_EXCHANGE', amount, inr_account_id: inrAccountId } });
    return { legId: leg.id, ref: leg.ref, transferId: movement.transferId };
  });
}

/**
 * T2 (SELL): a TRC20 transfer is attributed to a trade **only** through the open deposit assignment of the
 * address it arrived at (D-02, FI-26) — never by amount or sender. Funds at a cooled-down or unknown address
 * become an exception and wait for an operator.
 */
export async function recordClientDeposit(
  ctx: TxContext,
  input: { txHash: string; logIndex: number; tokenContract: string; fromAddress: string; toAddress: string; amount: Money<'USDT'>; source: 'SCANNER' | 'OPERATOR_SUBMITTED' },
): Promise<{ transferId: string; tradeId: string | null; legId: string | null; exceptionId?: string }> {
  const address = await ctx.tx
    .selectFrom('deposit_address')
    .select(['id', 'status', 'treasury_wallet_id'])
    .where('address', '=', input.toAddress)
    .executeTakeFirst();
  const assignment = address
    ? await ctx.tx
        .selectFrom('deposit_assignment')
        .select(['id', 'trade_id', 'expected_amount_minor', 'released_at'])
        .where('deposit_address_id', '=', address.id)
        .orderBy('assigned_at', 'desc')
        .executeTakeFirst()
    : undefined;
  const open = assignment && !assignment.released_at ? assignment : undefined;

  if (!open) {
    // Funds straight to a treasury wallet still have a known destination account, so they can be parked in
    // suspense on confirmation; anything else is money at an address we do not recognise at all.
    const wallet = address
      ? null
      : await ctx.tx.selectFrom('treasury_wallet').select('id').where('network', '=', 'TRON').where('address', '=', input.toAddress).executeTakeFirst();
    const treasuryWalletId = address?.treasury_wallet_id ?? wallet?.id ?? null;
    const recorded = await recordCryptoTransfer(ctx, {
      ...input,
      payerType: 'UNKNOWN',
      payeeType: treasuryWalletId ? 'EXCHANGE_TREASURY' : 'UNKNOWN',
      payeeId: treasuryWalletId,
    });
    const type = assignment ? 'FUNDS_AFTER_TRADE_CLOSED' : 'UNALLOCATED_DEPOSIT';
    const opened = await openExceptionInTx(ctx, {
      type,
      subjectType: 'CRYPTO_TRANSFER',
      subjectId: recorded.transferId,
      tradeId: null,
      details: { to: input.toAddress, amount: input.amount.toDecimalString(), previous_trade_id: assignment?.trade_id ?? null },
    });
    return { transferId: recorded.transferId, tradeId: null, legId: null, exceptionId: opened.exceptionId };
  }

  const trade = await lockTrade(ctx.tx, open.trade_id);
  const existingTx = await ctx.tx
    .selectFrom('crypto_transfer')
    .select('id')
    .where('network', '=', 'TRON')
    .where('tx_hash', '=', input.txHash.toLowerCase())
    .where('log_index', '=', input.logIndex)
    .executeTakeFirst();
  if (existingTx) return { transferId: existingTx.id, tradeId: trade.id, legId: null };

  const recorded = await recordCryptoTransfer(ctx, {
    ...input,
    payerType: 'CLIENT',
    payerId: trade.client_id,
    payeeType: 'EXCHANGE_TREASURY',
    payeeId: address!.treasury_wallet_id,
  });
  const seq = await nextLegSeq(ctx, trade.id);
  const leg = await ctx.tx
    .insertInto('settlement_leg')
    .values({
      trade_id: trade.id, seq, side: 'CLIENT_TO_EXCHANGE', asset: 'USDT', amount_minor: input.amount.minor, status: 'PROCESSING',
      payer: 'CLIENT', created_by: ctx.actor.id ?? `SYSTEM:${ctx.commandName}`, sent_at: sql<Date>`inrp2p_now()`,
    })
    .returning(['id', 'ref'])
    .executeTakeFirstOrThrow();
  await ctx.tx
    .insertInto('transfer_allocation')
    .values({ transfer_kind: 'CRYPTO', crypto_transfer_id: recorded.transferId, dimension: 'CLIENT', settlement_leg_id: leg.id, amount_minor: input.amount.minor, allocated_by: ctx.actor.id ?? 'SYSTEM' })
    .execute();
  if (trade.lifecycle_state === 'AWAITING_FIRST_LEG') await transitionTrade(ctx, trade, 'FIRST_LEG_DETECTED', { extra: { leg_ref: leg.ref, amount: input.amount } });

  // The amount and the sender are checked, and disagreements become exceptions — never silent adjustments.
  const expected = open.expected_amount_minor;
  if (expected !== null && input.amount.minor !== expected) {
    await openExceptionInTx(ctx, {
      type: input.amount.minor < expected ? 'USDT_WRONG_AMOUNT' : 'USDT_OVERPAYMENT',
      subjectType: 'CRYPTO_TRANSFER', subjectId: recorded.transferId, tradeId: trade.id,
      details: { expected: Money.ofMinor(expected, 'USDT').toDecimalString(), received: input.amount.toDecimalString() },
    });
  }
  const sources = await ctx.tx
    .selectFrom('crypto_wallet')
    .select('address')
    .where('client_id', '=', trade.client_id)
    .where('status', '=', 'ACTIVE')
    .where('purpose', 'in', ['SOURCE', 'BOTH'])
    .execute();
  if (sources.length > 0 && !sources.some((w) => w.address === input.fromAddress)) {
    await openExceptionInTx(ctx, {
      type: 'USDT_UNEXPECTED_SENDER', subjectType: 'CRYPTO_TRANSFER', subjectId: recorded.transferId, tradeId: trade.id,
      details: { from: input.fromAddress, registered: sources.length },
    });
  }
  return { transferId: recorded.transferId, tradeId: trade.id, legId: leg.id };
}

/**
 * `crypto.submit_tx_for_verification` — `crypto:submit_tx_for_verification`. An operator (or the client through
 * the desk) hands over a tx hash; the chain, not the operator, decides what it was (FI-24, FI-26).
 */
export function submitTxForVerification(actor: OperatorActor, deps: SettlementDeps) {
  return operatorCommand(actor, 'crypto:submit_tx_for_verification', async (ctx, p: { txHash: string; logIndex?: number }) => {
    const txHash = requireText(p.txHash, 'txHash', 66).toLowerCase().replace(/^0x/, '');
    const logIndex = p.logIndex ?? 0;
    const receipt = await deps.chain.lookupTransfer('TRON', txHash, logIndex);
    if (!receipt) throw new DomainError('NOT_FOUND', 'the chain does not know this transfer');
    if (receipt.tokenContract !== deps.chain.tokenContract) throw new DomainError('INVALID_ARGUMENT', 'this transfer is not a USDT transfer on the configured contract');
    return recordClientDeposit(ctx, {
      txHash,
      logIndex,
      tokenContract: receipt.tokenContract,
      fromAddress: receipt.fromAddress,
      toAddress: receipt.toAddress,
      amount: Money.ofMinor(receipt.amountMinor, 'USDT'),
      source: 'OPERATOR_SUBMITTED',
    });
  });
}

export interface ClientLegConfirmation {
  readonly status: 'AWAITING_FIRST_LEG' | 'FIRST_LEG_DETECTED' | 'FIRST_LEG_CONFIRMED' | 'SETTLING' | 'PARTIALLY_SETTLED' | 'COMPLETED' | 'CANCELLED';
  readonly confirmed: boolean;
  readonly matchedObligation: boolean;
}

/**
 * The client-leg confirmation itself (T4), with no actor policy of its own: an operator reaches it through
 * `settlement:confirm_incoming` (⧗) and the TRON scanner reaches it as a system job once the chain has made the
 * transfer final. Either way the movement posts its one journal (FI-27) and the leg completes.
 */
export async function confirmClientLegInTx(ctx: TxContext, deps: SettlementDeps, legId: string): Promise<ClientLegConfirmation> {
  const id = requireUuid(legId, 'legId');
  const legPeek = await ctx.tx.selectFrom('settlement_leg').select('trade_id').where('id', '=', id).executeTakeFirstOrThrow();
  const trade = await lockTrade(ctx.tx, legPeek.trade_id);
  const leg = await lockLeg(ctx, id);
  if (leg.side !== 'CLIENT_TO_EXCHANGE') throw new DomainError('INVALID_ARGUMENT', 'this is not the client leg');
  if (leg.status !== 'PROCESSING') throw new DomainError('INVALID_TRANSITION', `leg is ${leg.status}`);
  if (trade.lifecycle_state !== 'FIRST_LEG_DETECTED') throw new DomainError('INVALID_TRANSITION', `trade is ${trade.lifecycle_state}`);

  const allocation = await ctx.tx
    .selectFrom('transfer_allocation')
    .select(['transfer_kind', 'fiat_transfer_id', 'crypto_transfer_id'])
    .where('settlement_leg_id', '=', leg.id)
    .where('voided_at', 'is', null)
    .executeTakeFirstOrThrow();
  const movementId = (allocation.fiat_transfer_id ?? allocation.crypto_transfer_id)!;
  await lockMovement(ctx, allocation.transfer_kind, movementId);
  const amount = Money.ofMinor(leg.amount_minor, leg.asset);

  let payeeAccount: { kind: 'EXCHANGE_ACCOUNT'; inrAccountId: string } | { kind: 'EXCHANGE_TREASURY'; walletId: string };
  if (allocation.transfer_kind === 'FIAT') {
    const f = await ctx.tx.selectFrom('fiat_transfer').select(['status', 'payee_id']).where('id', '=', movementId).executeTakeFirstOrThrow();
    if (f.status !== 'RECORDED') throw new DomainError('INVALID_TRANSITION', `the payment reference is ${f.status}`);
    await ctx.tx.updateTable('fiat_transfer').set({ status: 'CONFIRMED', confirmed_at: sql<Date>`inrp2p_now()` }).where('id', '=', movementId).execute();
    payeeAccount = { kind: 'EXCHANGE_ACCOUNT', inrAccountId: f.payee_id };
  } else {
    const verified = await verifyCryptoTransfer(ctx, deps, movementId);
    if (!verified.confirmed) throw new DomainError('TRANSFER_NOT_CONFIRMED', verified.reason ?? 'the transfer is not final on chain');
    const c = await ctx.tx.selectFrom('crypto_transfer').select('payee_id').where('id', '=', movementId).executeTakeFirstOrThrow();
    if (!c.payee_id) throw new DomainError('INVALID_ARGUMENT', 'the transfer has no treasury destination');
    payeeAccount = { kind: 'EXCHANGE_TREASURY', walletId: c.payee_id };
  }

  await postMovement(ctx, {
    kind: allocation.transfer_kind,
    movementId,
    amount,
    from: { kind: 'CLIENT', clientId: trade.client_id },
    to: payeeAccount,
    tradeId: trade.id,
    purpose: 'CLIENT_FIRST_LEG',
  });
  await ctx.tx.updateTable('settlement_leg').set({ status: 'COMPLETED', confirmed_at: sql<Date>`inrp2p_now()` }).where('id', '=', leg.id).execute();
  await appendAudit(ctx, { action: 'leg.confirmed', entityType: 'settlement_leg', entityId: leg.id, before: { status: 'PROCESSING' }, after: { status: 'COMPLETED', side: leg.side, amount } });

  const { receivable } = await effectiveObligations(ctx.tx, trade.id);
  const totals = await legTotals(ctx.tx, trade.id);
  if (totals.received !== receivable.minor) {
    await openExceptionInTx(ctx, {
      type: totals.received < receivable.minor ? 'USDT_WRONG_AMOUNT' : 'USDT_OVERPAYMENT',
      subjectType: 'TRADE', subjectId: trade.id, tradeId: trade.id,
      details: { expected: receivable.toDecimalString(), received: Money.ofMinor(totals.received, receivable.currency).toDecimalString() },
    });
    return { status: trade.lifecycle_state, confirmed: true, matchedObligation: false };
  }
  if (trade.hold) return { status: trade.lifecycle_state, confirmed: true, matchedObligation: true };
  await transitionTrade(ctx, trade, 'FIRST_LEG_CONFIRMED', { extra: { received: Money.ofMinor(totals.received, receivable.currency) } });
  await enqueueOutbox(ctx, { type: 'desk.payout_actionable', aggregateType: 'trade', aggregateId: trade.id, payload: { tradeId: trade.id } });
  return { status: 'FIRST_LEG_CONFIRMED' as const, confirmed: true, matchedObligation: true };
}

/**
 * T4 — `settlement:confirm_incoming` (⧗). The client's funds are final: the movement posts its one journal,
 * the leg completes and the trade becomes payable. A short or excess payment keeps the trade where it is.
 */
export function confirmFirstLeg(actor: OperatorActor, deps: SettlementDeps) {
  return operatorCommand(actor, 'settlement:confirm_incoming', (ctx, p: { legId: string }) => confirmClientLegInTx(ctx, deps, p.legId));
}

/**
 * T3 without an actor policy: the detected transfer turned out to be failed or orphaned, so the leg fails, its
 * evidence link is voided (the transfer never satisfied anything) and the trade goes back to awaiting the client.
 * The scanner reaches this as a system job when a transfer disappears from the chain; an operator reaches it
 * through `revertFirstLeg`.
 */
export async function revertClientLegInTx(ctx: TxContext, legId: string, reason: string): Promise<{ status: 'FAILED' }> {
  const text = requireText(reason, 'reason', 500);
  const id = requireUuid(legId, 'legId');
  const legPeek = await ctx.tx.selectFrom('settlement_leg').select('trade_id').where('id', '=', id).executeTakeFirstOrThrow();
  const trade = await lockTrade(ctx.tx, legPeek.trade_id);
  const leg = await lockLeg(ctx, id);
  if (leg.side !== 'CLIENT_TO_EXCHANGE' || leg.status !== 'PROCESSING') throw new DomainError('INVALID_TRANSITION', `leg ${leg.ref} is ${leg.status}`);
  await ctx.tx.updateTable('settlement_leg').set({ status: 'FAILED', failed_at: sql<Date>`inrp2p_now()`, failure_reason: text }).where('id', '=', leg.id).execute();
  await ctx.tx
    .updateTable('transfer_allocation')
    .set({ voided_at: sql<Date>`inrp2p_now()`, voided_by: ctx.actor.id ?? `SYSTEM:${ctx.commandName}`, void_reason: text })
    .where('settlement_leg_id', '=', leg.id)
    .where('voided_at', 'is', null)
    .execute();
  if (trade.lifecycle_state === 'FIRST_LEG_DETECTED') await transitionTrade(ctx, trade, 'AWAITING_FIRST_LEG', { reason: text });
  await appendAudit(ctx, { action: 'leg.failed', entityType: 'settlement_leg', entityId: leg.id, before: { status: 'PROCESSING' }, after: { status: 'FAILED', reason: text } });
  return { status: 'FAILED' as const };
}

/** T3: a detected transfer turned out to be failed or orphaned — the trade goes back to awaiting the client. */
export function revertFirstLeg(actor: OperatorActor) {
  return operatorCommand(actor, 'settlement:fail_payout', (ctx, p: { legId: string; reason: string }) => revertClientLegInTx(ctx, p.legId, p.reason));
}
