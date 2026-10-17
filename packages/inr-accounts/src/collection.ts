import { sql } from 'kysely';
import { DomainError, normalizeVpa, optionalText, requireUuid } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import type { FieldProtector } from '@inrp2p/adapters';
import { type OperatorActor, operatorCommand } from '@inrp2p/identity';
import { inrAccountSealContext } from './accounts.ts';

export interface CollectionInstructions {
  readonly reference: string;
  readonly payBy: Date;
  readonly inrAccountId: string;
  readonly beneficiaryName: string;
  readonly bankName: string;
  readonly ifsc: string;
  readonly accountNumber: string;
  readonly accountLast4: string;
  readonly upiVpa: string | null;
  readonly rails: readonly string[];
}

/** What the client pays into, with the account number opened for them. Null for a trade without instructions. */
export async function collectionInstructions(ex: Executor, protector: FieldProtector, tradeId: string): Promise<CollectionInstructions | null> {
  const row = await ex
    .selectFrom('trade_collection as c')
    .innerJoin('inr_settlement_account as a', 'a.id', 'c.inr_account_id')
    .innerJoin('settlement_entity as e', 'e.id', 'a.entity_id')
    .select(['c.reference', 'c.pay_by', 'a.id', 'a.bank_name', 'a.ifsc', 'a.account_number_enc', 'a.account_last4', 'a.upi_vpa', 'a.beneficiary_name', 'a.rails', 'a.entity_id', 'e.legal_name'])
    .where('c.trade_id', '=', tradeId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    reference: row.reference,
    payBy: row.pay_by,
    inrAccountId: row.id,
    beneficiaryName: row.beneficiary_name ?? row.legal_name,
    bankName: row.bank_name,
    ifsc: row.ifsc,
    accountNumber: await protector.open(row.account_number_enc, inrAccountSealContext(row.entity_id)),
    accountLast4: row.account_last4,
    upiVpa: row.upi_vpa,
    rails: row.rails,
  };
}

/**
 * `inr_account.set_collection_details` — `inr_account:manage` (⧗). Who payers pay and the account's UPI ID: what a
 * client sees on a trade's payment screen. Clearing the UPI ID takes the code off the screen.
 */
export function setInrAccountCollectionDetails(actor: OperatorActor) {
  return operatorCommand(actor, 'inr_account:manage', async (ctx, p: { accountId: string; upiVpa?: string | null; beneficiaryName?: string | null }) => {
    const before = await ctx.tx
      .selectFrom('inr_settlement_account')
      .select(['id', 'upi_vpa', 'beneficiary_name', 'version'])
      .where('id', '=', requireUuid(p.accountId, 'accountId'))
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', 'INR account not found');
    const raw = typeof p.upiVpa === 'string' ? p.upiVpa.trim() : '';
    const upiVpa = raw === '' ? null : normalizeVpa(raw);
    if (raw !== '' && !upiVpa) throw new DomainError('INVALID_ARGUMENT', 'upiVpa must be a UPI ID such as name@bank');
    const beneficiaryName = optionalText(p.beneficiaryName, 'beneficiaryName', 140);
    if (before.upi_vpa === upiVpa && before.beneficiary_name === beneficiaryName) return { changed: false };
    await ctx.tx
      .updateTable('inr_settlement_account')
      .set({ upi_vpa: upiVpa, beneficiary_name: beneficiaryName, version: before.version + 1, updated_at: sql<Date>`statement_timestamp()` })
      .where('id', '=', before.id)
      .execute();
    await appendAudit(ctx, {
      action: 'settlement_account.collection_details_changed', entityType: 'inr_settlement_account', entityId: before.id,
      before: { upi_vpa: before.upi_vpa, beneficiary_name: before.beneficiary_name }, after: { upi_vpa: upiVpa, beneficiary_name: beneficiaryName },
    });
    return { changed: true };
  });
}
