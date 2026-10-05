import { sql } from 'kysely';
import { DomainError, Money, requireText, requireUuid } from '@inrp2p/kernel';
import type { TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type OperatorActor, authorizeOperator, operatorCommand } from '@inrp2p/identity';
import { reverseJournal, tradeCancelReversal } from '@inrp2p/ledger';
import { releaseReservation, reserveCapacity } from '@inrp2p/inr-accounts';
import { releaseDepositAssignment, releaseTreasuryReservation } from '@inrp2p/treasury';
import { type TradeRow, effectiveObligations, isCounterpartyFunded, legTotals, lockTrade, transitionTrade } from '@inrp2p/trades';
import { openExceptionInTx, resolveExceptionInTx } from './exceptions.ts';
import { assertNoPayoutUnderway, lockLeg, nextLegSeq, requireSourceDepositAddress } from './legs.ts';
import { allocateFunding, inrLocation, settleFunding, tronLocation } from './funding.ts';
import { assertPhysicallyAvailable } from './availability.ts';
import { lockMovement, maskedBankDestination, postMovement, recordFiatTransfer, verifyCryptoTransfer } from './movements.ts';
import { advanceTrade } from './progress.ts';
import { lockObligation, obligationOfTrade } from './obligations.ts';
import type { SettlementDeps } from './policy.ts';

/**
 * Everything a cancelled trade must give back, in one place (T9, T10), in the global lock order: route obligation →
 * legs → capacity day → treasury wallet → deposit address (ARCHITECTURE §4).
 *
 * A client transfer that was detected but never confirmed stops being this trade's evidence: its leg fails and its
 * allocation is voided, so the transfer no longer points at a closed trade. It is not forgotten — the funds may
 * still land — so it becomes a `FUNDS_AFTER_TRADE_CLOSED` case, and when the chain confirms it the scanner parks
 * it in suspense (STATE_MACHINES T9). Left attached to a failed leg it would confirm with no journal and no case.
 */
