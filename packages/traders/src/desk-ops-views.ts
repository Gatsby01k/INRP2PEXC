import { sql } from 'kysely';
import { Money, Rate, requireUuid } from '@inrp2p/kernel';
import type { DeskStatus, DirectionValue, Executor } from '@inrp2p/db';
import { currentDeskPrices } from '@inrp2p/trader-core';

/**
 * INRP2P's view of the desks (block 11, ADR 0020 §2.17): every desk with what INRP2P watches — its standing, its
 * business over thirty days, its fees, its open disputes, and what INRP2P has decided about it. For the operator desk
 * (`desks:view`); figures are the books' and the trades' own.
 */
export interface OpsDeskRow {
  readonly deskId: string;
  readonly handle: string;
  readonly name: string;
  readonly status: DeskStatus;
  readonly pageHidden: boolean;
  /** The desk changed its name or words since INRP2P hid its page: there is something to look at again. */
  readonly editedSinceHidden: boolean;
  readonly trader: { readonly id: string; readonly name: string; readonly status: string };
  readonly clients: number;
  readonly openDeals: number;
  readonly completed30d: number;
  readonly volume30d: string;
  readonly fees30d: string;
  readonly openDisputes: number;
  readonly lastDealAt: string | null;
  readonly createdAt: string;
}

interface DeskAggRow {
  id: string; handle: string; display_name: string; status: DeskStatus; page_hidden_at: Date | null; updated_at: Date; created_at: Date;
  trader_id: string; trader_name: string; trader_status: string; clients: number; open_deals: number; completed: number; volume: string; fees: string;
  disputes: number; last_deal: Date | null;
}

const rowOf = (r: DeskAggRow): OpsDeskRow => ({
  deskId: r.id, handle: r.handle, name: r.display_name, status: r.status, pageHidden: r.page_hidden_at !== null,
  editedSinceHidden: r.page_hidden_at !== null && r.updated_at > r.page_hidden_at,
  trader: { id: r.trader_id, name: r.trader_name, status: r.trader_status },
  clients: r.clients, openDeals: r.open_deals, completed30d: r.completed,
  volume30d: Money.ofMinor(BigInt(r.volume), 'USDT').toDecimalString(), fees30d: Money.ofMinor(BigInt(r.fees), 'USDT').toDecimalString(),
  openDisputes: r.disputes, lastDealAt: r.last_deal?.toISOString() ?? null, createdAt: r.created_at.toISOString(),
});

async function deskAggregates(ex: Executor, deskId: string | null): Promise<DeskAggRow[]> {
  const r = await sql<DeskAggRow>`
    select d.id, d.handle, d.display_name, d.status, d.page_hidden_at, d.updated_at, d.created_at,
           tp.id as trader_id, c.display_name as trader_name, tp.status as trader_status,
           (select count(*)::int from desk_client dc where dc.desk_id = d.id and dc.status = 'ACTIVE') as clients,
           (select count(*)::int from trade t join trade_request r on r.id = t.trade_request_id
             where r.desk_id = d.id and t.lifecycle_state not in ('COMPLETED', 'CANCELLED')) as open_deals,
           (select count(*)::int from trade t join trade_request r on r.id = t.trade_request_id
             where r.desk_id = d.id and t.lifecycle_state = 'COMPLETED' and t.completed_at > inrp2p_now() - interval '30 days') as completed,
           (select coalesce(sum(e.base_minor), 0)::text from trade t join trade_request r on r.id = t.trade_request_id join trade_economics e on e.trade_id = t.id
             where r.desk_id = d.id and t.lifecycle_state = 'COMPLETED' and t.completed_at > inrp2p_now() - interval '30 days') as volume,
           (select coalesce(sum(e.platform_fee_base_minor), 0)::text from trade t join trade_request r on r.id = t.trade_request_id join trade_economics e on e.trade_id = t.id
             where r.desk_id = d.id and t.lifecycle_state = 'COMPLETED' and t.completed_at > inrp2p_now() - interval '30 days') as fees,
           (select count(*)::int from p2p_dispute x join trade t on t.id = x.trade_id join trade_request r on r.id = t.trade_request_id
             where r.desk_id = d.id and x.status = 'OPEN') as disputes,
           (select max(t.opened_at) from trade t join trade_request r on r.id = t.trade_request_id where r.desk_id = d.id) as last_deal
      from desk d
      join trader_profile tp on tp.id = d.trader_id
      join client c on c.id = tp.client_id
     where ${deskId === null ? sql`true` : sql`d.id = ${deskId}`}
     order by (d.status = 'SUSPENDED') desc, (d.page_hidden_at is not null) desc, d.created_at desc`.execute(ex);
  return r.rows;
}

