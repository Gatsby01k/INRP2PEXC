import type { CurrencyCode } from '@inrp2p/kernel';
import { DomainError, isUuid } from '@inrp2p/kernel';
import type { Executor, LedgerAccountType, TxContext } from '@inrp2p/db';

/** Chart of accounts (FINANCIAL_INVARIANTS §3.2). Every account is per currency. */
export interface AccountRef {
  readonly code: string;
  readonly type: LedgerAccountType;
  readonly currency: CurrencyCode;
}

function sub(prefix: LedgerAccountType, name: string, id: string | null, currency: CurrencyCode): AccountRef {
  if (id !== null && !isUuid(id)) throw new DomainError('INVALID_ARGUMENT', `account subject id must be a uuid: ${id}`);
  return Object.freeze({ code: id ? `${prefix}:${name}:${id}` : `${prefix}:${name}`, type: prefix, currency });
}

export const Accounts = {
  inrSettlement: (inrAccountId: string) => sub('ASSET', 'INR_SETTLEMENT', inrAccountId, 'INR'),
  treasuryUsdt: (walletId: string) => sub('ASSET', 'TREASURY_USDT', walletId, 'USDT'),
  clientReceivable: (clientId: string, currency: CurrencyCode) => sub('ASSET', 'CLIENT_RECEIVABLE', clientId, currency),
  clientPayable: (clientId: string, currency: CurrencyCode) => sub('LIAB', 'CLIENT_PAYABLE', clientId, currency),
  routeReceivable: (routeId: string, currency: CurrencyCode) => sub('ASSET', 'ROUTE_RECEIVABLE', routeId, currency),
  routePayable: (routeId: string, currency: CurrencyCode) => sub('LIAB', 'ROUTE_PAYABLE', routeId, currency),
  routePrefund: (routeId: string, currency: CurrencyCode) => sub('ASSET', 'ROUTE_PREFUND', routeId, currency),
  deferredMargin: () => sub('LIAB', 'DEFERRED_MARGIN', null, 'INR'),
  grossMargin: () => sub('REVENUE', 'GROSS_MARGIN', null, 'INR'),
  fees: (currency: CurrencyCode) => sub('EXPENSE', 'FEES', null, currency),
  suspenseUnallocated: (currency: CurrencyCode) => sub('SUSPENSE', 'UNALLOCATED', null, currency),
} as const;

/** Resolves (creating if needed) ledger account ids. Accounts themselves are append-only. */
export async function resolveAccountIds(ctx: TxContext, refs: readonly AccountRef[]): Promise<Map<string, string>> {
  const unique = new Map<string, AccountRef>();
  for (const r of refs) unique.set(`${r.code}|${r.currency}`, r);
  const values = [...unique.values()];
  if (values.length === 0) return new Map();
  await ctx.tx
    .insertInto('ledger_account')
    .values(values.map((r) => ({ code: r.code, type: r.type, currency: r.currency })))
    .onConflict((oc) => oc.columns(['code', 'currency']).doNothing())
    .execute();
  const rows = await ctx.tx
    .selectFrom('ledger_account')
    .select(['id', 'code', 'currency'])
    .where('code', 'in', values.map((v) => v.code))
    .execute();
  const out = new Map<string, string>();
  for (const row of rows) out.set(`${row.code}|${row.currency}`, row.id);
  for (const key of unique.keys()) if (!out.has(key)) throw new DomainError('INVALID_ARGUMENT', `account not resolved: ${key}`);
  return out;
}

export async function findAccountId(ex: Executor, ref: AccountRef): Promise<string | undefined> {
  const row = await ex.selectFrom('ledger_account').select('id').where('code', '=', ref.code).where('currency', '=', ref.currency).executeTakeFirst();
  return row?.id;
}