async function releaseCommitments(ctx: TxContext, trade: TradeRow, reason: string): Promise<void> {
  const obligation = await lockObligation(ctx, (await obligationOfTrade(ctx.tx, trade.id)).id);
  if (obligation.status !== 'OPEN' && obligation.status !== 'CANCELLED') {
    throw new DomainError('ROUTE_OBLIGATION_SETTLED', 'the route obligation already has allocations; cancel through a financial adjustment');
  }

  const detected = await ctx.tx.selectFrom('settlement_leg').select('id').where('trade_id', '=', trade.id).where('side', '=', 'CLIENT_TO_EXCHANGE').where('status', '=', 'PROCESSING').orderBy('id').execute();
  for (const d of detected) {
    const leg = await lockLeg(ctx, d.id);
    await ctx.tx.updateTable('settlement_leg').set({ status: 'FAILED', failed_at: sql<Date>`inrp2p_now()`, failure_reason: 'trade cancelled before confirmation' }).where('id', '=', leg.id).execute();
    const evidence = await ctx.tx
      .updateTable('transfer_allocation')
      .set({ voided_at: sql<Date>`inrp2p_now()`, voided_by: ctx.actor.id ?? `SYSTEM:${ctx.commandName}`, void_reason: `trade cancelled: ${reason}`.slice(0, 500) })
      .where('settlement_leg_id', '=', leg.id)
      .where('voided_at', 'is', null)
      .returning(['transfer_kind', 'fiat_transfer_id', 'crypto_transfer_id', 'amount_minor'])
      .execute();
    for (const e of evidence) {
      await openExceptionInTx(ctx, {
        type: 'FUNDS_AFTER_TRADE_CLOSED',
        subjectType: e.transfer_kind === 'FIAT' ? 'FIAT_TRANSFER' : 'CRYPTO_TRANSFER',
        subjectId: (e.fiat_transfer_id ?? e.crypto_transfer_id)!,
        tradeId: null,
        details: { reason: 'TRADE_CANCELLED_BEFORE_CONFIRMATION', previous_trade_id: trade.id, amount: Money.ofMinor(e.amount_minor, leg.asset).toDecimalString(), leg_ref: leg.ref },
      });
    }
    await appendAudit(ctx, { action: 'leg.failed', entityType: 'settlement_leg', entityId: leg.id, before: { status: 'PROCESSING' }, after: { status: 'FAILED', reason: 'trade cancelled before confirmation' } });
  }
  const pending = await ctx.tx.selectFrom('settlement_leg').select('id').where('trade_id', '=', trade.id).where('status', '=', 'PENDING').orderBy('id').execute();
  for (const l of pending) {
    const leg = await lockLeg(ctx, l.id);
    await ctx.tx.updateTable('settlement_leg').set({ status: 'CANCELLED', cancelled_at: sql<Date>`inrp2p_now()` }).where('id', '=', leg.id).execute();
    await settleFunding(ctx, { kind: leg.side === 'REFUND_TO_CLIENT' ? 'REFUND' : 'CLIENT_PAYOUT', legId: leg.id }, 'RELEASED', 'trade cancelled');
    await appendAudit(ctx, { action: 'leg.cancelled', entityType: 'settlement_leg', entityId: leg.id, before: { status: 'PENDING' }, after: { status: 'CANCELLED', reason: 'trade cancelled' } });
  }

  const reservations = await ctx.tx.selectFrom('capacity_reservation').select('id').where('trade_id', '=', trade.id).where('status', '=', 'ACTIVE').orderBy('id').execute();
  for (const r of reservations) await releaseReservation(ctx, r.id, 'TRADE_CANCELLED');
  await releaseTreasuryReservation(ctx, { tradeId: trade.id, reason: 'TRADE_CANCELLED' });
  const assignment = await ctx.tx.selectFrom('deposit_assignment').select('id').where('trade_id', '=', trade.id).where('released_at', 'is', null).executeTakeFirst();
  if (assignment) await releaseDepositAssignment(ctx, { tradeId: trade.id, reason: 'TRADE_CANCELLED' });
  if (obligation.status === 'OPEN') {
    await ctx.tx.updateTable('route_obligation').set({ status: 'CANCELLED', cancelled_at: sql<Date>`inrp2p_now()` }).where('id', '=', obligation.id).execute();
    await appendAudit(ctx, { action: 'route_obligation.cancelled', entityType: 'route_obligation', entityId: obligation.id, before: { status: obligation.status }, after: { status: 'CANCELLED', trade_id: trade.id } });
  }
}

/**
 * A recorded client INR payment that nobody has confirmed or rejected yet is a claim the bank may still honour. If
 * the trade were cancelled around it, the payment could land with nothing left to attach it to — no trade, no leg,
 * no journal. So a trade is not cancelled while one is open: the desk first confirms it (and then refunds it) or
 * records that it did not arrive (`revertFirstLeg`), which closes the transfer as FAILED.
 */
async function assertNoUnconfirmedIncomingFiat(ctx: TxContext, tradeId: string): Promise<void> {
  const open = await ctx.tx
    .selectFrom('settlement_leg')
    .select('ref')
    .where('trade_id', '=', tradeId)
    .where('side', '=', 'CLIENT_TO_EXCHANGE')
    .where('asset', '=', 'INR')
    .where('status', '=', 'PROCESSING')
    .executeTakeFirst();
  if (open) {
    throw new DomainError('INCOMING_FIAT_UNCONFIRMED', `the client's INR payment ${open.ref} is recorded but not confirmed; confirm it or mark it not received before cancelling`);
  }
}

/**
 * `trade:{t}:cancel` is the exact reversal of the acceptance (FINANCIAL_INVARIANTS §3.3). Every approved adjustment
 * moved the same accounts after it, so each one is reversed too (`adj:{id}:cancel`) — otherwise a cancelled trade
 * would leave a client owing or owed, and a route payable, that nothing will ever settle.
 */
