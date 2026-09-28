import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import type { Db, TxContext } from '@inrp2p/db';
import { lockTrade } from '@inrp2p/trades';
import { appendAudit } from '@inrp2p/audit';
import { confirmClientLegInTx, confirmRouteSettlementInTx, lockObligation, openExceptionInTx, postMovement, revertClientLegInTx, verifyCryptoTransfer } from '@inrp2p/settlement';
import { type ScannerDeps, scannerPolicyOf } from './policy.ts';
import { systemStep } from './system.ts';

export type ConfirmOutcome =
  /** Final on chain and the client leg completed with it (T4). */
  | 'CLIENT_LEG_CONFIRMED'
  /** Final on chain: USDT a trader route delivered to its order's own address, settled against its obligation. */
  | 'ROUTE_SETTLED'
  /** Final on chain: a trader's Security Reserve deposit, credited to the trader. */
  | 'RESERVE_CREDITED'
  /** Final on chain; a payout leg's evidence is now verified and an operator can confirm it (⧗ stays with the human). */
  | 'VERIFIED'
  /** Final on chain, nobody claimed it: parked in suspense with an open case. */
  | 'SUSPENSE'
  /** The chain says the transaction failed; a client leg attached to it was reverted. */
  | 'FAILED'
  /** Not final yet, or the providers do not agree (D-05). Nothing changes. */
  | 'PENDING'
  | 'SKIPPED';

export interface ConfirmReport {
  readonly examined: number;
  readonly clientLegsConfirmed: number;
  readonly routeSettled: number;
  readonly reserveCredited: number;
  readonly verified: number;
  readonly suspense: number;
  readonly failed: number;
  readonly pending: number;
  readonly notFinalCases: number;
}

interface Candidate {
  readonly id: string;
  readonly aged: boolean;
}

/**
 * `tron_confirm` (Phase 5). Every DETECTED transfer is offered to the chain verifier; only the chain decides
 * (FI-24, D-05). A confirmed client deposit completes its leg through the same code path an operator uses; a
 * confirmed payout transfer is only *verified*, because releasing money to a client stays a step-up operator
 * decision; a confirmed transfer nobody claimed goes to suspense.
 */
export async function runTronConfirm(db: Db, deps: ScannerDeps): Promise<ConfirmReport> {
  const policy = scannerPolicyOf(deps);
  const candidates = await sql<Candidate>`
    select id, (detected_at <= inrp2p_now() - make_interval(mins => ${policy.notFinalAfterMinutes})) as aged
    from crypto_transfer
    where network = 'TRON' and state = 'DETECTED'
    order by detected_at
    limit ${policy.confirmBatch}`.execute(db);

  const report = { examined: 0, clientLegsConfirmed: 0, routeSettled: 0, reserveCredited: 0, verified: 0, suspense: 0, failed: 0, pending: 0, notFinalCases: 0 };
  for (const candidate of candidates.rows) {
    report.examined += 1;
    const step = await systemStep(
      db,
      'chain.transfer_verify',
      { transferId: candidate.id },
      (ctx) => verifyOne(ctx, deps, candidate),
      { financial: true },
    );
    const outcome = step.result;
    if (outcome.outcome === 'CLIENT_LEG_CONFIRMED') report.clientLegsConfirmed += 1;
    else if (outcome.outcome === 'ROUTE_SETTLED') report.routeSettled += 1;
    else if (outcome.outcome === 'RESERVE_CREDITED') report.reserveCredited += 1;
    else if (outcome.outcome === 'VERIFIED') report.verified += 1;
    else if (outcome.outcome === 'SUSPENSE') report.suspense += 1;
    else if (outcome.outcome === 'FAILED') report.failed += 1;
    else if (outcome.outcome === 'PENDING') report.pending += 1;
    if (outcome.caseOpened) report.notFinalCases += 1;
  }
  return report;
}