/** Every desk, the ones needing INRP2P first (suspended, page hidden). */
export async function opsDesks(ex: Executor): Promise<readonly OpsDeskRow[]> {
  return (await deskAggregates(ex, null)).map(rowOf);
}

export interface OpsDeskDeal {
  readonly tradeRef: string;
  readonly clientName: string;
  readonly direction: DirectionValue;
  readonly usdt: string;
  readonly fee: string;
  readonly state: string;
  readonly disputed: boolean;
  readonly at: string;
}

export interface OpsDeskHistory {
  readonly action: string;
  readonly at: string;
  readonly by: string;
  readonly note: string | null;
}

export interface OpsDesk extends OpsDeskRow {
  readonly about: string | null;
  readonly suspensionReason: string | null;
  readonly suspendedAt: string | null;
  readonly pageHiddenReason: string | null;
  readonly pageHiddenAt: string | null;
  readonly prices: Readonly<Record<DirectionValue, { readonly rate: string; readonly min: string; readonly max: string; readonly offered: boolean; readonly validUntil: string } | null>>;
  readonly team: number;
  readonly deals: readonly OpsDeskDeal[];
  readonly history: readonly OpsDeskHistory[];
}

/** One desk for INRP2P: its profile, prices, latest deals, and every decision about it with the reason given. */
export async function opsDesk(ex: Executor, deskId: string): Promise<OpsDesk | null> {
  const id = requireUuid(deskId, 'deskId');
  const [agg] = await deskAggregates(ex, id);
  if (!agg) return null;
  const d = await ex.selectFrom('desk').select(['about', 'suspension_reason', 'suspended_at', 'page_hidden_reason', 'page_hidden_at']).where('id', '=', id).executeTakeFirstOrThrow();
  const current = await currentDeskPrices(ex, id);
  const priceOf = (dir: DirectionValue) => {
    const p = current[dir];
    return p
      ? { rate: Rate.ofMicro(p.rateMicro, 'CLIENT').toDecimalString(), min: Money.ofMinor(p.minBaseMinor, 'USDT').toDecimalString(), max: Money.ofMinor(p.maxBaseMinor, 'USDT').toDecimalString(), offered: p.offered, validUntil: p.validUntil.toISOString() }
      : null;
  };
  const team = await sql<{ n: number }>`select count(*)::int as n from client_user cu join trader_profile tp on tp.client_id = cu.client_id where tp.id = ${agg.trader_id} and cu.status = 'ACTIVE'`.execute(ex);
  const deals = await sql<{ ref: string; client_name: string; direction: DirectionValue; base_minor: bigint; fee: bigint | null; lifecycle_state: string; opened_at: Date; disputed: boolean }>`
    select t.ref, c.display_name as client_name, t.direction, e.base_minor, e.platform_fee_base_minor as fee, t.lifecycle_state, t.opened_at,
           exists (select 1 from p2p_dispute x where x.trade_id = t.id and x.status = 'OPEN') as disputed
      from trade t join trade_request r on r.id = t.trade_request_id join trade_economics e on e.trade_id = t.id join client c on c.id = t.client_id
     where r.desk_id = ${id}
     order by t.opened_at desc limit 20`.execute(ex);
  const history = await sql<{ action: string; at: Date; by: string | null; after: Record<string, unknown> | null }>`
    select a.action, a.at, coalesce(u.name, u.email, a.actor_id) as by, a.after
      from audit_event a left join auth_user u on u.id::text = a.actor_id
     where a.entity_type = 'desk' and a.entity_id = ${id}
       and a.action in ('desk.opened', 'desk.status_changed', 'desk.suspended', 'desk.resumed', 'desk.page_hidden', 'desk.page_shown', 'desk.renamed', 'desk.updated')
     order by a.seq desc limit 30`.execute(ex);
  const noteOf = (after: Record<string, unknown> | null): string | null => {
    const v = after?.reason ?? after?.note;
    return typeof v === 'string' ? v : null;
  };
  return {
    ...rowOf(agg),
    about: d.about, suspensionReason: d.suspension_reason, suspendedAt: d.suspended_at?.toISOString() ?? null,
    pageHiddenReason: d.page_hidden_reason, pageHiddenAt: d.page_hidden_at?.toISOString() ?? null,
    prices: { SELL_USDT: priceOf('SELL_USDT'), BUY_USDT: priceOf('BUY_USDT') },
    team: team.rows[0]!.n,
    deals: deals.rows.map((x) => ({
      tradeRef: x.ref, clientName: x.client_name, direction: x.direction, usdt: Money.ofMinor(x.base_minor, 'USDT').toDecimalString(),
      fee: Money.ofMinor(x.fee ?? 0n, 'USDT').toDecimalString(), state: x.lifecycle_state, disputed: x.disputed, at: x.opened_at.toISOString(),
    })),
    history: history.rows.map((h) => ({ action: h.action, at: h.at.toISOString(), by: h.by ?? 'system', note: noteOf(h.after) })),
  };
}