async function reverseTradeJournals(ctx: TxContext, tradeId: string): Promise<void> {
  const posted = await ctx.tx.selectFrom('financial_adjustment').select('id').where('trade_id', '=', tradeId).where('status', '=', 'POSTED').orderBy('approved_at').orderBy('id').execute();
  for (const a of posted) {
    await reverseJournal(ctx, { originalPostingKey: `adj:${a.id}`, postingKey: `adj:${a.id}:cancel`, eventType: 'adjustment.reversed' });
  }
  await reverseJournal(ctx, tradeCancelReversal(tradeId));
}

/**
 * T9 — `trade.cancel`, `trade:cancel` (⧗) with a reason. Allowed only while no client funds are confirmed and no
 * payout is in flight; everything reserved is released and the acceptance journal is reversed exactly (FI-42).
 */
export function cancelTrade(actor: OperatorActor) {
  return operatorCommand(actor, 'trade:cancel', async (ctx, p: { tradeId: string; reason: string; exceptionId?: string | null }) => {
    const reason = requireText(p.reason, 'reason', 500);
    const trade = await lockTrade(ctx.tx, p.tradeId);
    const totals = await legTotals(ctx.tx, trade.id);
    // The reason matters to the operator: confirmed funds need the refund path, not a plain cancel.
    if (totals.received > 0n) throw new DomainError('FUNDS_ALREADY_RECEIVED', 'client funds are confirmed; use refund and cancel');
    if (trade.lifecycle_state !== 'AWAITING_FIRST_LEG' && trade.lifecycle_state !== 'FIRST_LEG_DETECTED') {
      throw new DomainError('INVALID_TRANSITION', `a trade in ${trade.lifecycle_state} cannot be cancelled directly`);
    }
    const livePayout = await ctx.tx
      .selectFrom('settlement_leg')
      .select('id')
      .where('trade_id', '=', trade.id)
      .where('side', '=', 'EXCHANGE_TO_CLIENT')
      .where('status', 'in', ['PROCESSING', 'COMPLETED'])
      .executeTakeFirst();
    if (livePayout) throw new DomainError('PAYOUT_IN_FLIGHT', 'a payout is already sent; resolve it before cancelling');
    await assertNoUnconfirmedIncomingFiat(ctx, trade.id);

    await releaseCommitments(ctx, trade, reason);
    await reverseTradeJournals(ctx, trade.id);
    await transitionTrade(ctx, trade, 'CANCELLED', { reason });
    if (p.exceptionId) await resolveExceptionInTx(ctx, { exceptionId: p.exceptionId, resolution: 'cancel_trade', notes: reason });
    await enqueueOutbox(ctx, { type: 'client.trade_cancelled', aggregateType: 'trade', aggregateId: trade.id, payload: { tradeId: trade.id, clientId: trade.client_id, reason } });
    return { status: 'CANCELLED' as const, ref: trade.ref };
  });
}

/**
 * Creates the refund leg for client funds we already hold — `settlement:create_payout`. The refund is only the
 * plan; paying it out is a second, two-person step (`refund:approve`, SECURITY §4).
 */
export function createRefundLeg(actor: OperatorActor, deps: Pick<SettlementDeps, 'policy'> = {}) {
  return operatorCommand(actor, 'settlement:create_payout', async (ctx, p: { tradeId: string; inrAccountId?: string | null; treasuryWalletId?: string | null; sourceDepositAddressId?: string | null; notes?: string | null }) => {
    const trade = await lockTrade(ctx.tx, p.tradeId);
    if (trade.lifecycle_state === 'COMPLETED' || trade.lifecycle_state === 'CANCELLED') throw new DomainError('INVALID_TRANSITION', `trade is ${trade.lifecycle_state}`);
    const totals = await legTotals(ctx.tx, trade.id);
    if (totals.received === 0n) throw new DomainError('INVALID_TRANSITION', 'there is nothing to refund');
    await assertNoPayoutUnderway(ctx.tx, trade.id);
    // Everything already promised back counts, not only what has left: a planned or in-flight refund is money
    // the client will receive, and a second refund of the same funds would pay them twice (FI-25). The trade lock
    // serializes concurrent requests; the database re-checks the total at commit (IX025, migration 0021).
    const committed = await refundTotal(ctx, trade.id, ['PENDING', 'PROCESSING', 'COMPLETED']);
    const outstanding = totals.received - committed;
    if (outstanding <= 0n) throw new DomainError('REFUND_IN_PROGRESS', 'the client funds are already refunded, or a refund of them is already planned');

    const asset = trade.direction === 'SELL_USDT' ? 'USDT' : 'INR';
    const amount = Money.ofMinor(outstanding, asset);
    const leg = await insertRefundLeg(ctx, deps, trade, amount, p, { kind: 'UNWIND' });
    await appendAudit(ctx, { action: 'leg.created', entityType: 'settlement_leg', entityId: leg.id, after: { ref: leg.ref, side: 'REFUND_TO_CLIENT', refund_kind: 'UNWIND', amount, trade_id: trade.id } });
    return { legId: leg.id, ref: leg.ref, amount: amount.toDecimalString() };
  });
}

