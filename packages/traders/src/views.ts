import { sql } from 'kysely';
import { DomainError, Money, Rate, requireText } from '@inrp2p/kernel';
import type { Executor, TraderOrderStatus, TraderSide, TraderStatus } from '@inrp2p/db';
import type { FieldProtector } from '@inrp2p/adapters';
import { inrAccountSealContext } from '@inrp2p/inr-accounts';
import { obligationRemaining } from '@inrp2p/settlement';
import { traderMembership, traderProgram } from '@inrp2p/trader-core';
import { COUNTERPARTY_FUNDED } from './delivery.ts';
import { type BlockIssue, type StandingIssue, blockIssues, freeCapacity, standingIssues } from './eligibility.ts';
import { type OrderStage, type OrderStep, orderStage, orderSteps } from './progress.ts';
import { earnings } from './rewards.ts';
import { readBlocks, readStanding } from './standing.ts';

/**
 * What a trader sees, and nothing else.
 *
 * A trader is the other side of a client's trade, and must never learn who that client is, what they were quoted,
 * or what INRP2P keeps. Every projection here is built from the trader's own rows — its order at its own rate, its
 * own payments, INRP2P's payments to it — and passes through `traderSafe`, which refuses any key that belongs to
 * the client side or the desk, in production as well as in tests.
 */
export const FORBIDDEN_TRADER_KEY = /client|margin|quote|request|dealer|obligation|snapshot|operator|created_?by|closed_?by|hmac|enc$|sealed|kyc|screening|legal|planned|route/i;

export function assertTraderSafe(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertTraderSafe(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_TRADER_KEY.test(k)) throw new Error(`trader projection leaks key ${path}.${k}`);
    assertTraderSafe(v, `${path}.${k}`);
  }
}

function traderSafe<T>(value: T): T {
  assertTraderSafe(value);
  return value;
}

const usdt = (minor: bigint) => Money.ofMinor(minor, 'USDT').toDecimalString();
const inr = (minor: bigint) => Money.ofMinor(minor, 'INR').toDecimalString();
const rate = (micro: bigint) => Rate.ofMicro(micro, 'ROUTE').toDecimalString();
const iso = (d: Date | null) => (d ? d.toISOString() : null);
export const maskWallet = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

export interface OrderSummary {
  readonly ref: string;
  readonly side: TraderSide;
  readonly status: TraderOrderStatus;
  readonly stage: OrderStage;
  readonly usdt: string;
  readonly inr: string;
  readonly rate: string;
  readonly offeredAt: string;
  readonly offerExpiresAt: string;
  readonly holdUntil: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly closedAt: string | null;
  readonly closeNote: string | null;
  /** The reward fixed on this order, when INRP2P pays one; earned on completion. */
  readonly reward: string | null;
  /** What the trader still owes on its side, in that side's currency. */
  readonly youOwe: string | null;
}

interface OrderRowFull {
  id: string;
  ref: string;
  side: TraderSide;
  status: TraderOrderStatus;
  base_minor: bigint;
  inr_minor: bigint;
  rate_micro: bigint;
  offered_at: Date;
  offer_expires_at: Date;
  hold_until: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  closed_at: Date | null;
  close_reason: string | null;
  reward_inr_minor: bigint | null;
  trade_id: string | null;
  route_obligation_id: string | null;
}

const ORDER_SELECT = ['o.id', 'o.ref', 'o.side', 'o.status', 'o.base_minor', 'o.inr_minor', 'o.rate_micro', 'o.offered_at', 'o.offer_expires_at', 'o.hold_until', 'o.started_at', 'o.completed_at', 'o.closed_at', 'o.close_reason', 'o.reward_inr_minor', 'o.trade_id', 'o.route_obligation_id'] as const;

interface OrderProgressFacts {
  readonly stage: OrderStage;
  readonly traderOwed: bigint;
  readonly inrp2pOwed: bigint;
  readonly deliveryAddress: string | null;
}

