import { sql } from 'kysely';
import { Money, formatTrx } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';
import { budgetFigures, networkFeePolicy } from '@inrp2p/network';
import { type PnlPeriod, revenueWallet } from '@inrp2p/settlement';

/**
 * INRP2P's earnings in USDT (block 10, ADR 0020 §2.16): what the period earned — platform fees on desks' own deals, and
 * INRP2P's own margins on the deals its desk routes — where that money is now (still at deal addresses, or swept to the
 * revenue wallet), what the sweeps cost in TRX and what the reclaims brought back, and which desks the fees came from.
 * Every figure is the ledger's or the chain sends' own; nothing is estimated here.
 */
export interface RevenueSweep {
  readonly ref: string;
  readonly address: string;
  readonly amount: string;
  readonly status: string;
  readonly blockedReason: string | null;
  readonly txid: string | null;
  readonly at: string;
  readonly closedAt: string | null;
}

export interface RevenueDesk {
  readonly deskId: string;
  readonly handle: string;
  readonly name: string;
  readonly deals: number;
  readonly volume: string;
  readonly fees: string;
}

export interface RevenueReport {
  readonly period: PnlPeriod;
  readonly earned: { readonly platformFees: string; readonly margins: string; readonly total: string };
  readonly where: {
    /** Earned by completed trades and still at their deal addresses. */
    readonly atAddresses: string;
    readonly addresses: number;
    /** Addresses holding at least the sweep minimum, no trade using them. */
    readonly dueAddresses: number;
    readonly sweptInPeriod: string;
    readonly sweptAllTime: string;
    /** The revenue wallet's balance in the books. */
    readonly inRevenueWallet: string;
  };
  readonly wallet: { readonly label: string; readonly address: string } | null;
  readonly network: {
    readonly sweepCostTrx: string;
    readonly reclaimedTrx: string;
    readonly reclaimedToTradersTrx: string;
    readonly platformAvailableTrx: string;
  };
  readonly policy: { readonly enabled: boolean; readonly minUsdt: string; readonly reclaimMinTrx: string };
  readonly sweeps: readonly RevenueSweep[];
  readonly desks: readonly RevenueDesk[];
}

const usdt = (minor: bigint | string | null | undefined) => Money.ofMinor(BigInt(minor ?? 0), 'USDT').toDecimalString();
const inPeriod = (column: string) => sql.raw(`(${column} AT TIME ZONE 'Asia/Kolkata')::date between `);