interface RefundSource {
  readonly inrAccountId?: string | null;
  readonly treasuryWalletId?: string | null;
  readonly sourceDepositAddressId?: string | null;
  readonly notes?: string | null;
}

/**
 * Inserts a refund leg paid from where the client's money is — an INR account (capacity reserved), the client's
 * deposit address (D-16), or a treasury wallet (legacy) — earmarks the client's own funds for it (FI-74) and, for USDT,
 * checks the chain shows it there (B2).
 */
async function insertRefundLeg(
  ctx: TxContext,
  deps: Pick<SettlementDeps, 'policy'>,
  trade: TradeRow,
  amount: Money,
  p: RefundSource,
  opts: { kind: 'UNWIND' | 'EXCESS'; destinationBankAccountId?: string | null; destinationWalletId?: string | null },
): Promise<{ id: string; ref: string }> {
  const asset = amount.currency as 'INR' | 'USDT';
  let inrAccountId: string | null = null;
  let treasuryWalletId: string | null = null;
  let sourceDepositAddressId: string | null = null;
  let sourceAddress: string | null = null;
  let reservationId: string | null = null;
  if (asset === 'INR') {
    inrAccountId = requireUuid(p.inrAccountId, 'inrAccountId');
    const reserved = await reserveCapacity(ctx, { accountId: inrAccountId, amount: amount as Money<'INR'>, subject: { purpose: 'CLIENT_PAYOUT', tradeId: trade.id } });
    reservationId = reserved.reservationId;
  } else if (p.sourceDepositAddressId) {
    // A refund of a counterparty-funded trade returns the client's own USDT from where it arrived (D-16).
    const source = await requireSourceDepositAddress(ctx, p.sourceDepositAddressId);
    sourceDepositAddressId = source.id;
    sourceAddress = source.address;
    treasuryWalletId = source.treasuryWalletId;
  } else {
    treasuryWalletId = requireUuid(p.treasuryWalletId, 'treasuryWalletId');
    sourceAddress = (await ctx.tx.selectFrom('treasury_wallet').select('address').where('id', '=', treasuryWalletId).executeTakeFirstOrThrow()).address;
  }
  const seq = await nextLegSeq(ctx, trade.id);
  const leg = await ctx.tx
    .insertInto('settlement_leg')
    .values({
      trade_id: trade.id, seq, side: 'REFUND_TO_CLIENT', asset, amount_minor: amount.minor, payer: 'EXCHANGE_ACCOUNT',
      inr_account_id: inrAccountId, treasury_wallet_id: treasuryWalletId, source_deposit_address_id: sourceDepositAddressId, capacity_reservation_id: reservationId,
      destination_bank_account_id: opts.destinationBankAccountId ?? null, destination_wallet_id: opts.destinationWalletId ?? null, refund_kind: opts.kind,
      notes: p.notes ? requireText(p.notes, 'notes', 2000) : null, created_by: ctx.actor.id ?? 'SYSTEM',
    })
    .returning(['id', 'ref'])
    .executeTakeFirstOrThrow();
  if (await isCounterpartyFunded(ctx.tx, trade.id)) {
    // FI-74: a refund gives back the client's own money of this trade — never the counterparty's, never the platform's.
    await allocateFunding(ctx, { tradeId: trade.id, use: { kind: 'REFUND', legId: leg.id }, asset, amount, location: asset === 'INR' ? inrLocation(inrAccountId!) : tronLocation(sourceAddress!) });
  }
  // B2: a USDT refund is planned only against what the chain shows at the address it will leave from.
  if (asset === 'USDT') await assertPhysicallyAvailable(ctx, deps, { address: sourceAddress!, amount, excludeLegId: leg.id });
  return leg;
}