/** The facts behind an order's stage, from the trade, the obligation's allocations and its settlements. */
async function progressFacts(ex: Executor, o: OrderRowFull): Promise<OrderProgressFacts> {
  if (o.status !== 'IN_PROGRESS' || !o.trade_id || !o.route_obligation_id) {
    return { stage: orderStage({ status: o.status, counterpartyFunded: false, traderOwedMinor: 0n, traderPaymentPending: false, inrp2pOwedMinor: 0n, inrp2pPaymentPending: false, needsReview: false }), traderOwed: 0n, inrp2pOwed: 0n, deliveryAddress: null };
  }
  const trade = await ex.selectFrom('trade').select('lifecycle_state').where('id', '=', o.trade_id).executeTakeFirstOrThrow();
  const remaining = await obligationRemaining(ex, o.route_obligation_id);
  const pending = await ex
    .selectFrom('route_settlement')
    .select(['obligation_side'])
    .where('route_obligation_id', '=', o.route_obligation_id)
    .where('status', '=', 'RECORDED')
    .execute();
  const delivery = await ex
    .selectFrom('deposit_assignment as a')
    .innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
    .select(['d.address'])
    .where('a.route_obligation_id', '=', o.route_obligation_id)
    .executeTakeFirst();
  let needsReview = false;
  if (delivery) {
    const stray = await sql<{ n: string }>`
      select count(*)::text as n from crypto_transfer c
      where c.to_address = ${delivery.address} and c.state in ('DETECTED', 'CONFIRMED')
        and not exists (select 1 from transfer_allocation a where a.crypto_transfer_id = c.id and a.dimension = 'ROUTE' and a.voided_at is null)`.execute(ex);
    needsReview = Number.parseInt(stray.rows[0]!.n, 10) > 0;
  }
  const traderOwed = remaining.routeDelivers.minor;
  const inrp2pOwed = remaining.exchangeDelivers.minor;
  return {
    stage: orderStage({
      status: o.status,
      counterpartyFunded: COUNTERPARTY_FUNDED.has(trade.lifecycle_state),
      traderOwedMinor: traderOwed,
      traderPaymentPending: pending.some((p) => p.obligation_side === 'ROUTE_DELIVERS'),
      inrp2pOwedMinor: inrp2pOwed,
      inrp2pPaymentPending: pending.some((p) => p.obligation_side === 'EXCHANGE_DELIVERS'),
      needsReview,
    }),
    traderOwed,
    inrp2pOwed,
    deliveryAddress: delivery?.address ?? null,
  };
}

function summarize(o: OrderRowFull, facts: OrderProgressFacts): OrderSummary {
  const buy = o.side === 'BUY_USDT';
  return {
    ref: o.ref,
    side: o.side,
    status: o.status,
    stage: facts.stage,
    usdt: usdt(o.base_minor),
    inr: inr(o.inr_minor),
    rate: rate(o.rate_micro),
    offeredAt: o.offered_at.toISOString(),
    offerExpiresAt: o.offer_expires_at.toISOString(),
    holdUntil: iso(o.hold_until),
    startedAt: iso(o.started_at),
    completedAt: iso(o.completed_at),
    closedAt: iso(o.closed_at),
    closeNote: o.close_reason,
    reward: o.reward_inr_minor !== null && o.reward_inr_minor > 0n ? inr(o.reward_inr_minor) : null,
    youOwe: o.status === 'IN_PROGRESS' && facts.traderOwed > 0n ? (buy ? inr(facts.traderOwed) : usdt(facts.traderOwed)) : null,
  };
}

export interface BlockView {
  readonly side: TraderSide;
  readonly currency: 'INR' | 'USDT';
  readonly status: 'ACTIVE' | 'PAUSED';
  readonly capacity: string;
  readonly held: string;
  readonly available: string;
  readonly rate: string | null;
  readonly minOrder: string | null;
  readonly maxOrder: string | null;
  /** INRP2P's ceilings, when set; the lower of these and the trader's own figures applies. */
  readonly limitMaxOrder: string | null;
  readonly limitMaxCapacity: string | null;
  readonly issues: readonly BlockIssue[];
  readonly version: number;
}

