import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import type { Db, TxContext } from '@inrp2p/db';
import { lockTrade } from '@inrp2p/trades';
import { confirmClientLegInTx, openExceptionInTx, postMovement, revertClientLegInTx, verifyCryptoTransfer } from '@inrp2p/settlement';
import { type ScannerDeps, scannerPolicyOf } from './policy.ts';
import { systemStep } from './system.ts';

export type ConfirmOutcome =
  /** Final on chain and the client leg completed with it (T4). */
  | 'CLIENT_LEG_CONFIRMED'
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

  const report = { examined: 0, clientLegsConfirmed: 0, verified: 0, suspense: 0, failed: 0, pending: 0, notFinalCases: 0 };
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
    .select(['id', 'state', 'amount_minor', 'payee_type', 'payee_id'])
    .where('id', '=', candidate.id)
    .executeTakeFirst();
  if (!transfer || transfer.state !== 'DETECTED') return { outcome: 'SKIPPED', caseOpened: false };

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
