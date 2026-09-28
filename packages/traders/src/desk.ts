import { sql } from 'kysely';
import { DomainError, Money, Rate, requireUuid } from '@inrp2p/kernel';
import type { Executor, TraderOrderStatus, TraderSide, TraderStatus } from '@inrp2p/db';
import { obligationRemaining } from '@inrp2p/settlement';
import { standingIssues, type StandingIssue } from './eligibility.ts';
import { traderProgram, type TraderProgram } from '@inrp2p/trader-core';
import { earnings } from './rewards.ts';
import { readBlocks, readStanding } from './standing.ts';

/**
 * What the desk sees of traders. Operator-only (`traders:view`): a trader's rate is a route rate, so these views
 * are limited to the roles that already see route economics, and the web layer never renders them elsewhere.
 */
const usdt = (m: bigint) => Money.ofMinor(m, 'USDT').toDecimalString();
const inr = (m: bigint) => Money.ofMinor(m, 'INR').toDecimalString();
const amountOf = (side: TraderSide, m: bigint | null) => (m === null ? null : side === 'BUY_USDT' ? inr(m) : usdt(m));

export interface DeskProgram {
  readonly defaultRequiredReserve: string | null;
  readonly rewardBps: number | null;
  readonly offerTtlSeconds: number;
  readonly holdTtlSeconds: number;
  readonly autoAssign: boolean;
  readonly collectionAccountId: string | null;
  readonly version: number;
}

const programView = (p: TraderProgram): DeskProgram => ({
  defaultRequiredReserve: p.defaultRequiredReserve?.toDecimalString() ?? null,
  rewardBps: p.rewardBps,
  offerTtlSeconds: p.offerTtlSeconds,
  holdTtlSeconds: p.holdTtlSeconds,
  autoAssign: p.autoAssign,
  collectionAccountId: p.collectionAccountId,
  version: p.version,
});

export interface DeskTraderRow {
  readonly traderId: string;
  readonly ref: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly status: TraderStatus;
  readonly available: boolean;
  readonly assignmentsEnabled: boolean;
  readonly sides: readonly TraderSide[];
  readonly reserveBalance: string;
  readonly reserveRequired: string | null;
  readonly reserveShortfall: string;
  readonly openOrders: number;
  readonly offers: number;
  readonly completedOrders: number;
  readonly unresolved: number;
  readonly issues: readonly StandingIssue[];
  readonly appliedAt: string;
}

/** Every trader, applications first, then those with unresolved orders, then the rest. */
export async function deskTraders(ex: Executor): Promise<{ program: DeskProgram; traders: readonly DeskTraderRow[] }> {
  const rows = await sql<{ id: string; ref: string; client_id: string; display_name: string; status: TraderStatus; available: boolean; assignments_enabled: boolean; offers_buy: boolean; offers_sell: boolean; applied_at: Date; open: string; offers: string; completed: string; unresolved: string }>`
    select t.id, t.ref, t.client_id, c.display_name, t.status, t.available, t.assignments_enabled, t.offers_buy, t.offers_sell, t.applied_at,
           (select count(*) from trader_order o where o.trader_id = t.id and o.status in ('ACCEPTED', 'IN_PROGRESS'))::text as open,
           (select count(*) from trader_order o where o.trader_id = t.id and o.status = 'OFFERED')::text as offers,
           (select count(*) from trader_order o where o.trader_id = t.id and o.status = 'COMPLETED')::text as completed,
           (select count(*) from trader_order o join route_obligation r on r.id = o.route_obligation_id
             where o.trader_id = t.id and o.status = 'IN_PROGRESS' and r.status in ('OPEN', 'PARTIALLY_SETTLED'))::text as unresolved
    from trader_profile t join client c on c.id = t.client_id
    order by (t.status = 'UNDER_REVIEW') desc, t.ref`.execute(ex);
  const traders: DeskTraderRow[] = [];
  for (const r of rows.rows) {
    const { standing, reserve } = await readStanding(ex, r.id);
    traders.push({
      traderId: r.id,
      ref: r.ref,
      clientId: r.client_id,
      clientName: r.display_name,
      status: r.status,
      available: r.available,
      assignmentsEnabled: r.assignments_enabled,
      sides: [...(r.offers_buy ? (['BUY_USDT'] as const) : []), ...(r.offers_sell ? (['SELL_USDT'] as const) : [])],
      reserveBalance: reserve.balance.toDecimalString(),
      reserveRequired: reserve.required?.toDecimalString() ?? null,
      reserveShortfall: reserve.shortfall.toDecimalString(),
      openOrders: Number.parseInt(r.open, 10),
      offers: Number.parseInt(r.offers, 10),
      completedOrders: Number.parseInt(r.completed, 10),
      unresolved: Number.parseInt(r.unresolved, 10),
      issues: r.status === 'UNDER_REVIEW' || r.status === 'REJECTED' ? [] : standingIssues(standing),
      appliedAt: r.applied_at.toISOString(),
    });
  }
  return { program: programView(await traderProgram(ex)), traders };
}