export interface ReserveView {
  readonly balance: string;
  readonly required: string | null;
  readonly locked: string;
  readonly available: string;
  readonly pendingRelease: string;
  readonly shortfall: string;
  readonly engaged: boolean;
  readonly depositAddress: string | null;
  readonly withdrawal: { readonly ref: string; readonly amount: string; readonly status: 'REQUESTED' | 'SENT'; readonly askedAt: string } | null;
  readonly history: readonly { readonly kind: 'DEPOSIT' | 'WITHDRAWAL'; readonly amount: string; readonly status: string; readonly at: string; readonly txHash: string | null }[];
}

export interface EarningsView {
  readonly rewardBps: number | null;
  readonly today: string;
  readonly available: string;
  readonly payingOut: string;
  readonly pending: string;
  readonly paidOut: string;
  readonly completedOrders: number;
  readonly completedUsdt: string;
  readonly completedInr: string;
}

export interface TraderHome {
  readonly state: 'NONE' | TraderStatus;
  readonly ref: string | null;
  /** This user may apply (CLIENT_ADMIN) / act for the trader (can accept quotes). */
  readonly canApply: boolean;
  readonly canAct: boolean;
  readonly application: {
    readonly offersBuy: boolean;
    readonly offersSell: boolean;
    readonly typicalInr: string | null;
    readonly typicalUsdt: string | null;
    readonly bank: string;
    readonly wallet: string;
    readonly appliedAt: string;
    readonly reviewNote: string | null;
  } | null;
  readonly available: boolean;
  /** INRP2P's own hold, with the reason it gave: paused, or new assignments stopped. */
  readonly controlNote: string | null;
  readonly assignmentsEnabled: boolean;
  readonly issues: readonly StandingIssue[];
  readonly blocks: readonly BlockView[];
  readonly reserve: ReserveView | null;
  readonly offers: readonly OrderSummary[];
  readonly active: readonly OrderSummary[];
  readonly recentlyCompleted: OrderSummary | null;
  readonly earnings: EarningsView | null;
  readonly registered: { readonly bank: string; readonly wallet: string; readonly walletAddress: string } | null;
  readonly paymentDetailsPublished: boolean;
  /** Database time, so a countdown on the page starts from the server's clock. */
  readonly now: string;
}

async function nowOf(ex: Executor): Promise<Date> {
  const r = await sql<{ now: Date }>`select inrp2p_now() as now`.execute(ex);
  return r.rows[0]!.now;
}

