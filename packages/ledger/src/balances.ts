import { sql } from 'kysely';
import type { Executor } from '@inrp2p/db';
import type { AccountRef } from './accounts.ts';

export interface BalanceRow {
  code: string;
  currency: string;
  /** DR − CR in minor units. */
  net: bigint;
}

export async function accountBalance(ex: Executor, ref: AccountRef): Promise<bigint> {
  const r = await ex
    .selectFrom('ledger_account_balance')
    .select('dr_minus_cr_minor')
    .where('code', '=', ref.code)
    .where('currency', '=', ref.currency)
    .executeTakeFirst();
  return r ? BigInt(r.dr_minus_cr_minor) : 0n;
}

/** Non-zero balances for all entries carrying a trade dimension. */
export async function tradeBalances(ex: Executor, tradeId: string): Promise<BalanceRow[]> {
  const r = await sql<{ code: string; currency: string; net: bigint }>`
    select a.code, e.currency,
           sum(case e.direction when 'DR' then e.amount_minor else -e.amount_minor end)::bigint as net
    from ledger_entry e join ledger_account a on a.id = e.account_id
    where e.trade_id = ${tradeId}
    group by a.code, e.currency
    having sum(case e.direction when 'DR' then e.amount_minor else -e.amount_minor end) <> 0
    order by a.code, e.currency`.execute(ex);
  return r.rows.map((row) => ({ code: row.code, currency: row.currency, net: BigInt(row.net) }));
}

/** Non-zero balances for all entries carrying a route-obligation dimension (FI-64 input). */
export async function routeObligationBalances(ex: Executor, routeObligationId: string): Promise<BalanceRow[]> {
  const r = await sql<{ code: string; currency: string; net: bigint }>`
    select a.code, e.currency,
           sum(case e.direction when 'DR' then e.amount_minor else -e.amount_minor end)::bigint as net
    from ledger_entry e join ledger_account a on a.id = e.account_id
    where e.route_obligation_id = ${routeObligationId}
    group by a.code, e.currency
    having sum(case e.direction when 'DR' then e.amount_minor else -e.amount_minor end) <> 0
    order by a.code, e.currency`.execute(ex);
  return r.rows.map((row) => ({ code: row.code, currency: row.currency, net: BigInt(row.net) }));
}

/** FI-44: returns currencies whose global DR − CR is non-zero. Must always be empty. */
export async function globalImbalance(ex: Executor): Promise<BalanceRow[]> {
  const rows = await ex.selectFrom('ledger_global_imbalance').selectAll().execute();
  return rows.map((r) => ({ code: '*', currency: r.currency, net: BigInt(r.dr_minus_cr_minor) }));
}