export interface DeskSettlementRow {
  readonly id: string;
  readonly ref: string;
  readonly side: 'ROUTE_DELIVERS' | 'EXCHANGE_DELIVERS';
  readonly asset: 'INR' | 'USDT';
  readonly amount: string;
  readonly status: 'RECORDED' | 'CONFIRMED' | 'FAILED';
  readonly reference: string | null;
  readonly recordedAt: string;
}

export interface DeskOrderRow {
  readonly orderId: string;
  readonly ref: string;
  readonly side: TraderSide;
  readonly status: TraderOrderStatus;
  readonly requestRef: string;
  readonly tradeRef: string | null;
  readonly tradeState: string | null;
  readonly routeObligationId: string | null;
  readonly usdt: string;
  readonly inr: string;
  readonly rate: string;
  readonly offeredAt: string;
  readonly offerExpiresAt: string;
  readonly holdUntil: string | null;
  readonly startedAt: string | null;
  readonly closedAt: string | null;
  readonly closeNote: string | null;
  readonly reward: string | null;
  /** What the trader still owes / what INRP2P still owes the trader, per side of the obligation. */
  readonly traderOwes: string | null;
  readonly inrp2pOwes: string | null;
  readonly settlements: readonly DeskSettlementRow[];
  readonly deliveryAddress: string | null;
}