async function reserveView(ex: Executor, traderId: string): Promise<ReserveView> {
  const { reserve } = await readStanding(ex, traderId);
  const address = await ex
    .selectFrom('deposit_assignment as a')
    .innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
    .select('d.address')
    .where('a.trader_id', '=', traderId)
    .where('a.released_at', 'is', null)
    .executeTakeFirst();
  const open = await ex
    .selectFrom('trader_reserve_withdrawal')
    .select(['ref', 'amount_minor', 'status', 'requested_at'])
    .where('trader_id', '=', traderId)
    .where('status', 'in', ['REQUESTED', 'SENT'])
    .executeTakeFirst();
  const deposits = await ex
    .selectFrom('crypto_transfer')
    .select(['amount_minor', 'state', 'detected_at', 'confirmed_at', 'tx_hash'])
    .where('payer_type', '=', 'TRADER')
    .where('payer_id', '=', traderId)
    .orderBy('detected_at', 'desc')
    .limit(20)
    .execute();
  const withdrawals = await ex
    .selectFrom('trader_reserve_withdrawal as w')
    .leftJoin('crypto_transfer as c', 'c.id', 'w.crypto_transfer_id')
    .select(['w.amount_minor', 'w.status', 'w.requested_at', 'w.completed_at', 'c.tx_hash'])
    .where('w.trader_id', '=', traderId)
    .orderBy('w.requested_at', 'desc')
    .limit(20)
    .execute();
  const history = [
    ...deposits.map((d) => ({ kind: 'DEPOSIT' as const, amount: usdt(d.amount_minor), status: d.state === 'CONFIRMED' ? 'CREDITED' : d.state === 'DETECTED' ? 'CONFIRMING' : d.state, at: (d.confirmed_at ?? d.detected_at).toISOString(), txHash: d.tx_hash })),
    ...withdrawals.map((w) => ({ kind: 'WITHDRAWAL' as const, amount: usdt(w.amount_minor), status: w.status, at: (w.completed_at ?? w.requested_at).toISOString(), txHash: w.tx_hash })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));
  return {
    balance: reserve.balance.toDecimalString(),
    required: reserve.required?.toDecimalString() ?? null,
    locked: reserve.locked.toDecimalString(),
    available: reserve.available.toDecimalString(),
    pendingRelease: reserve.pendingRelease.toDecimalString(),
    shortfall: reserve.shortfall.toDecimalString(),
    engaged: reserve.engaged,
    depositAddress: address?.address ?? null,
    withdrawal: open ? { ref: open.ref, amount: usdt(open.amount_minor), status: open.status as 'REQUESTED' | 'SENT', askedAt: open.requested_at.toISOString() } : null,
    history,
  };
}