async function verifyOne(ctx: TxContext, deps: ScannerDeps, candidate: Candidate): Promise<{ outcome: ConfirmOutcome; caseOpened: boolean }> {
  const transfer = await ctx.tx
    .selectFrom('crypto_transfer')
    .select(['id', 'state', 'amount_minor', 'to_address', 'payer_type', 'payer_id', 'payee_type', 'payee_id'])
    .where('id', '=', candidate.id)
    .executeTakeFirst();
  if (!transfer || transfer.state !== 'DETECTED') return { outcome: 'SKIPPED', caseOpened: false };

  // A route settlement that already claims this transfer. When it arrived at that obligation's own delivery
  // address the chain's answer settles it here; one an operator recorded stays theirs to confirm. Either way it is
  // never parked in suspense below — a claimed transfer is not unclaimed money.
  const routeClaim = await ctx.tx
    .selectFrom('transfer_allocation as a')
    .innerJoin('route_settlement as s', 's.id', 'a.route_settlement_id')
    .select(['s.id', 's.status', 's.route_obligation_id'])
    .where('a.crypto_transfer_id', '=', transfer.id)
    .where('a.dimension', '=', 'ROUTE')
    .where('a.voided_at', 'is', null)
    .executeTakeFirst();
  const deliveredToOwnAddress = routeClaim
    ? await ctx.tx
        .selectFrom('deposit_assignment as a')
        .innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
        .select('a.id')
        .where('a.route_obligation_id', '=', routeClaim.route_obligation_id)
        .where('d.address', '=', transfer.to_address)
        .executeTakeFirst()
    : undefined;
  // Lock order: the obligation before the movement the confirmation locks (ARCHITECTURE §4).
  if (routeClaim && deliveredToOwnAddress) await lockObligation(ctx, routeClaim.route_obligation_id);

  const allocation = await ctx.tx
    .selectFrom('transfer_allocation')
    .select('settlement_leg_id')
    .where('crypto_transfer_id', '=', transfer.id)
    .where('dimension', '=', 'CLIENT')
    .where('voided_at', 'is', null)
    .executeTakeFirst();
  const leg = allocation?.settlement_leg_id
    ? await ctx.tx.selectFrom('settlement_leg').select(['id', 'trade_id', 'side', 'status']).where('id', '=', allocation.settlement_leg_id).executeTakeFirst()
    : undefined;
  // Lock order: the trade first, then legs and movements (ARCHITECTURE §4).
  if (leg) await lockTrade(ctx.tx, leg.trade_id);

  const verified = await verifyCryptoTransfer(ctx, deps, transfer.id);
  if (!verified.confirmed) {
    if (verified.code === 'RECEIPT_FAILED') {
      if (leg && leg.side === 'CLIENT_TO_EXCHANGE' && leg.status === 'PROCESSING') {
        await revertClientLegInTx(ctx, leg.id, `the transaction failed on chain: ${verified.reason}`);
      }
      return { outcome: 'FAILED', caseOpened: false };
    }
    // Everything else — not solidified yet, an unreachable or disagreeing provider, no independent quorum for
    // this amount (D-05) — leaves the transfer exactly as it was. The desk hears about it once it has been
    // waiting too long, with the machine-readable reason attached.
    let caseOpened = false;
    if (candidate.aged) {
      const opened = await openExceptionInTx(ctx, {
        type: 'TX_NOT_FINAL',
        subjectType: 'CRYPTO_TRANSFER',
        subjectId: transfer.id,
        tradeId: leg?.trade_id ?? null,
        details: { code: verified.code, reason: verified.reason },
      });
      caseOpened = opened.opened;
    }
    return { outcome: 'PENDING', caseOpened };
  }

  if (leg && leg.side === 'CLIENT_TO_EXCHANGE' && leg.status === 'PROCESSING') {
    await confirmClientLegInTx(ctx, deps, leg.id);
    return { outcome: 'CLIENT_LEG_CONFIRMED', caseOpened: false };
  }
  if (leg && (leg.status === 'FAILED' || leg.status === 'CANCELLED')) {
    // The chain says money moved for a leg the desk had given up on — a payout marked failed that went out after
    // all. Nothing posts on its own (an operator decides what it paid for), but it is never just "verified":
    // treasury moved and the ledger has not, so finance hears about it now.
    const opened = await openExceptionInTx(ctx, {
      type: 'RECONCILIATION_MISMATCH',
      subjectType: 'CRYPTO_TRANSFER',
      subjectId: transfer.id,
      tradeId: leg.trade_id,
      details: { reason: 'CONFIRMED_ON_CHAIN_FOR_CLOSED_LEG', leg_id: leg.id, leg_status: leg.status, amount: Money.ofMinor(transfer.amount_minor, 'USDT').toDecimalString() },
    });
    return { outcome: 'VERIFIED', caseOpened: opened.opened };
  }
  if (leg) return { outcome: 'VERIFIED', caseOpened: false };

  if (routeClaim) {
    if (deliveredToOwnAddress && routeClaim.status === 'RECORDED') {
      await confirmRouteSettlementInTx(ctx, deps, routeClaim.id);
      return { outcome: 'ROUTE_SETTLED', caseOpened: false };
    }
    return { outcome: 'VERIFIED', caseOpened: false };
  }

  // A trader's Security Reserve, attributed by its reserve address and sent from its registered wallet at
  // detection (`recordClientDeposit`): the ledger owes it back to the trader from now on.
  if (transfer.payer_type === 'TRADER' && transfer.payer_id && transfer.payee_type === 'EXCHANGE_TREASURY' && transfer.payee_id) {
    await postMovement(ctx, {
      kind: 'CRYPTO',
      movementId: transfer.id,
      amount: Money.ofMinor(transfer.amount_minor, 'USDT'),
      from: { kind: 'TRADER', traderId: transfer.payer_id },
      to: { kind: 'EXCHANGE_TREASURY', walletId: transfer.payee_id },
      tradeId: null,
      purpose: 'TRADER_RESERVE',
    });
    await appendAudit(ctx, { action: 'trader_reserve.credited', entityType: 'trader_profile', entityId: transfer.payer_id, after: { transfer_id: transfer.id, amount: Money.ofMinor(transfer.amount_minor, 'USDT') } });
    return { outcome: 'RESERVE_CREDITED', caseOpened: false };
  }

  // Nobody claimed it (the detection step already opened the case). Suspense keeps the ledger whole: the
  // treasury grew by real funds that no trade owns yet (FI-27, STATE_MACHINES §5).
  if (transfer.payee_type === 'EXCHANGE_TREASURY' && transfer.payee_id) {
    await postMovement(ctx, {
      kind: 'CRYPTO',
      movementId: transfer.id,
      amount: Money.ofMinor(transfer.amount_minor, 'USDT'),
      from: { kind: 'SUSPENSE' },
      to: { kind: 'EXCHANGE_TREASURY', walletId: transfer.payee_id },
      tradeId: null,
      purpose: 'UNALLOCATED',
    });
    return { outcome: 'SUSPENSE', caseOpened: false };
  }
  return { outcome: 'VERIFIED', caseOpened: false };
}
