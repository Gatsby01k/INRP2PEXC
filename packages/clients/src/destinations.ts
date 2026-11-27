import { sql } from 'kysely';
import { DomainError, last4, normalizeIfsc, normalizeIndianAccountNumber, parseTronAddress, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import { type Rail, type TxContext, isUniqueViolation } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import type { FieldProtector } from '@inrp2p/adapters';
import { type AuthorizationDecision, type OperatorActor, actorLabel, operatorCommand } from '@inrp2p/identity';
import { type ClientAdminCheck, type ClientDataActor, clientDataCommand } from './authz.ts';
import { requireActiveClient } from './clients.ts';

const RAILS = ['IMPS', 'NEFT', 'RTGS', 'UPI'] as const;

/** AAD context binds a sealed account number to its client, so ciphertext cannot be moved between rows of different clients. */
export const bankAccountSealContext = (clientId: string) => `bank_account.account_number:${clientId}`;
/** HMAC context for duplicate detection (same account number under the same client). */
export const BANK_ACCOUNT_HMAC_CONTEXT = 'bank_account.account_number';

/** How the person adding a destination was confirmed, for its audit record. */
const confirmedBy = (via: AuthorizationDecision | ClientAdminCheck): string => ('confirmedBy' in via ? via.confirmedBy : 'OPERATOR');

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

/**
 * A bank account or wallet something live still depends on is not archived by the client itself — archiving cannot be
 * undone, and the deal it belonged to would be left with nowhere to pay: its buyer shown no account, its clock never
 * started. The desk may still archive one (a compromised account); it then moves the trade's destination itself.
 *
 * - The account or wallet the client's trader account settles with, or has proposed to: changed on Traders first.
 * - The destination of a trade of the client's that is still open: archived once the trade has finished.
 */
async function assertNotInUse(ctx: TxContext, actor: ClientDataActor, kind: 'BANK' | 'WALLET', id: string, clientId: string): Promise<void> {
  if (actor.kind === 'OPERATOR') return;
  const what = kind === 'BANK' ? 'bank account' : 'wallet';
  const trader = await ctx.tx
    .selectFrom('trader_profile')
    .select('ref')
    .where('client_id', '=', clientId)
    .where('status', 'in', ['UNDER_REVIEW', 'APPROVED', 'PAUSED'])
    .where((eb) => (kind === 'BANK' ? eb.or([eb('bank_account_id', '=', id), eb('proposed_bank_account_id', '=', id)]) : eb.or([eb('wallet_id', '=', id), eb('proposed_wallet_id', '=', id)])))
    .executeTakeFirst();
  // ADR 0033: the account or wallet a meeting of the client's runs on, while that deal is live.
  const meeting = await ctx.tx.selectFrom('trader_profile as t').innerJoin('trader_order as o', 'o.trader_id', 't.id').select('o.ref')
    .where('t.client_id', '=', clientId).where('t.status', '=', 'PERSONAL').where('o.status', 'in', ['OFFERED', 'ACCEPTED', 'IN_PROGRESS'])
    .where(kind === 'BANK' ? 't.bank_account_id' : 't.wallet_id', '=', id).executeTakeFirst();
  if (meeting) {
    throw new DomainError('DESTINATION_IN_USE', `A deal of yours with another client runs on this ${what}. It can be archived once that deal is done.`, { field: kind === 'BANK' ? 'bankAccountId' : 'walletId' });
  }
  if (trader) {
    throw new DomainError('DESTINATION_IN_USE', `This is the ${what} your trader account settles with. Register another one on Traders → Settlement details first; this one can be archived once the change has taken effect.`, { field: kind === 'BANK' ? 'bankAccountId' : 'walletId' });
  }
  const open = await sql<{ ref: string }>`
    select t.ref
      from trade t
      cross join lateral inrp2p_trade_payout_destination(t.id) d
     where t.client_id = ${clientId}::uuid and t.lifecycle_state not in ('COMPLETED', 'CANCELLED')
       and ${kind === 'BANK' ? sql`d.bank_account_id` : sql`d.wallet_id`} = ${id}::uuid
     order by t.opened_at limit 1`.execute(ctx.tx);
  const trade = open.rows[0];
  if (trade) {
    throw new DomainError('DESTINATION_IN_USE', `Trade ${trade.ref} is still open and pays to this ${what}. Archive it once the trade has finished.`, { field: kind === 'BANK' ? 'bankAccountId' : 'walletId' });
  }
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
 * `client_bank.add` — operator `client_bank:add` (⧗) or the client's CLIENT_ADMIN with fresh TOTP (D-08); its first
 * account may instead be confirmed by a sign-in by email code in the last ten minutes (ADR 0020).
 * The account number is stored only envelope-encrypted, with last4 and a keyed HMAC (SECURITY §5).
 * All client admins are notified through the outbox (S8).
 */
export function addBankAccount(actor: ClientDataActor, protector: FieldProtector) {
  return clientDataCommand(actor, 'client_bank:add', { stepUp: true, firstDestination: 'BANK_ACCOUNT' }, async (_ctx, p: AddBankAccountPayload) => requireUuid(p.clientId, 'clientId'), async (ctx, p, clientId, via) => {
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
    await appendAudit(ctx, { action: 'client_bank.added', entityType: 'bank_account', entityId: row.id, after: { ...row, added_via: actor.kind, confirmed_by: confirmedBy(via) } });
    await enqueueOutbox(ctx, { type: 'client.destination_added', aggregateType: 'client', aggregateId: clientId, payload: { clientId, destination: 'BANK_ACCOUNT', id: row.id, last4: row.account_last4 } });
    return { bankAccountId: row.id, last4: row.account_last4 };
  });
}

/**
 * `client_bank.archive` — archive-not-edit (S8): a changed destination is a new row, so quotes and trades
 * that captured the old id can detect the change (CLIENT_BANK_CHANGED in later phases).
 */
export function archiveBankAccount(actor: ClientDataActor) {
  return clientDataCommand(actor, 'client_bank:add', { stepUp: true, purpose: 'DESTINATION' }, async (ctx, p: { bankAccountId: string; reason: string }) => clientOfBankAccount(ctx, p.bankAccountId), async (ctx, p, clientId) => {
    const reason = requireText(p.reason, 'reason', 500);
    const before = await ctx.tx.selectFrom('bank_account').select(['id', 'status', 'account_last4', 'bank_name']).where('id', '=', p.bankAccountId).forUpdate().executeTakeFirstOrThrow();
    if (before.status !== 'ACTIVE') throw new DomainError('INVALID_TRANSITION', 'bank account is already archived');
    await assertNotInUse(ctx, actor, 'BANK', before.id, clientId);
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
      .select(['id', 'client_id', 'account_number_enc', 'account_last4', 'status'])
      .where('id', '=', requireUuid(p.bankAccountId, 'bankAccountId'))
      .executeTakeFirst();
    if (!row) throw new DomainError('NOT_FOUND', 'bank account not found');
    // Nothing is ever paid to an archived account, so its number is never needed: it is not opened at all — which also
    // leaves alone values sealed under a key the release no longer holds (D-18: production's test accounts).
    if (row.status === 'ARCHIVED') throw new DomainError('DESTINATION_INVALID', 'an archived bank account is not revealed: nothing is paid to it');
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
 * `client_wallet.add` — operator `client_wallet:manage` (⧗) or the client's CLIENT_ADMIN with fresh TOTP (D-08, S8); its
 * first wallet may instead be confirmed by a sign-in by email code in the last ten minutes (ADR 0020).
 * Same role/step-up policy as bank destinations, under its own permission. Address checksum is validated.
 */
export function addWallet(actor: ClientDataActor) {
  return clientDataCommand(actor, 'client_wallet:manage', { stepUp: true, firstDestination: 'WALLET' }, async (_ctx, p: AddWalletPayload) => requireUuid(p.clientId, 'clientId'), async (ctx, p, clientId, via) => {
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
    await appendAudit(ctx, { action: 'client_wallet.added', entityType: 'crypto_wallet', entityId: row.id, after: { ...row, added_via: actor.kind, confirmed_by: confirmedBy(via) } });
    await enqueueOutbox(ctx, { type: 'client.destination_added', aggregateType: 'client', aggregateId: clientId, payload: { clientId, destination: 'WALLET', id: row.id } });
    return { walletId: row.id };
  });
}

/** `client_wallet.archive` — operator `client_wallet:manage` (⧗) or CLIENT_ADMIN with fresh TOTP. */
export function archiveWallet(actor: ClientDataActor) {
  return clientDataCommand(actor, 'client_wallet:manage', { stepUp: true, purpose: 'DESTINATION' }, async (ctx, p: { walletId: string; reason: string }) => clientOfWallet(ctx, p.walletId), async (ctx, p, clientId) => {
    const reason = requireText(p.reason, 'reason', 500);
    const before = await ctx.tx.selectFrom('crypto_wallet').select(['id', 'status']).where('id', '=', p.walletId).forUpdate().executeTakeFirstOrThrow();
    if (before.status !== 'ACTIVE') throw new DomainError('INVALID_TRANSITION', 'wallet is already archived');
    await assertNotInUse(ctx, actor, 'WALLET', before.id, clientId);
    await ctx.tx.updateTable('crypto_wallet').set({ status: 'ARCHIVED', archived_by: actorLabel(ctx), archived_at: sql<Date>`statement_timestamp()`, archive_reason: reason }).where('id', '=', before.id).execute();
    await appendAudit(ctx, { action: 'client_wallet.archived', entityType: 'crypto_wallet', entityId: before.id, before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED', reason, archived_via: actor.kind } });
    await enqueueOutbox(ctx, { type: 'client.destination_archived', aggregateType: 'client', aggregateId: clientId, payload: { clientId, destination: 'WALLET', id: before.id } });
    return { archived: true };
  });
}