/**
 * `trade.refund_excess` — `settlement:create_payout` (production task D2, TD-19; DOMAIN_MODEL §3 `refund_excess`).
 * Returns an overpayment: at most what arrived beyond the receivable, less any excess already planned or returned, to
 * a verified destination of the client chosen here — a registered sending wallet for USDT, a registered bank account
 * for INR — never simply back to the address the money came from (that may be another exchange's hot wallet). The
 * trade goes on: the payout may proceed while the excess is on its way back, and the trade completes only once the
 * excess is confirmed back (FI-21). Confirmed by someone else, like every refund (`refund_leg.confirm`, ⧗✱). A full
 * unwind (`refund_and_cancel`) is a different thing and is not mixed with this.
 */
export function refundExcess(actor: OperatorActor, deps: Pick<SettlementDeps, 'policy'> = {}) {
  return operatorCommand(actor, 'settlement:create_payout', async (ctx, p: RefundSource & {
    tradeId: string; amount?: string | null; destinationWalletId?: string | null; destinationBankAccountId?: string | null; exceptionId?: string | null;
  }) => {
    const trade = await lockTrade(ctx.tx, p.tradeId);
    if (trade.lifecycle_state === 'COMPLETED' || trade.lifecycle_state === 'CANCELLED') throw new DomainError('INVALID_TRANSITION', `trade is ${trade.lifecycle_state}`);
    const unwind = await ctx.tx.selectFrom('settlement_leg').select('ref').where('trade_id', '=', trade.id).where('side', '=', 'REFUND_TO_CLIENT')
      .where('status', 'in', ['PENDING', 'PROCESSING', 'COMPLETED']).where((eb) => eb.or([eb('refund_kind', 'is', null), eb('refund_kind', '=', 'UNWIND')])).executeTakeFirst();
    if (unwind) throw new DomainError('REFUND_IN_PROGRESS', `refund ${unwind.ref} already returns everything the client sent`);
    const { receivable } = await effectiveObligations(ctx.tx, trade.id);
    const totals = await legTotals(ctx.tx, trade.id);
    const room = totals.received - receivable.minor - totals.excessPlanned;
    if (room <= 0n) throw new DomainError('INVALID_TRANSITION', 'nothing arrived beyond what the trade receives, or it is already on its way back');
    const asset = trade.direction === 'SELL_USDT' ? 'USDT' : 'INR';
    const amount = p.amount ? Money.parse(p.amount, asset) : Money.ofMinor(room, asset);
    if (!amount.isPositive() || amount.minor > room) {
      throw new DomainError('INVALID_AMOUNT', `at most ${Money.ofMinor(room, asset).toDecimalString()} ${asset} can be returned as excess`);
    }
    let destinationWalletId: string | null = null;
    let destinationBankAccountId: string | null = null;
    if (asset === 'USDT') {
      destinationWalletId = requireUuid(p.destinationWalletId, 'destinationWalletId');
      const w = await ctx.tx.selectFrom('crypto_wallet').select(['client_id', 'status', 'purpose']).where('id', '=', destinationWalletId).executeTakeFirst();
      if (!w || w.client_id !== trade.client_id || w.status !== 'ACTIVE' || (w.purpose !== 'SOURCE' && w.purpose !== 'BOTH')) {
        throw new DomainError('DESTINATION_INVALID', 'the excess goes back to an active, verified wallet the client registered as sending from');
      }
    } else {
      destinationBankAccountId = requireUuid(p.destinationBankAccountId, 'destinationBankAccountId');
      const b = await ctx.tx.selectFrom('bank_account').select(['client_id', 'status']).where('id', '=', destinationBankAccountId).executeTakeFirst();
      if (!b || b.client_id !== trade.client_id || b.status !== 'ACTIVE') throw new DomainError('DESTINATION_INVALID', 'the excess goes back to an active, verified account of the client');
    }
    const leg = await insertRefundLeg(ctx, deps, trade, amount, p, { kind: 'EXCESS', destinationWalletId, destinationBankAccountId });
    await appendAudit(ctx, { action: 'leg.created', entityType: 'settlement_leg', entityId: leg.id, after: { ref: leg.ref, side: 'REFUND_TO_CLIENT', refund_kind: 'EXCESS', amount, trade_id: trade.id, destination_wallet_id: destinationWalletId, destination_bank_account_id: destinationBankAccountId } });
    if (p.exceptionId) {
      const c = await ctx.tx.selectFrom('exception_case').select(['trade_id', 'type']).where('id', '=', requireUuid(p.exceptionId, 'exceptionId')).executeTakeFirst();
      if (!c || c.trade_id !== trade.id || c.type !== 'USDT_OVERPAYMENT') throw new DomainError('INVALID_ARGUMENT', 'that case is not an overpayment of this trade');
    }
    // When this returns all of the excess, every open overpayment case of the trade is answered (the detection and the
    // confirmation each raise one); a partial return leaves them open for the rest to be decided.
    if (amount.minor === room) {
      const open = await ctx.tx.selectFrom('exception_case').select('id').where('trade_id', '=', trade.id).where('type', '=', 'USDT_OVERPAYMENT')
        .where('status', 'in', ['OPEN', 'IN_PROGRESS']).orderBy('id').execute();
      for (const c of open) await resolveExceptionInTx(ctx, { exceptionId: c.id, resolution: 'refund_excess', notes: `excess ${amount.toDecimalString()} ${asset} returned through ${leg.ref}` });
    }
    // With the excess planned back, the client's side is settled: the trade moves on to its payout.
    await advanceTrade(ctx, trade.id);
    return { legId: leg.id, ref: leg.ref, amount: amount.toDecimalString() };
  });
}

