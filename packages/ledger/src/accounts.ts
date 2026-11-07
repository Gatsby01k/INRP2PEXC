import type { CurrencyCode } from '@inrp2p/kernel';
import { DomainError, isUuid } from '@inrp2p/kernel';
import type { LedgerAccountType, TxContext } from '@inrp2p/db';

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
  treasuryUsdt: (walletId: string) => sub('ASSET', 'TREASURY_USDT', walletId, 'USDT'),
  clientReceivable: (clientId: string, currency: CurrencyCode) => sub('ASSET', 'CLIENT_RECEIVABLE', clientId, currency),
  clientPayable: (clientId: string, currency: CurrencyCode) => sub('LIAB', 'CLIENT_PAYABLE', clientId, currency),
  routeReceivable: (routeId: string, currency: CurrencyCode) => sub('ASSET', 'ROUTE_RECEIVABLE', routeId, currency),
  routePayable: (routeId: string, currency: CurrencyCode) => sub('LIAB', 'ROUTE_PAYABLE', routeId, currency),
  routePrefund: (routeId: string, currency: CurrencyCode) => sub('ASSET', 'ROUTE_PREFUND', routeId, currency),
  /** Margin in INR through the exchange; in USDT on a P2P trade (ADR 0019), where no rupee passes through it. */
  deferredMargin: (currency: CurrencyCode = 'INR') => sub('LIAB', 'DEFERRED_MARGIN', null, currency),
  grossMargin: (currency: CurrencyCode = 'INR') => sub('REVENUE', 'GROSS_MARGIN', null, currency),
  /** INRP2P's explicit fee on a desk's deal (ADR 0020), realized in USDT when the deal completes. */
  platformFee: () => sub('REVENUE', 'PLATFORM_FEE', null, 'USDT'),
  fees: (currency: CurrencyCode) => sub('EXPENSE', 'FEES', null, currency),
  suspenseUnallocated: (currency: CurrencyCode) => sub('SUSPENSE', 'UNALLOCATED', null, currency),
  /** USDT a trader has deposited as its Security Reserve: owed back to the trader, never trading capacity. */
  traderReserve: (traderId: string) => sub('LIAB', 'TRADER_RESERVE', traderId, 'USDT'),
  /**
   * The TRC20 network fees of the exchange's own transfers that a trader's TRX deposit paid and the exchange owes back
   * (ADR 0017): the client paid them inside its price. Never a trade's principal; the TRX budget itself is not in this
   * ledger (it is kept apart, in `network_budget_entry`).
   */
  networkFees: () => sub('EXPENSE', 'NETWORK_FEES', null, 'INR'),
  /**
   * ADR 0022: the USDT of a deal's network allowance once the deal is done, until its network is settled at the
   * providers' actual charges (`network:{trade}:settle`). Carries the trade dimension; settles to zero per trade.
   */
  networkAllowance: () => sub('LIAB', 'NETWORK_ALLOWANCE', null, 'USDT'),
  /**
   * What GasFree charged a deal's own transfers (ADR 0022), recovered at cost from the allowance the deal carried: the
   * counterpart of the network expense each transfer booked, never a margin.
   */
  networkRecovered: () => sub('REVENUE', 'NETWORK_RECOVERED', null, 'USDT'),
  /** The network GasFree charged the exchange's transfers out of their deal addresses, in USDT (ADR 0022). */
  networkFeesUsdt: () => sub('EXPENSE', 'NETWORK_FEES', null, 'USDT'),
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