/** The trader's working screen: standing, capacity, reserve, offers, active orders and earnings. */
export async function traderHome(ex: Executor, userId: string): Promise<TraderHome> {
  const member = await traderMembership(ex, userId);
  const now = await nowOf(ex);
  const profile = await ex
    .selectFrom('trader_profile as t')
    .innerJoin('bank_account as b', 'b.id', 't.bank_account_id')
    .innerJoin('crypto_wallet as w', 'w.id', 't.wallet_id')
    .select([
      't.id', 't.ref', 't.status', 't.available', 't.assignments_enabled', 't.control_note', 't.offers_buy', 't.offers_sell', 't.typical_inr_minor', 't.typical_usdt_minor',
      't.applied_at', 't.review_note', 'b.bank_name', 'b.account_last4', 'w.address',
    ])
    .where('t.client_id', '=', member.clientId)
    .executeTakeFirst();
  const base = { canApply: member.role === 'CLIENT_ADMIN', canAct: member.canCommit, now: now.toISOString() };
  if (!profile) {
    return traderSafe({
      state: 'NONE' as const, ref: null, ...base, application: null, available: false, controlNote: null, assignmentsEnabled: true, issues: [], blocks: [], reserve: null,
      offers: [], active: [], recentlyCompleted: null, earnings: null, registered: null, paymentDetailsPublished: false,
    });
  }
  const bank = `${profile.bank_name} ••••${profile.account_last4}`;
  const application = {
    offersBuy: profile.offers_buy,
    offersSell: profile.offers_sell,
    typicalInr: profile.typical_inr_minor === null ? null : inr(profile.typical_inr_minor),
    typicalUsdt: profile.typical_usdt_minor === null ? null : usdt(profile.typical_usdt_minor),
    bank,
    wallet: maskWallet(profile.address),
    appliedAt: profile.applied_at.toISOString(),
    reviewNote: profile.review_note,
  };
  const registered = { bank, wallet: maskWallet(profile.address), walletAddress: profile.address };
  if (profile.status === 'UNDER_REVIEW' || profile.status === 'REJECTED') {
    return traderSafe({
      state: profile.status, ref: profile.ref, ...base, application, available: false, controlNote: null, assignmentsEnabled: profile.assignments_enabled, issues: [], blocks: [],
      reserve: null, offers: [], active: [], recentlyCompleted: null, earnings: null, registered, paymentDetailsPublished: false,
    });
  }

  const { standing } = await readStanding(ex, profile.id);
  const blocks = await readBlocks(ex, profile.id);
  const program = await traderProgram(ex);
  const orders = await ex
    .selectFrom('trader_order as o')
    .select(ORDER_SELECT)
    .where('o.trader_id', '=', profile.id)
    .where((eb) => eb.or([eb('o.status', 'in', ['OFFERED', 'ACCEPTED', 'IN_PROGRESS']), eb('o.completed_at', '>', sql<Date>`inrp2p_now() - interval '10 minutes'`)]))
    .orderBy('o.offered_at', 'desc')
    .execute();
  const summaries: OrderSummary[] = [];
  for (const o of orders) summaries.push(summarize(o, await progressFacts(ex, o)));
  const e = await earnings(ex, profile.id);

  return traderSafe({
    state: profile.status,
    ref: profile.ref,
    ...base,
    application,
    available: profile.available,
    controlNote: profile.control_note,
    assignmentsEnabled: profile.assignments_enabled,
    issues: standingIssues(standing),
    blocks: blocks.map((b): BlockView => {
      const currency = b.side === 'BUY_USDT' ? 'INR' : 'USDT';
      const fmt = (m: bigint | null) => (m === null ? null : Money.ofMinor(m, currency).toDecimalString());
      return {
        side: b.side,
        currency,
        status: b.status,
        capacity: fmt(b.capacityMinor)!,
        held: fmt(b.reservedMinor)!,
        available: fmt(freeCapacity({ ...b, offeredMinor: 0n }))!,
        rate: b.rateMicro === null ? null : rate(b.rateMicro),
        minOrder: fmt(b.minOrderMinor),
        maxOrder: fmt(b.maxOrderMinor),
        limitMaxOrder: fmt(b.operatorMaxOrderMinor),
        limitMaxCapacity: fmt(b.operatorMaxCapacityMinor),
        issues: blockIssues({ ...b, offeredMinor: 0n }),
        version: b.version,
      };
    }),
    reserve: await reserveView(ex, profile.id),
    offers: summaries.filter((s) => s.status === 'OFFERED' && Date.parse(s.offerExpiresAt) > now.getTime()),
    active: summaries.filter((s) => s.status === 'ACCEPTED' || s.status === 'IN_PROGRESS'),
    recentlyCompleted: summaries.find((s) => s.status === 'COMPLETED') ?? null,
    earnings: {
      rewardBps: e.rewardBps,
      today: e.today.toDecimalString(),
      available: e.available.toDecimalString(),
      payingOut: e.payingOut.toDecimalString(),
      pending: e.pending.toDecimalString(),
      paidOut: e.paidOut.toDecimalString(),
      completedOrders: e.completedOrders,
      completedUsdt: e.completedUsdt.toDecimalString(),
      completedInr: e.completedInr.toDecimalString(),
    },
    registered,
    paymentDetailsPublished: program.collectionAccountId !== null,
  });
}

/** Both tabs of the Orders list. Active: offered, held and in progress. Completed: finished, newest first. */
export async function traderOrders(ex: Executor, userId: string, tab: 'active' | 'completed', limit = 100): Promise<{ rows: readonly OrderSummary[]; counts: { active: number; completed: number } }> {
  const member = await traderMembership(ex, userId);
  const trader = await ex.selectFrom('trader_profile').select('id').where('client_id', '=', member.clientId).executeTakeFirst();
  if (!trader) return { rows: [], counts: { active: 0, completed: 0 } };
  const activeStatuses: TraderOrderStatus[] = ['OFFERED', 'ACCEPTED', 'IN_PROGRESS'];
  const rows = await ex
    .selectFrom('trader_order as o')
    .select(ORDER_SELECT)
    .where('o.trader_id', '=', trader.id)
    .where('o.status', tab === 'active' ? 'in' : 'not in', activeStatuses)
    .orderBy(tab === 'active' ? 'o.offered_at' : 'o.closed_at', 'desc')
    .limit(Math.min(limit, 200))
    .execute();
  const counts = await sql<{ active: string; completed: string }>`
    select count(*) filter (where status in ('OFFERED', 'ACCEPTED', 'IN_PROGRESS'))::text as active,
           count(*) filter (where status not in ('OFFERED', 'ACCEPTED', 'IN_PROGRESS'))::text as completed
    from trader_order where trader_id = ${trader.id}`.execute(ex);
  const out: OrderSummary[] = [];
  for (const o of rows) out.push(summarize(o, await progressFacts(ex, o)));
  return traderSafe({ rows: out, counts: { active: Number.parseInt(counts.rows[0]!.active, 10), completed: Number.parseInt(counts.rows[0]!.completed, 10) } });
}