async function deskOrderRows(ex: Executor, where: { traderId?: string; requestId?: string }, limit: number): Promise<DeskOrderRow[]> {
  let q = ex
    .selectFrom('trader_order as o')
    .innerJoin('trade_request as rq', 'rq.id', 'o.trade_request_id')
    .leftJoin('trade as t', 't.id', 'o.trade_id')
    .select([
      'o.id', 'o.ref', 'o.side', 'o.status', 'rq.ref as request_ref', 't.ref as trade_ref', 't.lifecycle_state', 'o.route_obligation_id', 'o.base_minor', 'o.inr_minor', 'o.rate_micro',
      'o.offered_at', 'o.offer_expires_at', 'o.hold_until', 'o.started_at', 'o.closed_at', 'o.close_reason', 'o.reward_inr_minor',
    ])
    .orderBy('o.offered_at', 'desc')
    .limit(limit);
  if (where.traderId) q = q.where('o.trader_id', '=', where.traderId);
  if (where.requestId) q = q.where('o.trade_request_id', '=', where.requestId);
  const rows = await q.execute();
  const out: DeskOrderRow[] = [];
  for (const o of rows) {
    let traderOwes: string | null = null;
    let inrp2pOwes: string | null = null;
    let settlements: DeskSettlementRow[] = [];
    let deliveryAddress: string | null = null;
    if (o.route_obligation_id) {
      const remaining = await obligationRemaining(ex, o.route_obligation_id);
      traderOwes = remaining.routeDelivers.isZero() ? null : remaining.routeDelivers.toDecimalString();
      inrp2pOwes = remaining.exchangeDelivers.isZero() ? null : remaining.exchangeDelivers.toDecimalString();
      const s = await ex
        .selectFrom('route_settlement as s')
        .leftJoin('fiat_transfer as f', 'f.id', 's.fiat_transfer_id')
        .leftJoin('crypto_transfer as c', 'c.id', 's.crypto_transfer_id')
        .select(['s.id', 's.ref', 's.obligation_side', 's.asset', 's.amount_minor', 's.status', 's.recorded_at', 'f.utr', 'c.tx_hash'])
        .where('s.route_obligation_id', '=', o.route_obligation_id)
        .orderBy('s.recorded_at')
        .execute();
      settlements = s.map((x) => ({ id: x.id, ref: x.ref, side: x.obligation_side, asset: x.asset, amount: Money.ofMinor(x.amount_minor, x.asset).toDecimalString(), status: x.status, reference: x.utr ?? x.tx_hash ?? null, recordedAt: x.recorded_at.toISOString() }));
      const d = await ex
        .selectFrom('deposit_assignment as a')
        .innerJoin('deposit_address as da', 'da.id', 'a.deposit_address_id')
        .select('da.address')
        .where('a.route_obligation_id', '=', o.route_obligation_id)
        .executeTakeFirst();
      deliveryAddress = d?.address ?? null;
    }
    out.push({
      orderId: o.id,
      ref: o.ref,
      side: o.side,
      status: o.status,
      requestRef: o.request_ref,
      tradeRef: o.trade_ref,
      tradeState: o.lifecycle_state,
      routeObligationId: o.route_obligation_id,
      usdt: usdt(o.base_minor),
      inr: inr(o.inr_minor),
      rate: Rate.ofMicro(o.rate_micro, 'ROUTE').toDecimalString(),
      offeredAt: o.offered_at.toISOString(),
      offerExpiresAt: o.offer_expires_at.toISOString(),
      holdUntil: o.hold_until?.toISOString() ?? null,
      startedAt: o.started_at?.toISOString() ?? null,
      closedAt: o.closed_at?.toISOString() ?? null,
      closeNote: o.close_reason,
      reward: o.reward_inr_minor === null ? null : inr(o.reward_inr_minor),
      traderOwes,
      inrp2pOwes,
      settlements,
      deliveryAddress,
    });
  }
  return out;
}

export interface DeskTraderDetail {
  readonly program: DeskProgram;
  readonly trader: DeskTraderRow & {
    readonly typicalInr: string | null;
    readonly typicalUsdt: string | null;
    readonly reviewNote: string | null;
    readonly reviewedAt: string | null;
    readonly controlNote: string | null;
    readonly rewardBps: number | null;
    readonly limits: { readonly maxOrderInr: string | null; readonly maxOrderUsdt: string | null; readonly maxCapacityInr: string | null; readonly maxCapacityUsdt: string | null };
  };
  readonly bank: { readonly bankAccountId: string; readonly bankName: string; readonly holderName: string; readonly ifsc: string; readonly last4: string; readonly status: string };
  readonly wallet: { readonly walletId: string; readonly address: string; readonly label: string; readonly purpose: string; readonly status: string };
  readonly clientDestinations: { readonly banks: readonly { id: string; label: string }[]; readonly wallets: readonly { id: string; label: string }[] };
  readonly blocks: readonly { side: TraderSide; status: string; rate: string | null; capacity: string; held: string; minOrder: string | null; maxOrder: string | null }[];
  readonly reserve: { readonly balance: string; readonly required: string | null; readonly locked: string; readonly available: string; readonly pendingRelease: string; readonly shortfall: string; readonly depositAddress: string | null };
  readonly withdrawals: readonly { withdrawalId: string; ref: string; amount: string; status: string; destination: string; requestedAt: string; txHash: string | null; closeReason: string | null }[];
  readonly earnings: { readonly rewardBps: number | null; readonly available: string; readonly payingOut: string; readonly pending: string; readonly paidOut: string; readonly completedUsdt: string; readonly completedInr: string };
  readonly payouts: readonly { payoutId: string; ref: string; amount: string; status: string; utr: string; recordedAt: string }[];
  readonly orders: readonly DeskOrderRow[];
  readonly decisions: readonly { at: string; action: string; actor: string | null; detail: string }[];
}

