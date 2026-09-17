import { sql } from 'kysely';
import { DomainError, parseTronAddress, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import { isUniqueViolation } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { type OperatorActor, actorLabel, operatorCommand } from '@inrp2p/identity';

export interface RegisterTreasuryWalletPayload {
  readonly network: 'TRON';
  readonly address: string;
  readonly label: string;
  readonly role: 'HOT' | 'COLD' | 'DEPOSIT_POOL';
}

/** `treasury.register_wallet` — `treasury:manage_wallets` (⧗). Watch-only: an address and label, never keys. */
export function registerTreasuryWallet(actor: OperatorActor) {
  return operatorCommand(actor, 'treasury:manage_wallets', async (ctx, p: RegisterTreasuryWalletPayload) => {
    const address = parseTronAddress(typeof p.address === 'string' ? p.address.trim() : '');
    let row;
    try {
      row = await ctx.tx
        .insertInto('treasury_wallet')
        .values({ network: requireOneOf(p.network, 'network', ['TRON'] as const), address, label: requireText(p.label, 'label', 80), role: requireOneOf(p.role, 'role', ['HOT', 'COLD', 'DEPOSIT_POOL'] as const), created_by: actorLabel(ctx) })
        .returning(['id', 'network', 'address', 'label', 'role', 'status', 'custody'])
        .executeTakeFirstOrThrow();
    } catch (e) {
      if (isUniqueViolation(e)) throw new DomainError('INVALID_ARGUMENT', 'wallet address or label already registered');
      throw e;
    }
    await appendAudit(ctx, { action: 'treasury_wallet.registered', entityType: 'treasury_wallet', entityId: row.id, after: row });
    return { walletId: row.id };
  });
}

/** `treasury.set_wallet_status` — `treasury:manage_wallets` (⧗). RETIRED is terminal. */
export function setTreasuryWalletStatus(actor: OperatorActor) {
  return operatorCommand(actor, 'treasury:manage_wallets', async (ctx, p: { walletId: string; status: 'ACTIVE' | 'PAUSED' | 'RETIRED'; reason: string }) => {
    const status = requireOneOf(p.status, 'status', ['ACTIVE', 'PAUSED', 'RETIRED'] as const);
    const reason = requireText(p.reason, 'reason', 500);
    const before = await ctx.tx.selectFrom('treasury_wallet').select(['id', 'status']).where('id', '=', requireUuid(p.walletId, 'walletId')).forUpdate().executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', 'treasury wallet not found');
    if (before.status === status) return { changed: false };
    if (before.status === 'RETIRED') throw new DomainError('INVALID_TRANSITION', 'wallet is retired');
    await ctx.tx.updateTable('treasury_wallet').set({ status, updated_at: sql<Date>`statement_timestamp()` }).where('id', '=', before.id).execute();
    await appendAudit(ctx, { action: 'treasury_wallet.status_changed', entityType: 'treasury_wallet', entityId: before.id, before: { status: before.status }, after: { status, reason } });
    return { changed: true };
  });
}