export interface PaymentRow {
  readonly amount: string;
  readonly currency: 'INR' | 'USDT';
  readonly status: 'CHECKING' | 'CONFIRMED' | 'FAILED';
  readonly reference: string | null;
  readonly at: string;
}

export interface TraderOrderDetail {
  readonly order: OrderSummary;
  readonly steps: readonly OrderStep[];
  /** How the trader settles this order, in plain terms. */
  readonly method: string;
  /** Where the trader receives: its own registered destination. */
  readonly youReceiveAt: string;
  /** The trader's payments on this order, and INRP2P's payments to it. */
  readonly yourPayments: readonly PaymentRow[];
  readonly inrp2pPayments: readonly PaymentRow[];
  /** INR still owed by the trader (Buy USDT) or USDT (Sell USDT); INRP2P's side likewise. */
  readonly youOwe: string | null;
  readonly inrp2pOwes: string | null;
  /** Buy USDT, at the trader's turn: where to pay. Null until then, or when not published. */
  readonly payTo: { readonly beneficiary: string; readonly bankName: string; readonly ifsc: string; readonly accountNumber: string; readonly narration: string } | null;
  /** Sell USDT: this order's own address, once issued. */
  readonly sendTo: string | null;
  readonly paymentDetailsPublished: boolean;
  readonly now: string;
}