/** One trader, with everything the desk may need to decide about it — and the record of what was decided. */
export async function deskTrader(ex: Executor, traderId: string): Promise<DeskTraderDetail> {
  const id = requireUuid(traderId, 'traderId');
  const list = await deskTraders(ex);
  const row = list.traders.find((t) => t.traderId === id);
  if (!row) throw new DomainError('NOT_FOUND', 'trader not found');
  const p = await ex.selectFrom('trader_profile').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const bank = await ex.selectFrom('bank_account').select(['id', 'bank_name', 'holder_name', 'ifsc', 'account_last4', 'status']).where('id', '=', p.bank_account_id).executeTakeFirstOrThrow();
  const wallet = await ex.selectFrom('crypto_wallet').select(['id', 'address', 'label', 'purpose', 'status']).where('id', '=', p.wallet_id).executeTakeFirstOrThrow();
  const banks = await ex.selectFrom('bank_account').select(['id', 'bank_name', 'account_last4']).where('client_id', '=', p.client_id).where('status', '=', 'ACTIVE').execute();
  const wallets = await ex.selectFrom('crypto_wallet').select(['id', 'label', 'address', 'purpose']).where('client_id', '=', p.client_id).where('status', '=', 'ACTIVE').where('purpose', '=', 'BOTH').execute();
  const blocks = await readBlocks(ex, id);
  const { reserve } = await readStanding(ex, id);
  const address = await ex
    .selectFrom('deposit_assignment as a')
    .innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
    .select('d.address')
    .where('a.trader_id', '=', id)
    .where('a.released_at', 'is', null)
    .executeTakeFirst();
  const withdrawals = await ex
    .selectFrom('trader_reserve_withdrawal as w')
    .leftJoin('crypto_transfer as c', 'c.id', 'w.crypto_transfer_id')
    .select(['w.id', 'w.ref', 'w.amount_minor', 'w.status', 'w.destination_address', 'w.requested_at', 'c.tx_hash', 'w.close_reason'])
    .where('w.trader_id', '=', id)
    .orderBy('w.requested_at', 'desc')
    .limit(50)
    .execute();
  const e = await earnings(ex, id);
  const payouts = await ex
    .selectFrom('trader_reward_payout as r')
    .innerJoin('fiat_transfer as f', 'f.id', 'r.fiat_transfer_id')
    .select(['r.id', 'r.ref', 'r.amount_minor', 'r.status', 'f.utr', 'r.recorded_at'])
    .where('r.trader_id', '=', id)
    .orderBy('r.recorded_at', 'desc')
    .limit(50)
    .execute();
  const decisions = await ex
    .selectFrom('audit_event')
    .select(['at', 'action', 'actor_id', 'after'])
    .where('entity_type', '=', 'trader_profile')
    .where('entity_id', '=', id)
    .orderBy('seq', 'desc')
    .limit(50)
    .execute();

  return {
    program: list.program,
    trader: {
      ...row,
      typicalInr: p.typical_inr_minor === null ? null : inr(p.typical_inr_minor),
      typicalUsdt: p.typical_usdt_minor === null ? null : usdt(p.typical_usdt_minor),
      reviewNote: p.review_note,
      reviewedAt: p.reviewed_at?.toISOString() ?? null,
      controlNote: p.control_note,
      rewardBps: p.reward_bps,
      limits: {
        maxOrderInr: p.max_order_inr_minor === null ? null : inr(p.max_order_inr_minor),
        maxOrderUsdt: p.max_order_usdt_minor === null ? null : usdt(p.max_order_usdt_minor),
        maxCapacityInr: p.max_capacity_inr_minor === null ? null : inr(p.max_capacity_inr_minor),
        maxCapacityUsdt: p.max_capacity_usdt_minor === null ? null : usdt(p.max_capacity_usdt_minor),
      },
    },
    bank: { bankAccountId: bank.id, bankName: bank.bank_name, holderName: bank.holder_name, ifsc: bank.ifsc, last4: bank.account_last4, status: bank.status },
    wallet: { walletId: wallet.id, address: wallet.address, label: wallet.label, purpose: wallet.purpose, status: wallet.status },
    clientDestinations: {
      banks: banks.map((b) => ({ id: b.id, label: `${b.bank_name} ••••${b.account_last4}` })),
      wallets: wallets.map((w) => ({ id: w.id, label: `${w.label} · ${w.address.slice(0, 4)}…${w.address.slice(-4)}` })),
    },
    blocks: blocks.map((b) => ({
      side: b.side,
      status: b.status,
      rate: b.rateMicro === null ? null : Rate.ofMicro(b.rateMicro, 'ROUTE').toDecimalString(),
      capacity: amountOf(b.side, b.capacityMinor)!,
      held: amountOf(b.side, b.reservedMinor)!,
      minOrder: amountOf(b.side, b.minOrderMinor),
      maxOrder: amountOf(b.side, b.maxOrderMinor),
    })),
    reserve: {
      balance: reserve.balance.toDecimalString(),
      required: reserve.required?.toDecimalString() ?? null,
      locked: reserve.locked.toDecimalString(),
      available: reserve.available.toDecimalString(),
      pendingRelease: reserve.pendingRelease.toDecimalString(),
      shortfall: reserve.shortfall.toDecimalString(),
      depositAddress: address?.address ?? null,
    },
    withdrawals: withdrawals.map((w) => ({ withdrawalId: w.id, ref: w.ref, amount: usdt(w.amount_minor), status: w.status, destination: w.destination_address, requestedAt: w.requested_at.toISOString(), txHash: w.tx_hash, closeReason: w.close_reason })),
    earnings: {
      rewardBps: e.rewardBps,
      available: e.available.toDecimalString(),
      payingOut: e.payingOut.toDecimalString(),
      pending: e.pending.toDecimalString(),
      paidOut: e.paidOut.toDecimalString(),
      completedUsdt: e.completedUsdt.toDecimalString(),
      completedInr: e.completedInr.toDecimalString(),
    },
    payouts: payouts.map((r) => ({ payoutId: r.id, ref: r.ref, amount: inr(r.amount_minor), status: r.status, utr: r.utr, recordedAt: r.recorded_at.toISOString() })),
    orders: await deskOrderRows(ex, { traderId: id }, 100),
    decisions: decisions.map((d) => ({ at: d.at.toISOString(), action: d.action, actor: d.actor_id, detail: summarizeAudit(d.after) })),
  };
}