export async function revenueReport(ex: Executor, period: PnlPeriod): Promise<RevenueReport> {
  const earned = await sql<{ fees: string; margins: string }>`
    select coalesce(sum(case e.direction when 'CR' then e.amount_minor else -e.amount_minor end) filter (where a.code = 'REVENUE:PLATFORM_FEE'), 0)::text as fees,
           coalesce(sum(case e.direction when 'CR' then e.amount_minor else -e.amount_minor end) filter (where a.code = 'REVENUE:GROSS_MARGIN'), 0)::text as margins
      from ledger_entry e
      join ledger_account a on a.id = e.account_id
      join ledger_journal j on j.id = e.journal_id
     where a.currency = 'USDT' and a.code in ('REVENUE:PLATFORM_FEE', 'REVENUE:GROSS_MARGIN')
       and ${inPeriod('j.posted_at')}${period.from}::date and ${period.to}::date`.execute(ex);

  const fees = await networkFeePolicy(ex);
  const at = await sql<{ address: string; total: string }>`
    select substr(x.location, 6) as address, sum(inrp2p_trade_sweepable(x.trade_id, x.location))::text as total
      from (select distinct s.trade_id, s.location from funding_source s join trade t on t.id = s.trade_id
             where s.asset = 'USDT' and s.location like 'TRON:%' and t.lifecycle_state = 'COMPLETED') x
     group by x.location
    having sum(inrp2p_trade_sweepable(x.trade_id, x.location)) > 0`.execute(ex);
  const free = await sql<{ address: string }>`select address from deposit_address where network = 'TRON' and status <> 'ASSIGNED'`.execute(ex);
  const freeSet = new Set(free.rows.map((r) => r.address));
  const atTotal = at.rows.reduce((t, r) => t + BigInt(r.total), 0n);
  const due = at.rows.filter((r) => freeSet.has(r.address) && BigInt(r.total) >= fees.feeSweepMinUsdtMinor).length;

  const swept = await sql<{ period: string; all: string }>`
    select coalesce(sum(s.amount_minor) filter (where ${inPeriod('s.closed_at')}${period.from}::date and ${period.to}::date), 0)::text as period,
           coalesce(sum(s.amount_minor), 0)::text as all
      from chain_send s where s.purpose = 'FEE_SWEEP' and s.status = 'CONFIRMED'`.execute(ex);
  const wallet = await revenueWallet(ex);
  const book = wallet
    ? (await sql<{ n: string }>`
        select coalesce(sum(case e.direction when 'DR' then e.amount_minor else -e.amount_minor end), 0)::text as n
          from ledger_entry e join ledger_account a on a.id = e.account_id
         where a.code = ${`ASSET:TREASURY_USDT:${wallet.id}`} and a.currency = 'USDT'`.execute(ex)).rows[0]!.n
    : '0';

  const trx = await sql<{ cost: string; reclaimed: string; traders: string }>`
    select coalesce((select -sum(b.amount_sun) from network_budget_entry b
                       join chain_send_attempt a on a.id = b.chain_send_attempt_id
                       join chain_send t on t.id = a.send_id
                       join chain_send p on p.id = t.parent_send_id
                      where b.kind = 'SPENT' and p.purpose = 'FEE_SWEEP'
                        and ${inPeriod('b.created_at')}${period.from}::date and ${period.to}::date), 0)::text as cost,
           coalesce((select sum(b.amount_sun) from network_budget_entry b
                      where b.kind = 'RECLAIM' and ${inPeriod('b.created_at')}${period.from}::date and ${period.to}::date), 0)::text as reclaimed,
           coalesce((select sum(b.amount_sun) from network_budget_entry b
                      where b.kind = 'RECLAIM' and b.trader_id is not null and ${inPeriod('b.created_at')}${period.from}::date and ${period.to}::date), 0)::text as traders`.execute(ex);
  const platform = await budgetFigures(ex, null);

  const sweeps = await sql<{ ref: string; from_address: string; amount_minor: bigint; status: string; blocked_reason: string | null; txid: string | null; created_at: Date; closed_at: Date | null }>`
    select s.ref, s.from_address, s.amount_minor, s.status, s.blocked_reason, s.created_at, s.closed_at,
           (select a.txid from chain_send_attempt a where a.send_id = s.id and a.status in ('SIGNED', 'BROADCAST', 'CONFIRMED') order by a.seq desc limit 1) as txid
      from chain_send s where s.purpose = 'FEE_SWEEP'
     order by s.created_at desc limit 20`.execute(ex);

  const desks = await sql<{ desk_id: string; handle: string; name: string; deals: string; volume: string; fees: string }>`
    select d.id as desk_id, d.handle, d.display_name as name, count(*)::text as deals,
           coalesce(sum(e.base_minor), 0)::text as volume, coalesce(sum(e.platform_fee_base_minor), 0)::text as fees
      from trade t
      join trade_request r on r.id = t.trade_request_id
      join desk d on d.id = r.desk_id
      join trade_economics e on e.trade_id = t.id
     where t.lifecycle_state = 'COMPLETED' and ${inPeriod('t.completed_at')}${period.from}::date and ${period.to}::date
     group by d.id, d.handle, d.display_name
     order by sum(e.platform_fee_base_minor) desc nulls last
     limit 20`.execute(ex);

  const e = earned.rows[0]!;
  return {
    period,
    earned: { platformFees: usdt(e.fees), margins: usdt(e.margins), total: usdt(BigInt(e.fees) + BigInt(e.margins)) },
    where: {
      atAddresses: usdt(atTotal), addresses: at.rows.length, dueAddresses: due,
      sweptInPeriod: usdt(swept.rows[0]!.period), sweptAllTime: usdt(swept.rows[0]!.all), inRevenueWallet: usdt(book),
    },
    wallet: wallet ? { label: wallet.label, address: wallet.address } : null,
    network: {
      sweepCostTrx: formatTrx(BigInt(trx.rows[0]!.cost)), reclaimedTrx: formatTrx(BigInt(trx.rows[0]!.reclaimed)),
      reclaimedToTradersTrx: formatTrx(BigInt(trx.rows[0]!.traders)), platformAvailableTrx: formatTrx(platform.availableSun > 0n ? platform.availableSun : 0n),
    },
    policy: { enabled: fees.feeSweepEnabled, minUsdt: usdt(fees.feeSweepMinUsdtMinor), reclaimMinTrx: formatTrx(fees.trxReclaimMinSun) },
    sweeps: sweeps.rows.map((s) => ({
      ref: s.ref, address: s.from_address, amount: usdt(s.amount_minor), status: s.status, blockedReason: s.blocked_reason, txid: s.txid,
      at: s.created_at.toISOString(), closedAt: s.closed_at?.toISOString() ?? null,
    })),
    desks: desks.rows.map((d) => ({ deskId: d.desk_id, handle: d.handle, name: d.name, deals: Number.parseInt(d.deals, 10), volume: usdt(d.volume), fees: usdt(d.fees) })),
  };
}

/** Addresses holding INRP2P's earnings, most first: where a person can sweep one now. */
export async function earningsByAddress(ex: Executor, limit = 50): Promise<readonly { readonly address: string; readonly earned: string; readonly free: boolean; readonly trades: number }[]> {
  const r = await sql<{ address: string; total: string; trades: string; free: boolean }>`
    select substr(x.location, 6) as address, sum(inrp2p_trade_sweepable(x.trade_id, x.location))::text as total, count(*)::text as trades,
           not exists (select 1 from deposit_address d where d.network = 'TRON' and d.address = substr(x.location, 6) and d.status = 'ASSIGNED') as free
      from (select distinct s.trade_id, s.location from funding_source s join trade t on t.id = s.trade_id
             where s.asset = 'USDT' and s.location like 'TRON:%' and t.lifecycle_state = 'COMPLETED') x
     group by x.location
    having sum(inrp2p_trade_sweepable(x.trade_id, x.location)) > 0
     order by sum(inrp2p_trade_sweepable(x.trade_id, x.location)) desc
     limit ${limit}`.execute(ex);
  return r.rows.map((x) => ({ address: x.address, earned: usdt(x.total), free: x.free, trades: Number.parseInt(x.trades, 10) }));
}