async function refundTotal(ctx: TxContext, tradeId: string, statuses: readonly ('PENDING' | 'PROCESSING' | 'COMPLETED')[]): Promise<bigint> {
  const r = await ctx.tx
    .selectFrom('settlement_leg')
    .select(({ fn }) => fn.sum<string>('amount_minor').as('total'))
    .where('trade_id', '=', tradeId)
    .where('side', '=', 'REFUND_TO_CLIENT')
    .where('status', 'in', statuses)
    .executeTakeFirst();
  return BigInt(r?.total ?? '0');
}

/**
 * Confirms a refund — `refund:approve` (⧗✱). The approver is never the operator who created the refund, and the
 * movement posts the one journal that returns the client receivable (FINANCIAL_INVARIANTS §3.4).
 */
export function confirmRefundLeg(actor: OperatorActor, deps: SettlementDeps) {
  return operatorCommand(actor, 'refund:approve', async (ctx, p: { legId: string; rail?: 'IMPS' | 'NEFT' | 'RTGS' | 'UPI'; utr?: string; txHash?: string; logIndex?: number }) => {
    const legPeek = await ctx.tx.selectFrom('settlement_leg').select(['trade_id', 'created_by']).where('id', '=', requireUuid(p.legId, 'legId')).executeTakeFirstOrThrow();
    if (legPeek.created_by === (ctx.actor.id ?? 'SYSTEM')) throw new DomainError('SECOND_APPROVER_REQUIRED', 'a refund is approved by a different person than the one who created it');
    const trade = await lockTrade(ctx.tx, legPeek.trade_id);
    const leg = await lockLeg(ctx, p.legId);
    if (leg.side !== 'REFUND_TO_CLIENT') throw new DomainError('INVALID_ARGUMENT', 'this is not a refund leg');
    if (leg.status !== 'PENDING' && leg.status !== 'PROCESSING') throw new DomainError('INVALID_TRANSITION', `leg is ${leg.status}`);
    const excess = leg.refund_kind === 'EXCESS';
    // An unwind and a payout never both pay the client; an excess is money beyond the trade, and the trade goes on.
    if (!excess) await assertNoPayoutUnderway(ctx.tx, trade.id);
    const amount = Money.ofMinor(leg.amount_minor, leg.asset);

    let kind: 'FIAT' | 'CRYPTO';
    let movementId: string;
    if (leg.asset === 'INR') {
      const bank = await ctx.tx.selectFrom('trade_economics').select('bank_account_id').where('trade_id', '=', trade.id).executeTakeFirstOrThrow();
      const destinationMasked = leg.destination_bank_account_id
        ? await maskedBankDestination(ctx.tx, leg.destination_bank_account_id)
        : bank.bank_account_id ? 'client bank account' : 'client account';
      const recorded = await recordFiatTransfer(ctx, {
        rail: p.rail ?? 'IMPS',
        utr: p.utr ?? '',
        amount: amount as Money<'INR'>,
        payerType: 'EXCHANGE_ACCOUNT',
        payerId: leg.inr_account_id!,
        payeeType: 'CLIENT_BANK',
        payeeId: trade.client_id,
        destinationMasked,
      });
      kind = 'FIAT';
      movementId = recorded.transferId;
    } else {
      const { locateTransferLog, recordCryptoTransfer } = await import('./movements.ts');
      // The refund goes back to a wallet the client registered as one it sends from; which one is what the chain
      // says the transaction paid — never "the first row".
      // An excess refund names its wallet when it is planned; it goes there and nowhere else.
      const wallets = leg.destination_wallet_id
        ? await ctx.tx.selectFrom('crypto_wallet').select('address').where('id', '=', leg.destination_wallet_id).where('status', '=', 'ACTIVE').execute()
        : await ctx.tx.selectFrom('crypto_wallet').select('address').where('client_id', '=', trade.client_id).where('status', '=', 'ACTIVE').where('purpose', 'in', ['SOURCE', 'BOTH']).execute();
      if (wallets.length === 0) throw new DomainError('DESTINATION_INVALID', 'the client has no active source wallet to refund to');
      const fromAddress = leg.source_deposit_address_id
        ? (await ctx.tx.selectFrom('deposit_address').select('address').where('id', '=', leg.source_deposit_address_id).executeTakeFirstOrThrow()).address
        : (await ctx.tx.selectFrom('treasury_wallet').select('address').where('id', '=', leg.treasury_wallet_id!).executeTakeFirstOrThrow()).address;
      const located = await locateTransferLog(deps, { txHash: p.txHash ?? '', logIndex: p.logIndex ?? null, from: fromAddress, to: wallets.map((w) => w.address), amountMinor: leg.amount_minor });
      const recorded = await recordCryptoTransfer(ctx, {
        txHash: p.txHash ?? '',
        logIndex: located.logIndex,
        tokenContract: deps.chain.tokenContract,
        fromAddress,
        toAddress: located.toAddress,
        amount: amount as Money<'USDT'>,
        payerType: 'EXCHANGE_TREASURY',
        payerId: leg.treasury_wallet_id,
        payeeType: 'CLIENT_WALLET',
        payeeId: trade.client_id,
        source: 'OPERATOR_SUBMITTED',
      });
      kind = 'CRYPTO';
      movementId = recorded.transferId;
    }
    await ctx.tx
      .insertInto('transfer_allocation')
      .values({
        transfer_kind: kind,
        fiat_transfer_id: kind === 'FIAT' ? movementId : null,
        crypto_transfer_id: kind === 'CRYPTO' ? movementId : null,
        dimension: 'CLIENT',
        settlement_leg_id: leg.id,
        amount_minor: leg.amount_minor,
        allocated_by: ctx.actor.id ?? 'SYSTEM',
      })
      .execute();
    await lockMovement(ctx, kind, movementId);
    if (kind === 'FIAT') {
      await ctx.tx.updateTable('fiat_transfer').set({ status: 'CONFIRMED', confirmed_at: sql<Date>`inrp2p_now()` }).where('id', '=', movementId).execute();
    } else {
      const verified = await verifyCryptoTransfer(ctx, deps, movementId);
      if (!verified.confirmed) throw new DomainError('TRANSFER_NOT_CONFIRMED', verified.reason ?? 'the refund is not final on chain');
    }
    await postMovement(ctx, {
      kind,
      movementId,
      amount,
      from: leg.asset === 'INR' ? { kind: 'EXCHANGE_ACCOUNT', inrAccountId: leg.inr_account_id! } : { kind: 'EXCHANGE_TREASURY', walletId: leg.treasury_wallet_id! },
      to: { kind: 'CLIENT', clientId: trade.client_id },
      tradeId: trade.id,
      purpose: 'REFUND',
    });
    if (leg.status === 'PENDING') await ctx.tx.updateTable('settlement_leg').set({ status: 'PROCESSING', sent_at: sql<Date>`inrp2p_now()` }).where('id', '=', leg.id).execute();
    await ctx.tx.updateTable('settlement_leg').set({ status: 'COMPLETED', confirmed_at: sql<Date>`inrp2p_now()` }).where('id', '=', leg.id).execute();
    await settleFunding(ctx, { kind: 'REFUND', legId: leg.id }, 'CONSUMED', `refund ${leg.ref} confirmed`);
    if (leg.capacity_reservation_id) {
      const { consumeReservation } = await import('@inrp2p/inr-accounts');
      await consumeReservation(ctx, leg.capacity_reservation_id, amount as Money<'INR'>);
    }
    await appendAudit(ctx, { action: 'leg.confirmed', entityType: 'settlement_leg', entityId: leg.id, after: { status: 'COMPLETED', side: 'REFUND_TO_CLIENT', refund_kind: leg.refund_kind ?? 'UNWIND', amount, approved_by: ctx.actor.id } });
    // The last thing a paid-out trade may wait for is its excess coming back (FI-21).
    if (excess) await advanceTrade(ctx, trade.id);
    return { status: 'COMPLETED' as const, amount: amount.toDecimalString() };
  });
}