function summarizeAudit(after: unknown): string {
  if (!after || typeof after !== 'object') return '';
  const a = after as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['status', 'available', 'assignments_enabled', 'reason', 'note', 'required_reserve', 'reward_bps']) {
    const v = a[key];
    if (v === undefined || v === null) continue;
    parts.push(`${key.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  }
  return parts.join(' · ');
}

/** The trader side of one request, for the desk's quote panel: its live order, and what came before it. */
export async function requestTraderOrders(ex: Executor, requestId: string): Promise<{ live: DeskOrderRow | null; history: readonly DeskOrderRow[]; traderRefs: Readonly<Record<string, string>> }> {
  const rows = await deskOrderRows(ex, { requestId: requireUuid(requestId, 'requestId') }, 20);
  const refs = await sql<{ order_id: string; ref: string }>`
    select o.id as order_id, t.ref from trader_order o join trader_profile t on t.id = o.trader_id where o.trade_request_id = ${requestId}`.execute(ex);
  return {
    live: rows.find((r) => r.status === 'OFFERED' || r.status === 'ACCEPTED' || r.status === 'IN_PROGRESS') ?? null,
    history: rows,
    traderRefs: Object.fromEntries(refs.rows.map((r) => [r.order_id, r.ref])),
  };
}

/** ACTIVE accounts that accept collections — where the programme may tell traders to pay INR. */
export async function collectionAccounts(ex: Executor): Promise<readonly { accountId: string; label: string; bankName: string; last4: string }[]> {
  const rows = await ex
    .selectFrom('inr_settlement_account')
    .select(['id', 'label', 'bank_name', 'account_last4'])
    .where('status', '=', 'ACTIVE')
    .where('direction', 'in', ['COLLECTION', 'BOTH'])
    .orderBy('label')
    .execute();
  return rows.map((r) => ({ accountId: r.id, label: r.label, bankName: r.bank_name, last4: r.account_last4 }));
}
