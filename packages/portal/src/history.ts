import { sql } from 'kysely';
import { Money, Rate } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';
import { clientSafe } from './access.ts';

/**
 * What a client has done with us (UX_FLOWS, Validation/Client "History").
 *
 * Every row is a trade of theirs, with the figures that trade was written with. There is no aggregate across
 * clients here and no figure the desk keeps to itself; a client's history is their own record, which is exactly
 * what makes it worth showing.
 */
export interface HistoryRow {
  readonly ref: string;
  readonly direction: 'SELL_USDT' | 'BUY_USDT';
  readonly status: string;
  readonly base: string;
  readonly inr: string;
  readonly clientRate: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly onHold: boolean;
  /** True once a settlement receipt has been issued for this trade and can be downloaded. */
  readonly receipt: boolean;
  /**
   * Where the trade's money lands for the client, when asked for (`withLanding`): its bank account (name, IFSC, last
   * four) or its wallet (label, address) — the same masked facts the client already sees on Bank & wallets.
   */
  readonly landing?: HistoryLanding | null;
}

export type HistoryLanding =
  | { readonly kind: 'BANK'; readonly bankName: string; readonly ifsc: string; readonly last4: string }
  | { readonly kind: 'WALLET'; readonly label: string; readonly address: string };

export interface HistoryQuery {
  readonly limit?: number;
  /** `open` is everything still in flight; `completed` is the archive. Omitted means both, newest first. */
  readonly filter?: 'open' | 'completed';
  /** Also read where each trade's money lands (one more statement): the Exchange's recent trades show it. */
  readonly withLanding?: boolean;
}

export async function clientHistory(ex: Executor, clientId: string, query: HistoryQuery = {}): Promise<readonly HistoryRow[]> {
  let q = ex
    .selectFrom('trade as t')
    .innerJoin('trade_economics as e', 'e.trade_id', 't.id')
    .select(['t.ref', 't.direction', 't.lifecycle_state', 't.hold', 't.opened_at', 't.completed_at', 't.cancelled_at', 'e.base_minor', 'e.quote_inr_minor', 'e.client_rate_micro'])
    // A trade may hold more than one receipt version, so this asks whether one exists rather than joining to it:
    // a join would return the same trade once per version.
    .select((eb) => eb.exists(eb.selectFrom('receipt').select('receipt.id').whereRef('receipt.trade_id', '=', 't.id')).as('has_receipt'))
    .where('t.client_id', '=', clientId)
    .orderBy('t.opened_at', 'desc')
    // Trades opened in the same instant still have to come back in one stable order.
    .orderBy('t.id', 'desc')
    .limit(Math.min(query.limit ?? 50, 200));
  if (query.filter === 'open') q = q.where('t.lifecycle_state', 'not in', ['COMPLETED', 'CANCELLED']);
  if (query.filter === 'completed') q = q.where('t.lifecycle_state', '=', 'COMPLETED');

  const rows = await q.execute();
  const landing = query.withLanding && rows.length > 0 ? await landingsOf(ex, clientId, rows.map((r) => r.ref)) : null;
  return clientSafe(
    rows.map((r) => ({
      ref: r.ref,
      direction: r.direction,
      status: r.lifecycle_state,
      base: Money.ofMinor(r.base_minor, 'USDT').toDecimalString(),
      inr: Money.ofMinor(r.quote_inr_minor, 'INR').toDecimalString(),
      clientRate: Rate.ofMicro(r.client_rate_micro, 'CLIENT').toDecimalString(),
      openedAt: r.opened_at.toISOString(),
      closedAt: (r.completed_at ?? r.cancelled_at)?.toISOString() ?? null,
      onHold: r.hold,
      receipt: r.has_receipt === true,
      ...(landing ? { landing: landing.get(r.ref) ?? null } : {}),
    })),
  );
}

/** Where each of these trades pays the client: the destination in force now (migration 0028), masked as on Bank & wallets. */
async function landingsOf(ex: Executor, clientId: string, refs: readonly string[]): Promise<Map<string, HistoryLanding>> {
  const r = await sql<{ ref: string; bank_name: string | null; ifsc: string | null; account_last4: string | null; label: string | null; address: string | null }>`
    select t.ref, b.bank_name, b.ifsc, b.account_last4, w.label, w.address
      from trade t
      cross join lateral inrp2p_trade_payout_destination(t.id) d
      left join bank_account b on b.id = d.bank_account_id
      left join crypto_wallet w on w.id = d.wallet_id
     where t.client_id = ${clientId} and t.ref = any(${refs as string[]})`.execute(ex);
  const out = new Map<string, HistoryLanding>();
  for (const x of r.rows) {
    if (x.bank_name && x.ifsc && x.account_last4) out.set(x.ref, { kind: 'BANK', bankName: x.bank_name, ifsc: x.ifsc, last4: x.account_last4 });
    else if (x.address) out.set(x.ref, { kind: 'WALLET', label: x.label ?? 'Wallet', address: x.address });
  }
  return out;
}

export interface HistoryCounts {
  readonly all: number;
  /** Still in flight — the `open` filter. */
  readonly open: number;
  /** Settled — the `completed` filter. Cancelled trades are counted in `all` only, as the filters list them. */
  readonly completed: number;
}

/** How many of the client's trades each filter holds, over all of them rather than the page a list shows. */
export async function historyCounts(ex: Executor, clientId: string): Promise<HistoryCounts> {
  const r = await sql<{ all: number; open: number; completed: number }>`
    select count(*)::int as "all",
           count(*) filter (where lifecycle_state not in ('COMPLETED', 'CANCELLED'))::int as "open",
           count(*) filter (where lifecycle_state = 'COMPLETED')::int as "completed"
    from trade
    where client_id = ${clientId}
  `.execute(ex);
  const row = r.rows[0]!;
  return clientSafe({ all: row.all, open: row.open, completed: row.completed });
}