/**
 * T10 — `exception.resolve(refund_and_cancel)`, initiated by a DEALER and approved by FINANCE through the refund
 * itself. Runs only when every confirmed client rupee or USDT is back with the client and no payout completed.
 */
export function refundAndCancel(actor: OperatorActor) {
  return operatorCommand(actor, 'trade:cancel', async (ctx, p: { tradeId: string; exceptionId?: string | null; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    await authorizeOperator(ctx.tx, actor, 'exception:resolve');
    const trade = await lockTrade(ctx.tx, p.tradeId);
    if (trade.lifecycle_state === 'COMPLETED' || trade.lifecycle_state === 'CANCELLED') throw new DomainError('INVALID_TRANSITION', `trade is ${trade.lifecycle_state}`);
    const totals = await legTotals(ctx.tx, trade.id);
    // A payout already sent may yet reach the client; refunding and cancelling on top of it would pay twice (FI-25).
    await assertNoPayoutUnderway(ctx.tx, trade.id);
    await assertNoUnconfirmedIncomingFiat(ctx, trade.id);
    const refunded = await refundTotal(ctx, trade.id, ['COMPLETED']);
    if (refunded !== totals.received) {
      throw new DomainError('REFUND_INCOMPLETE', `confirmed client funds ${totals.received} are not fully refunded (${refunded})`);
    }
    await releaseCommitments(ctx, trade, reason);
    await reverseTradeJournals(ctx, trade.id);
    await transitionTrade(ctx, trade, 'CANCELLED', { reason, extra: { refunded: refunded.toString() } });
    if (p.exceptionId) await resolveExceptionInTx(ctx, { exceptionId: p.exceptionId, resolution: 'refund_and_cancel', notes: reason });
    await enqueueOutbox(ctx, { type: 'client.trade_cancelled', aggregateType: 'trade', aggregateId: trade.id, payload: { tradeId: trade.id, clientId: trade.client_id, reason } });
    return { status: 'CANCELLED' as const, refunded: refunded.toString() };
  });
}
