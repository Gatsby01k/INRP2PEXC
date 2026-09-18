import { sql } from 'kysely';
import { DomainError, Money, isTronAddress, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import { type Executor, type FiatRail, type TxContext, isUniqueViolation } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { type MovementParty, movementJournal, postJournal } from '@inrp2p/ledger';
import { type SettlementDeps, policyOf } from './policy.ts';

export interface RecordFiatInput {
  readonly rail: FiatRail;
  readonly utr: string;
  readonly amount: Money<'INR'>;
  readonly payerType: 'CLIENT' | 'EXCHANGE_ACCOUNT' | 'ROUTE';
  readonly payerId: string;
  readonly payeeType: 'CLIENT_BANK' | 'EXCHANGE_ACCOUNT' | 'ROUTE';
  readonly payeeId: string;
  readonly destinationMasked: string;
  readonly valueDate?: string | null;
}

/**
 * Records one real INR movement (DOMAIN_MODEL §2.7). The UTR is unique per rail (FI-22), so the same
 * reference can never be recorded twice — not as another leg, not as a route settlement, not on another trade.
 */
export async function recordFiatTransfer(ctx: TxContext, input: RecordFiatInput): Promise<{ transferId: string }> {
  if (input.amount.currency !== 'INR' || !input.amount.isPositive()) throw new DomainError('INVALID_AMOUNT', 'an INR movement must be positive');
  const rail = requireOneOf(input.rail, 'rail', ['IMPS', 'NEFT', 'RTGS', 'UPI'] as const);
  const utr = requireText(input.utr, 'utr', 40);
  if (utr.length < 6) throw new DomainError('INVALID_ARGUMENT', 'utr must be at least 6 characters');
  try {
    const row = await ctx.tx
      .insertInto('fiat_transfer')
      .values({
        rail,
        utr,
        amount_minor: input.amount.minor,
        payer_type: input.payerType,
        payer_id: requireUuid(input.payerId, 'payerId'),
        payee_type: input.payeeType,
        payee_id: requireUuid(input.payeeId, 'payeeId'),
        destination_masked: requireText(input.destinationMasked, 'destinationMasked', 200),
        value_date: input.valueDate ?? null,
        recorded_by: ctx.actor.id ?? `SYSTEM:${ctx.commandName}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, {
      action: 'utr.entered', entityType: 'fiat_transfer', entityId: row.id,
      after: { rail, utr, amount: input.amount, payer: input.payerType, payee: input.payeeType, destination: input.destinationMasked },
    });
    return { transferId: row.id };
  } catch (e) {
    if (isUniqueViolation(e, 'fiat_transfer_rail_utr')) {
      throw new DomainError('DUPLICATE_UTR', `UTR ${utr} is already recorded on ${rail}`, { rail, utr });
    }
    throw e;
  }
}

export async function loadFiatTransfer(ex: Executor, transferId: string) {
  const row = await ex.selectFrom('fiat_transfer').selectAll().where('id', '=', requireUuid(transferId, 'transferId')).executeTakeFirst();
  if (!row) throw new DomainError('NOT_FOUND', 'fiat transfer not found');
  return row;
}

/** Locks a movement row (global lock order: after legs and route settlements, before accounts and wallets). */
export async function lockMovement(ctx: TxContext, kind: 'FIAT' | 'CRYPTO', id: string): Promise<void> {
  const { assertLockOrder } = await import('@inrp2p/db');
  assertLockOrder(ctx.tx, 'movement');
  const table = kind === 'FIAT' ? sql.table('fiat_transfer') : sql.table('crypto_transfer');
  const r = await sql`select 1 from ${table} where id = ${id} for update`.execute(ctx.tx);
  if (r.rows.length === 0) throw new DomainError('NOT_FOUND', 'movement not found');
}

export async function markFiatConfirmed(ctx: TxContext, transferId: string): Promise<void> {
  await ctx.tx.updateTable('fiat_transfer').set({ status: 'CONFIRMED', confirmed_at: sql<Date>`inrp2p_now()` }).where('id', '=', transferId).where('status', '=', 'RECORDED').execute();
}

export async function markFiatFailed(ctx: TxContext, transferId: string, reason: string): Promise<void> {
  await ctx.tx
    .updateTable('fiat_transfer')
    .set({ status: 'FAILED', failed_at: sql<Date>`inrp2p_now()`, failure_reason: requireText(reason, 'reason', 500) })
    .where('id', '=', transferId)
    .where('status', '=', 'RECORDED')
    .execute();
}

export interface RecordCryptoInput {
  readonly txHash: string;
  readonly logIndex: number;
  readonly tokenContract: string;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly amount: Money<'USDT'>;
  readonly payerType: 'CLIENT' | 'EXCHANGE_TREASURY' | 'ROUTE' | 'UNKNOWN';
  readonly payerId?: string | null;
  readonly payeeType: 'CLIENT_WALLET' | 'EXCHANGE_TREASURY' | 'ROUTE' | 'UNKNOWN';
  readonly payeeId?: string | null;
  readonly source: 'SCANNER' | 'OPERATOR_SUBMITTED';
}

/** Records one on-chain transfer event as DETECTED. Unique per (network, tx hash, log index) — FI-23. */
export async function recordCryptoTransfer(ctx: TxContext, input: RecordCryptoInput): Promise<{ transferId: string; existing: boolean }> {
  const txHash = typeof input.txHash === 'string' ? input.txHash.trim().toLowerCase().replace(/^0x/, '') : '';
  if (!/^[0-9a-f]{64}$/.test(txHash)) throw new DomainError('INVALID_ARGUMENT', 'txHash must be 64 hex characters');
  const logIndex = typeof input.logIndex === 'number' && Number.isInteger(input.logIndex) && input.logIndex >= 0 ? input.logIndex : -1;
  if (logIndex < 0) throw new DomainError('INVALID_ARGUMENT', 'logIndex must be a non-negative integer');
  for (const [field, value] of [['tokenContract', input.tokenContract], ['fromAddress', input.fromAddress], ['toAddress', input.toAddress]] as const) {
    if (!isTronAddress(value)) throw new DomainError('INVALID_ADDRESS', `${field} is not a TRON address`);
  }
  const existing = await ctx.tx.selectFrom('crypto_transfer').select('id').where('network', '=', 'TRON').where('tx_hash', '=', txHash).where('log_index', '=', logIndex).executeTakeFirst();
  if (existing) return { transferId: existing.id, existing: true };
  const row = await ctx.tx
    .insertInto('crypto_transfer')
    .values({
      network: 'TRON',
      tx_hash: txHash,
      log_index: logIndex,
      token_contract: input.tokenContract,
      from_address: input.fromAddress,
      to_address: input.toAddress,
      amount_minor: input.amount.minor,
      payer_type: input.payerType,
      payer_id: input.payerId ?? null,
      payee_type: input.payeeType,
      payee_id: input.payeeId ?? null,
      source: input.source,
      created_by: ctx.actor.id ?? `SYSTEM:${ctx.commandName}`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await appendAudit(ctx, {
    action: 'usdt.detected', entityType: 'crypto_transfer', entityId: row.id,
    after: { tx_hash: txHash, log_index: logIndex, to: input.toAddress, amount: input.amount, source: input.source },
  });
  return { transferId: row.id, existing: false };
}

/** Why a transfer did not confirm. Callers branch on the code; the message is for people. */
export type VerificationFailure =
  | 'WRONG_STATE'
  | 'NOT_ON_CHAIN'
  | 'WRONG_CONTRACT'
  | 'DESTINATION_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'RECEIPT_FAILED'
  | 'NOT_SOLIDIFIED'
  | 'INSUFFICIENT_PROVIDER_QUORUM';

export type VerificationResult =
  | { readonly confirmed: true }
  | { readonly confirmed: false; readonly code: VerificationFailure; readonly reason: string };

const notConfirmed = (code: VerificationFailure, reason: string): VerificationResult => ({ confirmed: false, code, reason });

/**
 * FI-24: a transfer becomes CONFIRMED only when the chain says so — solidified block, `SUCCESS` receipt, the
 * configured USDT contract, the expected destination and the recorded amount. Above the D-05 threshold the
 * verifier must speak for at least two **independent** providers. Nothing here trusts the operator who submitted
 * the hash.
 */
export async function verifyCryptoTransfer(ctx: TxContext, deps: SettlementDeps, transferId: string): Promise<VerificationResult> {
  const policy = policyOf(deps);
  const t = await ctx.tx.selectFrom('crypto_transfer').selectAll().where('id', '=', requireUuid(transferId, 'transferId')).executeTakeFirstOrThrow();
  if (t.state === 'CONFIRMED') return { confirmed: true };
  if (t.state !== 'DETECTED') return notConfirmed('WRONG_STATE', `transfer is ${t.state}`);

  const receipt = await deps.chain.lookupTransfer('TRON', t.tx_hash, t.log_index);
  if (!receipt) return notConfirmed('NOT_ON_CHAIN', 'the chain does not know this transfer yet');
  if (receipt.tokenContract !== deps.chain.tokenContract || receipt.tokenContract !== t.token_contract) {
    return notConfirmed('WRONG_CONTRACT', 'the transfer is not a USDT transfer on the configured contract');
  }
  if (receipt.toAddress !== t.to_address) return notConfirmed('DESTINATION_MISMATCH', 'the destination does not match the recorded transfer');
  if (receipt.amountMinor !== t.amount_minor) return notConfirmed('AMOUNT_MISMATCH', 'the on-chain amount does not match the recorded amount');
  if (receipt.receiptStatus !== 'SUCCESS') {
    await ctx.tx.updateTable('crypto_transfer').set({ state: 'FAILED', failed_at: sql<Date>`inrp2p_now()`, receipt_status: 'FAILED', block_number: receipt.blockNumber, block_time: receipt.blockTime }).where('id', '=', t.id).execute();
    await appendAudit(ctx, { action: 'usdt.failed', entityType: 'crypto_transfer', entityId: t.id, before: { state: 'DETECTED' }, after: { state: 'FAILED', receipt_status: 'FAILED' } });
    return notConfirmed('RECEIPT_FAILED', 'the transaction failed on chain');
  }
  if (receipt.blockNumber > receipt.solidifiedBlock) return notConfirmed('NOT_SOLIDIFIED', 'the block is not solidified yet');
  // D-05: at or above the threshold the facts must come from two **independent** sources. The quorum counts
  // independence groups, never provider names: two adapters onto the same vendor or node are one source, so
  // naming them differently can never manufacture a quorum.
  if (t.amount_minor >= Money.parse(policy.dualProviderThresholdUsdt, 'USDT').minor && receipt.agreedGroups.length < 2) {
    return notConfirmed(
      'INSUFFICIENT_PROVIDER_QUORUM',
      `this amount needs two independent providers to agree (D-05); ${receipt.agreedGroups.length} independent source(s) agreed`,
    );
  }

  await ctx.tx
    .updateTable('crypto_transfer')
    .set({
      state: 'CONFIRMED',
      confirmed_at: sql<Date>`inrp2p_now()`,
      receipt_status: 'SUCCESS',
      block_number: receipt.blockNumber,
      block_time: receipt.blockTime,
      solidified_block: receipt.solidifiedBlock,
      verified_by: receipt.agreedBy.join(','),
    })
    .where('id', '=', t.id)
    .execute();
  await appendAudit(ctx, {
    action: 'usdt.confirmed', entityType: 'crypto_transfer', entityId: t.id,
    before: { state: 'DETECTED' },
    after: {
      state: 'CONFIRMED', block_number: receipt.blockNumber.toString(), solidified_block: receipt.solidifiedBlock.toString(),
      verified_by: receipt.agreedBy, independence_groups: receipt.agreedGroups,
    },
  });
  return { confirmed: true };
}

/**
 * T3: the providers no longer know a transfer we had detected — it was in a block that did not survive. Only a
 * transfer that was never final can be orphaned this way; a solidified block is irreversible (FI-24), so a
 * CONFIRMED transfer going missing is a reconciliation case for a human, never an automatic reversal.
 */
export async function markCryptoOrphaned(ctx: TxContext, transferId: string, reason: string): Promise<{ orphaned: boolean }> {
  const t = await ctx.tx.selectFrom('crypto_transfer').select(['id', 'state']).where('id', '=', requireUuid(transferId, 'transferId')).executeTakeFirstOrThrow();
  if (t.state !== 'DETECTED') return { orphaned: false };
  await ctx.tx.updateTable('crypto_transfer').set({ state: 'ORPHANED', failed_at: sql<Date>`inrp2p_now()` }).where('id', '=', t.id).where('state', '=', 'DETECTED').execute();
  await appendAudit(ctx, {
    action: 'usdt.orphaned', entityType: 'crypto_transfer', entityId: t.id,
    before: { state: 'DETECTED' }, after: { state: 'ORPHANED', reason: requireText(reason, 'reason', 500) },
  });
  return { orphaned: true };
}

export interface PostMovementInput {
  readonly kind: 'FIAT' | 'CRYPTO';
  readonly movementId: string;
  readonly amount: Money;
  readonly from: MovementParty;
  readonly to: MovementParty;
  readonly tradeId?: string | null;
  readonly purpose: 'CLIENT_FIRST_LEG' | 'CLIENT_PAYOUT' | 'ROUTE_SETTLEMENT' | 'REFUND' | 'UNALLOCATED';
}

/** The one journal a movement ever posts (FI-27, FI-42). A replay hits the unique posting key. */
export async function postMovement(ctx: TxContext, input: PostMovementInput): Promise<{ postingKey: string }> {
  const journal = movementJournal(input);
  const posted = await postJournal(ctx, journal);
  return { postingKey: posted.postingKey };
}

/** Masked destination snapshot for an INR payout (never the full account number — SECURITY §5). */
export async function maskedBankDestination(ex: Executor, bankAccountId: string): Promise<string> {
  const b = await ex.selectFrom('bank_account').select(['bank_name', 'account_last4', 'ifsc']).where('id', '=', bankAccountId).executeTakeFirstOrThrow();
  return `${b.bank_name} ${b.ifsc} ••••${b.account_last4}`;
}
