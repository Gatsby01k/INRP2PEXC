import { sql } from 'kysely';
import { DomainError, last4, normalizeIfsc, normalizeIndianAccountNumber, parseTronAddress, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import { type Rail, type TxContext, isUniqueViolation } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import type { FieldProtector } from '@inrp2p/adapters';
import { type OperatorActor, actorLabel, operatorCommand } from '@inrp2p/identity';
import { type ClientDataActor, clientDataCommand } from './authz.ts';
import { requireActiveClient } from './clients.ts';

const RAILS = ['IMPS', 'NEFT', 'RTGS', 'UPI'] as const;

/** AAD context binds a sealed account number to its client, so ciphertext cannot be moved between rows of different clients. */
export const bankAccountSealContext = (clientId: string) => `bank_account.account_number:${clientId}`;
/** HMAC context for duplicate detection (same account number under the same client). */
export const BANK_ACCOUNT_HMAC_CONTEXT = 'bank_account.account_number';

async function clientOfBankAccount(ctx: TxContext, id: string): Promise<string> {
  const row = await ctx.tx.selectFrom('bank_account').select('client_id').where('id', '=', requireUuid(id, 'bankAccountId')).executeTakeFirst();
  if (!row) throw new DomainError('NOT_FOUND', 'bank account not found');
  return row.client_id;
}

async function clientOfWallet(ctx: TxContext, id: string): Promise<string> {
  const row = await ctx.tx.selectFrom('crypto_wallet').select('client_id').where('id', '=', requireUuid(id, 'walletId')).executeTakeFirst();
  if (!row) throw new DomainError('NOT_FOUND', 'wallet not found');
  return row.client_id;
}

export interface AddBankAccountPayload {
  readonly clientId: string;
  readonly holderName: string;
  readonly bankName: string;
  readonly ifsc: string;
  readonly accountNumber: string;
  readonly railPreferences?: readonly Rail[];
}

/**
 * `client_bank.add` — operator `client_bank:add` (⧗) or the client's CLIENT_ADMIN with fresh TOTP (D-08).
 * The account number is stored only envelope-encrypted, with last4 and a keyed HMAC (SECURITY §5).
 * All client admins are notified through the outbox (S8).
 */
export function addBankAccount(actor: ClientDataActor, protector: FieldProtector) {
  return clientDataCommand(actor, 'client_bank:add', { stepUp: true }, async (_ctx, p: AddBankAccountPayload) => requireUuid(p.clientId, 'clientId'), async (ctx, p, clientId) => {
    await requireActiveClient(ctx.tx, clientId);
    const accountNumber = normalizeIndianAccountNumber(p.accountNumber);
    const rails = [...new Set((p.railPreferences ?? ['IMPS', 'NEFT', 'RTGS']).map((r) => requireOneOf(r, 'railPreferences', RAILS)))];
    if (rails.length === 0) throw new DomainError('INVALID_ARGUMENT', 'at least one rail is required');
    let row;
    try {
      row = await ctx.tx
        .insertInto('bank_account')
        .values({
          client_id: clientId,
          holder_name: requireText(p.holderName, 'holderName', 140),
          bank_name: requireText(p.bankName, 'bankName', 140),
          ifsc: normalizeIfsc(p.ifsc),
          account_number_enc: await protector.seal(accountNumber, bankAccountSealContext(clientId)),
          account_last4: last4(accountNumber),
          account_hmac: protector.lookupHash(accountNumber, BANK_ACCOUNT_HMAC_CONTEXT),
          rail_preferences: rails,
          created_by: actorLabel(ctx),
        })
        .returning(['id', 'client_id', 'holder_name', 'bank_name', 'ifsc', 'account_last4', 'rail_preferences', 'status'])
        .executeTakeFirstOrThrow();
    } catch (e) {
      if (isUniqueViolation(e, 'bank_account_active_unique')) throw new DomainError('DUPLICATE_DESTINATION', 'this bank account is already active for the client');
      throw e;
    }
    await appendAudit(ctx, { action: 'client_bank.added', entityType: 'bank_account', entityId: row.id, after: { ...row, added_via: actor.kind } });
    await enqueueOutbox(ctx, { type: 'client.destination_added', aggregateType: 'client', aggregateId: clientId, payload: { clientId, destination: 'BANK_ACCOUNT', id: row.id, last4: row.account_last4 } });
    return { bankAccountId: row.id, last4: row.account_last4 };
  });
}

/**
 * `client_bank.archive` — archive-not-edit (S8): a changed destination is a new row, so quotes and trades
 * that captured the old id can detect the change (CLIENT_BANK_CHANGED in later phases).
 */
export function archiveBankAccount(actor: ClientDataActor) {
  return clientDataCommand(actor, 'client_bank:add', { stepUp: true }, async (ctx, p: { bankAccountId: string; reason: string }) => clientOfBankAccount(ctx, p.bankAccountId), async (ctx, p, clientId) => {
    const reason = requireText(p.reason, 'reason', 500);
    const before = await ctx.tx.selectFrom('bank_account').select(['id', 'status', 'account_last4', 'bank_name']).where('id', '=', p.bankAccountId).forUpdate().executeTakeFirstOrThrow();
    if (before.status !== 'ACTIVE') throw new DomainError('INVALID_TRANSITION', 'bank account is already archived');
    await ctx.tx
      .updateTable('bank_account')
      .set({ status: 'ARCHIVED', archived_by: actorLabel(ctx), archived_at: sql<Date>`statement_timestamp()`, archive_reason: reason })
      .where('id', '=', before.id)
      .execute();
    await appendAudit(ctx, { action: 'client_bank.archived', entityType: 'bank_account', entityId: before.id, before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED', reason, account_last4: before.account_last4, archived_via: actor.kind } });
    await enqueueOutbox(ctx, { type: 'client.destination_archived', aggregateType: 'client', aggregateId: clientId, payload: { clientId, destination: 'BANK_ACCOUNT', id: before.id, last4: before.account_last4 } });
    return { archived: true };
  });
}

/**
 * `bank_account.reveal` — `bank_account:reveal` (⧗), audited. Must run without an idempotency key: stored
 * command results would otherwise persist the plaintext.
 */
export function revealBankAccount(actor: OperatorActor, protector: FieldProtector) {
  return operatorCommand(actor, 'bank_account:reveal', async (ctx, p: { bankAccountId: string; purpose: string }) => {
    if (ctx.idempotencyKey) throw new DomainError('INVALID_ARGUMENT', 'bank_account.reveal must not use an idempotency key (the result is sensitive)');
    const purpose = requireText(p.purpose, 'purpose', 300);
    const row = await ctx.tx
      .selectFrom('bank_account')
      .select(['id', 'client_id', 'account_number_enc', 'account_last4'])
      .where('id', '=', requireUuid(p.bankAccountId, 'bankAccountId'))
      .executeTakeFirst();
    if (!row) throw new DomainError('NOT_FOUND', 'bank account not found');
    const accountNumber = await protector.open(row.account_number_enc, bankAccountSealContext(row.client_id));
    await appendAudit(ctx, { action: 'bank_account.revealed', entityType: 'bank_account', entityId: row.id, after: { account_last4: row.account_last4, purpose } });
    return { accountNumber };
  });
}

export interface AddWalletPayload {
  readonly clientId: string;
  readonly network: 'TRON';
  readonly address: string;
  readonly label: string;
  readonly purpose: 'SOURCE' | 'DESTINATION' | 'BOTH';
}

/**
 * `client_wallet.add` — operator `client_wallet:manage` (⧗) or the client's CLIENT_ADMIN with fresh TOTP (D-08, S8).
 * Same role/step-up policy as bank destinations, under its own permission. Address checksum is validated.
 */
export function addWallet(actor: ClientDataActor) {
  return clientDataCommand(actor, 'client_wallet:manage', { stepUp: true }, async (_ctx, p: AddWalletPayload) => requireUuid(p.clientId, 'clientId'), async (ctx, p, clientId) => {
    await requireActiveClient(ctx.tx, clientId);
    const network = requireOneOf(p.network, 'network', ['TRON'] as const);
    const address = parseTronAddress(typeof p.address === 'string' ? p.address.trim() : '');
    let row;
    try {
      row = await ctx.tx
        .insertInto('crypto_wallet')
        .values({ client_id: clientId, network, address, label: requireText(p.label, 'label', 80), purpose: requireOneOf(p.purpose, 'purpose', ['SOURCE', 'DESTINATION', 'BOTH'] as const), created_by: actorLabel(ctx) })
        .returning(['id', 'client_id', 'network', 'address', 'label', 'purpose', 'status'])
        .executeTakeFirstOrThrow();
    } catch (e) {
      if (isUniqueViolation(e, 'crypto_wallet_active_unique')) throw new DomainError('DUPLICATE_DESTINATION', 'this wallet is already active for the client');
      throw e;
    }
    await appendAudit(ctx, { action: 'client_wallet.added', entityType: 'crypto_wallet', entityId: row.id, after: { ...row, added_via: actor.kind } });
    await enqueueOutbox(ctx, { type: 'client.destination_added', aggregateType: 'client', aggregateId: clientId, payload: { clientId, destination: 'WALLET', id: row.id } });
    return { walletId: row.id };
  });
}

/** `client_wallet.archive` — operator `client_wallet:manage` (⧗) or CLIENT_ADMIN with fresh TOTP. */
export function archiveWallet(actor: ClientDataActor) {
  return clientDataCommand(actor, 'client_wallet:manage', { stepUp: true }, async (ctx, p: { walletId: string; reason: string }) => clientOfWallet(ctx, p.walletId), async (ctx, p, clientId) => {
    const reason = requireText(p.reason, 'reason', 500);
    const before = await ctx.tx.selectFrom('crypto_wallet').select(['id', 'status']).where('id', '=', p.walletId).forUpdate().executeTakeFirstOrThrow();
    if (before.status !== 'ACTIVE') throw new DomainError('INVALID_TRANSITION', 'wallet is already archived');
    await ctx.tx.updateTable('crypto_wallet').set({ status: 'ARCHIVED', archived_by: actorLabel(ctx), archived_at: sql<Date>`statement_timestamp()`, archive_reason: reason }).where('id', '=', before.id).execute();
    await appendAudit(ctx, { action: 'client_wallet.archived', entityType: 'crypto_wallet', entityId: before.id, before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED', reason, archived_via: actor.kind } });
    await enqueueOutbox(ctx, { type: 'client.destination_archived', aggregateType: 'client', aggregateId: clientId, payload: { clientId, destination: 'WALLET', id: before.id } });
    return { archived: true };
  });
}