/** One order, as its trader sees it. Another trader's reference is "not found". */
export async function traderOrderDetail(ex: Executor, userId: string, ref: string, protector: FieldProtector): Promise<TraderOrderDetail> {
  const member = await traderMembership(ex, userId);
  const o = await ex
    .selectFrom('trader_order as o')
    .innerJoin('trader_profile as t', 't.id', 'o.trader_id')
    .innerJoin('bank_account as b', 'b.id', 't.bank_account_id')
    .innerJoin('crypto_wallet as w', 'w.id', 't.wallet_id')
    .select([...ORDER_SELECT, 'b.bank_name', 'b.account_last4', 'w.address'])
    .where('o.ref', '=', requireText(ref, 'ref', 32))
    .where('t.client_id', '=', member.clientId)
    .executeTakeFirst();
  if (!o) throw new DomainError('NOT_FOUND', 'order not found');
  const facts = await progressFacts(ex, o);
  const summary = summarize(o, facts);
  const buy = o.side === 'BUY_USDT';
  const now = await nowOf(ex);
  const program = await traderProgram(ex);

  const payments = o.route_obligation_id
    ? await ex
        .selectFrom('route_settlement as s')
        .leftJoin('fiat_transfer as f', 'f.id', 's.fiat_transfer_id')
        .leftJoin('crypto_transfer as c', 'c.id', 's.crypto_transfer_id')
        .select(['s.obligation_side', 's.asset', 's.amount_minor', 's.status', 's.recorded_at', 's.confirmed_at', 'f.utr', 'c.tx_hash'])
        .where('s.route_obligation_id', '=', o.route_obligation_id)
        .orderBy('s.recorded_at')
        .execute()
    : [];
  const row = (p: (typeof payments)[number]): PaymentRow => ({
    amount: Money.ofMinor(p.amount_minor, p.asset).toDecimalString(),
    currency: p.asset,
    status: p.status === 'CONFIRMED' ? 'CONFIRMED' : p.status === 'FAILED' ? 'FAILED' : 'CHECKING',
    reference: p.utr ?? p.tx_hash ?? null,
    at: (p.confirmed_at ?? p.recorded_at).toISOString(),
  });

  let payTo: TraderOrderDetail['payTo'] = null;
  if (buy && facts.stage === 'YOUR_TURN' && program.collectionAccountId) {
    const account = await ex
      .selectFrom('inr_settlement_account as a')
      .innerJoin('settlement_entity as e', 'e.id', 'a.entity_id')
      .select(['a.bank_name', 'a.ifsc', 'a.account_number_enc', 'a.entity_id', 'e.legal_name'])
      .where('a.id', '=', program.collectionAccountId)
      .executeTakeFirstOrThrow();
    payTo = {
      beneficiary: account.legal_name,
      bankName: account.bank_name,
      ifsc: account.ifsc,
      accountNumber: await protector.open(account.account_number_enc, inrAccountSealContext(account.entity_id)),
      narration: o.ref,
    };
  }

  return traderSafe({
    order: summary,
    steps: o.status === 'OFFERED' || o.status === 'ACCEPTED' || o.status === 'IN_PROGRESS' || o.status === 'COMPLETED' ? orderSteps(o.side, facts.stage) : [],
    method: buy
      ? 'You pay INR by bank transfer to INRP2P from your registered account. INRP2P sends USDT on TRC20 to your registered wallet.'
      : 'You send USDT on TRC20 from your registered wallet to this order’s own address. INRP2P pays INR to your registered bank account.',
    youReceiveAt: buy ? `TRC20 · ${maskWallet(o.address)}` : `${o.bank_name} ••••${o.account_last4}`,
    yourPayments: payments.filter((p) => p.obligation_side === 'ROUTE_DELIVERS').map(row),
    inrp2pPayments: payments.filter((p) => p.obligation_side === 'EXCHANGE_DELIVERS').map(row),
    youOwe: summary.youOwe,
    inrp2pOwes: o.status === 'IN_PROGRESS' && facts.inrp2pOwed > 0n ? (buy ? usdt(facts.inrp2pOwed) : inr(facts.inrp2pOwed)) : null,
    payTo,
    sendTo: facts.deliveryAddress,
    paymentDetailsPublished: program.collectionAccountId !== null,
    now: now.toISOString(),
  });
}

/** Step 3 and 4 of the application: the client's own registered destinations, and the reserve the desk requires. */
export async function traderApplicationOptions(ex: Executor, userId: string): Promise<{
  banks: readonly { id: string; label: string; holder: string }[];
  wallets: readonly { id: string; label: string; address: string; usable: boolean }[];
  reserveRequired: string | null;
  canApply: boolean;
}> {
  const member = await traderMembership(ex, userId);
  const banks = await ex.selectFrom('bank_account').select(['id', 'bank_name', 'account_last4', 'holder_name']).where('client_id', '=', member.clientId).where('status', '=', 'ACTIVE').orderBy('created_at').execute();
  const wallets = await ex.selectFrom('crypto_wallet').select(['id', 'label', 'address', 'purpose']).where('client_id', '=', member.clientId).where('status', '=', 'ACTIVE').where('network', '=', 'TRON').orderBy('created_at').execute();
  const program = await traderProgram(ex);
  return traderSafe({
    banks: banks.map((b) => ({ id: b.id, label: `${b.bank_name} ••••${b.account_last4}`, holder: b.holder_name })),
    wallets: wallets.map((w) => ({ id: w.id, label: w.label, address: w.address, usable: w.purpose === 'BOTH' })),
    reserveRequired: program.defaultRequiredReserve?.toDecimalString() ?? null,
    canApply: member.role === 'CLIENT_ADMIN',
  });
}