export interface OpsDispute {
  readonly ref: string;
  readonly tradeRef: string;
  readonly desk: { readonly handle: string; readonly name: string } | null;
  readonly clientName: string;
  readonly payee: 'CLIENT' | 'TRADER';
  readonly reason: string;
  readonly amount: string;
  readonly buyerAnswered: boolean;
  readonly openedAt: string;
}

/** Every open P2P dispute, oldest first: INRP2P decides each from the payee's bank (ADR 0020 §2.15). */
export async function openDisputes(ex: Executor): Promise<readonly OpsDispute[]> {
  const r = await sql<{ ref: string; trade_ref: string; handle: string | null; desk_name: string | null; client_name: string; payee: 'CLIENT' | 'TRADER'; reason: string; amount_minor: bigint; answered: boolean; created_at: Date }>`
    select x.ref, t.ref as trade_ref, d.handle, d.display_name as desk_name, c.display_name as client_name, x.payee, x.reason,
           l.amount_minor, x.payer_note is not null as answered, x.created_at
      from p2p_dispute x
      join trade t on t.id = x.trade_id
      join trade_request r on r.id = t.trade_request_id
      left join desk d on d.id = r.desk_id
      join client c on c.id = t.client_id
      join settlement_leg l on l.id = x.settlement_leg_id
     where x.status = 'OPEN'
     order by x.created_at`.execute(ex);
  return r.rows.map((x) => ({
    ref: x.ref, tradeRef: x.trade_ref, desk: x.handle ? { handle: x.handle, name: x.desk_name! } : null, clientName: x.client_name, payee: x.payee, reason: x.reason,
    amount: Money.ofMinor(x.amount_minor, 'INR').toDecimalString(), buyerAnswered: x.answered, openedAt: x.created_at.toISOString(),
  }));
}

export interface FeePolicyEntry {
  readonly ownDealBps: number;
  readonly networkDealBps: number;
  readonly reason: string;
  readonly since: string;
  readonly setBy: string;
  readonly approvedBy: string | null;
}

export interface FeeProposalView {
  readonly id: string;
  readonly ownDealBps: number;
  readonly networkDealBps: number;
  readonly reason: string;
  readonly proposedBy: string;
  readonly proposedById: string;
  readonly proposedAt: string;
}

/** The platform's fee now, the change waiting for a decision (if any), and the fees before. */
export async function feePolicyView(ex: Executor): Promise<{ readonly current: FeePolicyEntry; readonly proposal: FeeProposalView | null; readonly history: readonly FeePolicyEntry[] }> {
  const policies = await sql<{ own_deal_bps: number; network_deal_bps: number; reason: string; set_at: Date; set_by: string; approved_by: string | null; setter: string | null; approver: string | null }>`
    select f.own_deal_bps, f.network_deal_bps, f.reason, f.set_at, f.set_by, f.approved_by,
           coalesce(s.name, s.email) as setter, coalesce(a.name, a.email) as approver
      from fee_policy f
      left join auth_user s on s.id::text = f.set_by
      left join auth_user a on a.id::text = f.approved_by
     order by f.set_at desc, f.id desc limit 10`.execute(ex);
  const entry = (p: (typeof policies.rows)[number]): FeePolicyEntry => ({
    ownDealBps: p.own_deal_bps, networkDealBps: p.network_deal_bps, reason: p.reason, since: p.set_at.toISOString(),
    setBy: p.setter ?? p.set_by, approvedBy: p.approved_by ? (p.approver ?? p.approved_by) : null,
  });
  const open = await sql<{ id: string; own_deal_bps: number; network_deal_bps: number; reason: string; proposed_by: string; proposed_at: Date; who: string | null }>`
    select p.id, p.own_deal_bps, p.network_deal_bps, p.reason, p.proposed_by, p.proposed_at, coalesce(u.name, u.email) as who
      from fee_policy_proposal p left join auth_user u on u.id::text = p.proposed_by
     where p.status = 'PROPOSED' limit 1`.execute(ex);
  const o = open.rows[0];
  return {
    current: entry(policies.rows[0]!),
    proposal: o ? { id: o.id, ownDealBps: o.own_deal_bps, networkDealBps: o.network_deal_bps, reason: o.reason, proposedBy: o.who ?? o.proposed_by, proposedById: o.proposed_by, proposedAt: o.proposed_at.toISOString() } : null,
    history: policies.rows.slice(1).map(entry),
  };
}
