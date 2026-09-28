import { sql } from 'kysely';
import { DomainError, Money, requireUuid } from '@inrp2p/kernel';
import type { DirectionValue, Executor } from '@inrp2p/db';
import type { DeskAccess } from './access.ts';
import { microToDecimal } from './strip.ts';
import { type DeskTrade, deskTrade } from './trade.ts';

/**
 * The trade record, and the desk-wide lists the operator works from besides the queue: every open exception case
 * (including the ones no trade owns), the decisions waiting for a second person, and the route-rate history.
 *
 * All of it is read-only and every figure comes from the rows the commands wrote. Nothing here decides anything:
 * a timeline row is a transition, a leg timestamp, a case or an adjustment that already happened, and an approval
 * listed here is still authorized — and refused, when it has to be — by its own command.
 */

type Amount = { readonly amount: string; readonly currency: 'INR' | 'USDT' };

export type TimelineTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface TimelineEvent {
  readonly at: string;
  readonly kind: 'TRADE' | 'LEG' | 'CASE' | 'ADJUSTMENT' | 'QUOTE';
  /** What happened, in the desk's own words ("Payout confirmed"). */
  readonly title: string;
  readonly ref: string | null;
  readonly amount: Amount | null;
  /** The operator who did it, when the row records one; "System" for the scanner and the jobs. */
  readonly actor: string | null;
  readonly note: string | null;
  readonly tone: TimelineTone;
}

export interface DeskAdjustment {
  readonly id: string;
  readonly ref: string;
  readonly tradeId: string;
  readonly tradeRef: string;
  readonly clientName: string;
  readonly type: 'AMOUNT_CORRECTION' | 'RATE_CORRECTION' | 'FEE' | 'WRITE_OFF' | 'REFUND';
  readonly status: 'REQUESTED' | 'POSTED' | 'REJECTED';
  readonly deltaBase: string;
  readonly deltaClientInr: string;
  /** Route side and margin deltas are economics: absent without `economics:view`. */
  readonly deltaRouteInr?: string;
  readonly deltaMargin?: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly requestedByLabel: string;
  readonly requestedAt: string;
  readonly decidedByLabel: string | null;
  readonly decidedAt: string | null;
  readonly rejectReason: string | null;
}

export interface DeskTradeRecord {
  readonly trade: DeskTrade;
  readonly requestRef: string;
  readonly quoteRef: string;
  readonly acceptedAt: string | null;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  /** Where the client is paid: the destination frozen into the trade at acceptance (S8). Masked. */
  readonly destination: { readonly kind: 'BANK' | 'WALLET'; readonly label: string; readonly detail: string; readonly active: boolean } | null;
  readonly adjustments: readonly DeskAdjustment[];
  readonly timeline: readonly TimelineEvent[];
}

/** Actors are user ids, or `SYSTEM` / `SYSTEM:<command>` for the scanner and the jobs. */
const label = (id: string | null | undefined, name: string | null | undefined): string | null =>
  id === null || id === undefined ? null : id.startsWith('SYSTEM') ? 'System' : (name ?? 'an operator');

/** A trade's id from its reference (`IX-260919-0002`), for the record's address. Null when there is none. */
export async function tradeIdByRef(ex: Executor, ref: string): Promise<string | null> {
  const r = await ex.selectFrom('trade').select('id').where('ref', '=', ref.trim().toUpperCase()).executeTakeFirst();
  return r?.id ?? null;
}

/** The full record of one trade: the panel's picture of it, plus where it came from and everything that happened. */
export async function deskTradeRecord(ex: Executor, tradeId: string, access: DeskAccess): Promise<DeskTradeRecord> {
  const id = requireUuid(tradeId, 'tradeId');
  const trade = await deskTrade(ex, id, access);
  const head = await sql<{
    request_ref: string; quote_ref: string; accepted_at: Date | null; completed_at: Date | null; cancelled_at: Date | null;
    bank_name: string | null; ifsc: string | null; account_last4: string | null; holder_name: string | null; bank_status: string | null;
    wallet_address: string | null; wallet_label: string | null; wallet_network: string | null; wallet_status: string | null;
  }>`
    select r.ref as request_ref, q.ref as quote_ref, q.accepted_at, t.completed_at, t.cancelled_at,
           b.bank_name, b.ifsc, b.account_last4, b.holder_name, b.status as bank_status,
           w.address as wallet_address, w.label as wallet_label, w.network as wallet_network, w.status as wallet_status
    from trade t
    join trade_request r on r.id = t.trade_request_id
    join quote q on q.id = t.quote_id
    join trade_economics e on e.trade_id = t.id
    left join bank_account b on b.id = e.bank_account_id
    left join crypto_wallet w on w.id = e.crypto_wallet_id
    where t.id = ${id}`.execute(ex);
  const h = head.rows[0];
  if (!h) throw new DomainError('NOT_FOUND', 'trade not found');

  const destination: DeskTradeRecord['destination'] = h.bank_name
    ? { kind: 'BANK', label: h.holder_name ?? h.bank_name, detail: `${h.bank_name} · ${h.ifsc} · ••••${h.account_last4}`, active: h.bank_status === 'ACTIVE' }
    : h.wallet_address
      ? { kind: 'WALLET', label: h.wallet_label ?? 'Wallet', detail: `${h.wallet_network === 'TRON' ? 'TRC20' : h.wallet_network} · ${h.wallet_address}`, active: h.wallet_status === 'ACTIVE' }
      : null;

  const adjustments = await adjustmentsWhere(ex, access, { tradeId: id });
  return {
    trade,
    requestRef: h.request_ref,
    quoteRef: h.quote_ref,
    acceptedAt: h.accepted_at ? h.accepted_at.toISOString() : null,
    completedAt: h.completed_at ? h.completed_at.toISOString() : null,
    cancelledAt: h.cancelled_at ? h.cancelled_at.toISOString() : null,
    destination,
    adjustments,
    timeline: await timelineOf(ex, id, trade, access),
  };
}

/**
 * Evidence as the desk shows it in a history: a UTR masked to its last four (SECURITY §5 — the full reference is
 * on the leg and the receipt, never repeated in a feed), a transaction hash shortened the way the explorer does.
 */
function evidence(reference: string, kind: 'UTR' | 'TX' | null): string {
  if (kind === 'TX') return `tx ${reference.length <= 9 ? reference : `${reference.slice(0, 4)}…${reference.slice(-4)}`}`;
  return `UTR ••••${reference.trim().slice(-4)}`;
}

const LIFECYCLE_TITLE: Record<string, { title: string; tone: TimelineTone }> = {
  AWAITING_FIRST_LEG: { title: 'Trade opened · awaiting client funds', tone: 'neutral' },
  FIRST_LEG_DETECTED: { title: 'Client funds detected', tone: 'neutral' },
  FIRST_LEG_CONFIRMED: { title: 'Client funds confirmed', tone: 'success' },
  SETTLING: { title: 'Settlement started', tone: 'neutral' },
  PARTIALLY_SETTLED: { title: 'Partially settled', tone: 'neutral' },
  COMPLETED: { title: 'Trade completed', tone: 'success' },
  CANCELLED: { title: 'Trade cancelled', tone: 'danger' },
};

async function timelineOf(ex: Executor, tradeId: string, trade: DeskTrade, access: DeskAccess): Promise<TimelineEvent[]> {
  const events: TimelineEvent[] = [];

  const quote = await sql<{ ref: string; sent_at: Date | null; sent_by: string | null; sent_label: string | null; accepted_at: Date | null }>`
    select q.ref, q.sent_at, q.sent_by, coalesce(u.name, u.email) as sent_label, q.accepted_at
    from trade t join quote q on q.id = t.quote_id
    left join auth_user u on u.id::text = q.sent_by
    where t.id = ${tradeId}`.execute(ex);
  const q = quote.rows[0];
  if (q?.sent_at) events.push({ at: q.sent_at.toISOString(), kind: 'QUOTE', title: 'Quote sent', ref: q.ref, amount: null, actor: label(q.sent_by, q.sent_label), note: null, tone: 'neutral' });
  if (q?.accepted_at) events.push({ at: q.accepted_at.toISOString(), kind: 'QUOTE', title: 'Quote accepted by the client', ref: q.ref, amount: null, actor: null, note: null, tone: 'neutral' });

  const transitions = await sql<{ to_state: string; actor: string; actor_label: string | null; at: Date }>`
    select tt.to_state, tt.actor, coalesce(u.name, u.email) as actor_label, tt.at
    from trade_transition tt left join auth_user u on u.id::text = tt.actor
    where tt.trade_id = ${tradeId} order by tt.id`.execute(ex);
  for (const t of transitions.rows) {
    const known = LIFECYCLE_TITLE[t.to_state] ?? { title: t.to_state.toLowerCase().replace(/_/g, ' '), tone: 'neutral' as const };
    events.push({ at: t.at.toISOString(), kind: 'TRADE', title: known.title, ref: null, amount: null, actor: label(t.actor, t.actor_label), note: null, tone: known.tone });
  }

  for (const leg of trade.legs) {
    const amount = { amount: leg.amount, currency: leg.asset } as const;
    const who = leg.side === 'CLIENT_TO_EXCHANGE' ? 'client' : leg.side === 'REFUND_TO_CLIENT' ? 'refund' : 'payout';
    const created =
      who === 'client' ? (leg.asset === 'USDT' ? 'USDT arrived at the deposit address' : 'Client INR payment recorded') : who === 'refund' ? 'Refund leg created' : 'Payout leg created';
    events.push({ at: leg.createdAt, kind: 'LEG', title: created, ref: leg.ref, amount, actor: leg.createdByLabel, note: leg.payer === 'ROUTE' ? `paid by ${leg.routeName ?? 'the route'}` : leg.accountLabel, tone: 'neutral' });
    if (leg.sentAt && who !== 'client') {
      events.push({ at: leg.sentAt, kind: 'LEG', title: who === 'refund' ? 'Refund sent' : leg.payer === 'ROUTE' ? 'Route reported the payout sent' : 'Payout sent', ref: leg.ref, amount, actor: null, note: null, tone: 'neutral' });
    }
    if (leg.confirmedAt) {
      events.push({
        at: leg.confirmedAt, kind: 'LEG', title: who === 'client' ? 'Client funds confirmed on the leg' : who === 'refund' ? 'Refund confirmed' : 'Payout confirmed',
        ref: leg.ref, amount, actor: null, note: leg.reference ? evidence(leg.reference, leg.referenceKind) : null, tone: 'success',
      });
    }
    if (leg.failedAt) events.push({ at: leg.failedAt, kind: 'LEG', title: who === 'client' ? 'Client payment not received' : who === 'refund' ? 'Refund failed' : 'Payout failed', ref: leg.ref, amount, actor: null, note: leg.failureReason, tone: 'danger' });
    if (leg.cancelledAt) events.push({ at: leg.cancelledAt, kind: 'LEG', title: 'Leg cancelled', ref: leg.ref, amount, actor: null, note: leg.failureReason, tone: 'warning' });
  }

  const cases = await sql<{
    ref: string; type: string; severity: string; status: string; opened_at: Date; opened_by: string; opened_label: string | null;
    resolved_at: Date | null; resolved_by: string | null; resolved_label: string | null; resolution_command: string | null; resolution_notes: string | null;
  }>`
    select x.ref, x.type, x.severity, x.status, x.opened_at, x.opened_by, coalesce(o.name, o.email) as opened_label,
           x.resolved_at, x.resolved_by, coalesce(r.name, r.email) as resolved_label, x.resolution_command, x.resolution_notes
    from exception_case x
    left join auth_user o on o.id::text = x.opened_by
    left join auth_user r on r.id::text = x.resolved_by
    where x.trade_id = ${tradeId} order by x.opened_at`.execute(ex);
  for (const c of cases.rows) {
    const type = c.type.replace(/_/g, ' ').toLowerCase();
    events.push({
      at: c.opened_at.toISOString(), kind: 'CASE', title: `${c.severity === 'BLOCKING' ? 'Blocking exception' : 'Exception'} opened · ${type}`,
      ref: c.ref, amount: null, actor: label(c.opened_by, c.opened_label), note: null, tone: c.severity === 'BLOCKING' ? 'danger' : 'warning',
    });
    if (c.resolved_at) {
      events.push({
        at: c.resolved_at.toISOString(), kind: 'CASE', title: c.status === 'VOID' ? 'Exception voided' : `Exception resolved · ${(c.resolution_command ?? '').replace(/_/g, ' ')}`,
        ref: c.ref, amount: null, actor: label(c.resolved_by, c.resolved_label), note: c.resolution_notes, tone: 'success',
      });
    }
  }

  for (const a of await adjustmentsWhere(ex, access, { tradeId })) {
    events.push({ at: a.requestedAt, kind: 'ADJUSTMENT', title: `Adjustment requested · ${a.type.replace(/_/g, ' ').toLowerCase()}`, ref: a.ref, amount: null, actor: a.requestedByLabel, note: a.reason, tone: 'warning' });
    if (a.decidedAt) {
      events.push({
        at: a.decidedAt, kind: 'ADJUSTMENT', title: a.status === 'POSTED' ? 'Adjustment approved and posted' : 'Adjustment rejected',
        ref: a.ref, amount: null, actor: a.decidedByLabel, note: a.rejectReason, tone: a.status === 'POSTED' ? 'success' : 'neutral',
      });
    }
  }

  // Newest first; ties keep the order the lifecycle produced them in.
  return events.map((e, i) => ({ e, i })).sort((a, b) => (a.e.at < b.e.at ? 1 : a.e.at > b.e.at ? -1 : b.i - a.i)).map((x) => x.e);
}

async function adjustmentsWhere(ex: Executor, access: DeskAccess, where: { tradeId?: string; status?: 'REQUESTED' }): Promise<DeskAdjustment[]> {
  const rows = await sql<{
    id: string; ref: string; trade_id: string; trade_ref: string; client_name: string; type: DeskAdjustment['type']; status: DeskAdjustment['status'];
    delta_base_minor: bigint; delta_quote_inr_minor: bigint; delta_route_inr_minor: bigint; delta_margin_inr_minor: bigint; reason: string;
    requested_by: string; requested_label: string | null; requested_at: Date;
    approved_by: string | null; approved_label: string | null; approved_at: Date | null;
    rejected_by: string | null; rejected_label: string | null; rejected_at: Date | null; reject_reason: string | null;
  }>`
    select a.id, a.ref, a.trade_id, t.ref as trade_ref, c.display_name as client_name, a.type, a.status,
           a.delta_base_minor, a.delta_quote_inr_minor, a.delta_route_inr_minor, a.delta_margin_inr_minor, a.reason,
           a.requested_by, coalesce(rq.name, rq.email) as requested_label, a.requested_at,
           a.approved_by, coalesce(ap.name, ap.email) as approved_label, a.approved_at,
           a.rejected_by, coalesce(rj.name, rj.email) as rejected_label, a.rejected_at, a.reject_reason
    from financial_adjustment a
    join trade t on t.id = a.trade_id
    join client c on c.id = t.client_id
    left join auth_user rq on rq.id::text = a.requested_by
    left join auth_user ap on ap.id::text = a.approved_by
    left join auth_user rj on rj.id::text = a.rejected_by
    where (${where.tradeId ?? null}::uuid is null or a.trade_id = ${where.tradeId ?? null}::uuid)
      and (${where.status ?? null}::text is null or a.status = ${where.status ?? null}::text)
    order by a.requested_at desc
    limit 200`.execute(ex);
  return rows.rows.map((r) => {
    const decided = r.status === 'POSTED' ? { by: r.approved_by, label: r.approved_label, at: r.approved_at } : r.status === 'REJECTED' ? { by: r.rejected_by, label: r.rejected_label, at: r.rejected_at } : null;
    const base: DeskAdjustment = {
      id: r.id,
      ref: r.ref,
      tradeId: r.trade_id,
      tradeRef: r.trade_ref,
      clientName: r.client_name,
      type: r.type,
      status: r.status,
      deltaBase: Money.ofMinor(r.delta_base_minor, 'USDT').toDecimalString(),
      deltaClientInr: Money.ofMinor(r.delta_quote_inr_minor, 'INR').toDecimalString(),
      reason: r.reason,
      requestedBy: r.requested_by,
      requestedByLabel: label(r.requested_by, r.requested_label) ?? 'an operator',
      requestedAt: r.requested_at.toISOString(),
      decidedByLabel: decided ? label(decided.by, decided.label) : null,
      decidedAt: decided?.at ? decided.at.toISOString() : null,
      rejectReason: r.reject_reason,
    };
    if (!access.economics) return base;
    return {
      ...base,
      deltaRouteInr: Money.ofMinor(r.delta_route_inr_minor, 'INR').toDecimalString(),
      deltaMargin: Money.ofMinor(r.delta_margin_inr_minor, 'INR').toDecimalString(),
    };
  });
}

/* ------------------------------------------------------------------ *
 * Exceptions, desk-wide                                                *
 * ------------------------------------------------------------------ */

export interface DeskExceptionRow {
  readonly id: string;
  readonly ref: string;
  readonly type: string;
  readonly severity: 'BLOCKING' | 'WARNING';
  readonly status: 'OPEN' | 'IN_PROGRESS';
  /** What the case is about: a trade, a leg, a transfer, a deposit address, an account… */
  readonly subjectType: string;
  readonly details: Record<string, unknown>;
  readonly detectedBy: 'SYSTEM' | 'OPERATOR';
  readonly openedAt: string;
  readonly openedByLabel: string;
  readonly takenBy: string | null;
  readonly takenByLabel: string | null;
  /** Null for a case no trade owns — an unallocated deposit, a low address pool, a statement line. */
  readonly trade: { readonly id: string; readonly ref: string; readonly clientName: string; readonly direction: DirectionValue } | null;
}

/**
 * Every open case on the desk, trade-bound or not. The queue shows a trade on hold; this is where the cases that
 * hold no trade — funds at an unassigned address, a pool running dry, a bank line nobody recorded — are worked,
 * because a case the desk cannot see is a case nobody closes.
 */
export async function deskExceptions(ex: Executor): Promise<readonly DeskExceptionRow[]> {
  const rows = await sql<{
    id: string; ref: string; type: string; severity: DeskExceptionRow['severity']; status: DeskExceptionRow['status']; subject_type: string;
    details: unknown; detected_by: DeskExceptionRow['detectedBy']; opened_at: Date; opened_by: string; opened_label: string | null;
    taken_by: string | null; taken_label: string | null; trade_id: string | null; trade_ref: string | null; client_name: string | null; direction: DirectionValue | null;
  }>`
    select x.id, x.ref, x.type, x.severity, x.status, x.subject_type, x.details, x.detected_by, x.opened_at,
           x.opened_by, coalesce(o.name, o.email) as opened_label, x.taken_by, coalesce(k.name, k.email) as taken_label,
           t.id as trade_id, t.ref as trade_ref, c.display_name as client_name, t.direction
    from exception_case x
    left join trade t on t.id = x.trade_id
    left join client c on c.id = t.client_id
    left join auth_user o on o.id::text = x.opened_by
    left join auth_user k on k.id::text = x.taken_by
    where x.status in ('OPEN', 'IN_PROGRESS')
    order by case x.severity when 'BLOCKING' then 0 else 1 end, x.opened_at
    limit 500`.execute(ex);
  return rows.rows.map((r) => ({
    id: r.id,
    ref: r.ref,
    type: r.type,
    severity: r.severity,
    status: r.status,
    subjectType: r.subject_type,
    details: (r.details ?? {}) as Record<string, unknown>,
    detectedBy: r.detected_by,
    openedAt: r.opened_at.toISOString(),
    openedByLabel: label(r.opened_by, r.opened_label) ?? 'System',
    takenBy: r.taken_by,
    takenByLabel: r.taken_by ? label(r.taken_by, r.taken_label) : null,
    trade: r.trade_id && r.trade_ref && r.client_name && r.direction ? { id: r.trade_id, ref: r.trade_ref, clientName: r.client_name, direction: r.direction } : null,
  }));
}

/* ------------------------------------------------------------------ *
 * Decisions waiting for a second person                                *
 * ------------------------------------------------------------------ */

export interface DeskRefundApproval {
  readonly legId: string;
  readonly legRef: string;
  readonly tradeId: string;
  readonly tradeRef: string;
  readonly clientName: string;
  readonly asset: 'INR' | 'USDT';
  readonly amount: string;
  readonly status: 'PENDING' | 'PROCESSING';
  readonly createdBy: string;
  readonly createdByLabel: string;
  readonly createdAt: string;
}

export interface DeskApprovals {
  /** Financial adjustments requested and not yet decided (FI-31: requester ≠ approver). */
  readonly adjustments: readonly DeskAdjustment[];
  /** Refund legs created and not yet confirmed (T10: creator ≠ confirmer). */
  readonly refunds: readonly DeskRefundApproval[];
}

export async function deskApprovals(ex: Executor, access: DeskAccess): Promise<DeskApprovals> {
  const adjustments = await adjustmentsWhere(ex, access, { status: 'REQUESTED' });
  const refunds = await sql<{
    id: string; ref: string; trade_id: string; trade_ref: string; client_name: string; asset: 'INR' | 'USDT'; amount_minor: bigint;
    status: 'PENDING' | 'PROCESSING'; created_by: string; created_label: string | null; created_at: Date;
  }>`
    select l.id, l.ref, l.trade_id, t.ref as trade_ref, c.display_name as client_name, l.asset, l.amount_minor, l.status,
           l.created_by, coalesce(u.name, u.email) as created_label, l.created_at
    from settlement_leg l
    join trade t on t.id = l.trade_id
    join client c on c.id = t.client_id
    left join auth_user u on u.id::text = l.created_by
    where l.side = 'REFUND_TO_CLIENT' and l.status in ('PENDING', 'PROCESSING')
    order by l.created_at`.execute(ex);
  return {
    adjustments,
    refunds: refunds.rows.map((r) => ({
      legId: r.id,
      legRef: r.ref,
      tradeId: r.trade_id,
      tradeRef: r.trade_ref,
      clientName: r.client_name,
      asset: r.asset,
      amount: Money.ofMinor(r.amount_minor, r.asset).toDecimalString(),
      status: r.status,
      createdBy: r.created_by,
      createdByLabel: label(r.created_by, r.created_label) ?? 'an operator',
      createdAt: r.created_at.toISOString(),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Route-rate history                                                   *
 * ------------------------------------------------------------------ */

export interface RateHistoryRow {
  readonly id: string;
  readonly routeId: string;
  readonly routeName: string;
  readonly direction: DirectionValue;
  readonly rate: string;
  /** The snapshot this one replaced in the same series, for the change column. Null for the first. */
  readonly previous: string | null;
  readonly effectiveAt: string;
  readonly byLabel: string;
}

/**
 * The desk's own route rates as they were published, newest first. A route rate is economics, so the page only
 * asks for this with `economics:view` — the same gate the strip applies to the current rate.
 */
export async function rateHistory(ex: Executor, opts: { limit?: number } = {}): Promise<readonly RateHistoryRow[]> {
  const rows = await sql<{
    id: string; route_id: string; route_name: string; direction: DirectionValue; rate_micro: bigint; previous_micro: bigint | null;
    effective_at: Date; created_by: string; by_label: string | null;
  }>`
    select s.id, s.route_id, r.name as route_name, s.direction, s.rate_micro,
           lag(s.rate_micro) over (partition by s.route_id, s.direction order by s.effective_at, s.id) as previous_micro,
           s.effective_at, s.created_by, coalesce(u.name, u.email) as by_label
    from rate_snapshot s
    join liquidity_route r on r.id = s.route_id
    left join auth_user u on u.id::text = s.created_by
    where s.kind = 'ROUTE' and r.trader_id is null
    order by s.effective_at desc, s.id desc
    limit ${opts.limit ?? 40}`.execute(ex);
  return rows.rows.map((r) => ({
    id: r.id,
    routeId: r.route_id,
    routeName: r.route_name,
    direction: r.direction,
    rate: microToDecimal(BigInt(r.rate_micro)),
    previous: r.previous_micro === null ? null : microToDecimal(BigInt(r.previous_micro)),
    effectiveAt: r.effective_at.toISOString(),
    byLabel: label(r.created_by, r.by_label) ?? 'an operator',
  }));
}

/* ------------------------------------------------------------------ *
 * References the command palette resolves                              *
 * ------------------------------------------------------------------ */

export interface RefHit {
  readonly kind: 'REQUEST' | 'QUOTE' | 'EXCEPTION';
  readonly id: string;
  readonly ref: string;
  readonly status: string;
  readonly clientName: string | null;
  /** The trade a quote became, or the trade a case holds, so the palette can go straight to it. */
  readonly tradeRef: string | null;
}

/** Exact reference lookups for requests, quotes and exception cases — never a "close enough" match. */
export async function findByRef(ex: Executor, term: string): Promise<readonly RefHit[]> {
  const ref = term.trim().toUpperCase();
  if (ref.length < 4) return [];
  const rows = await sql<{ kind: RefHit['kind']; id: string; ref: string; status: string; client_name: string | null; trade_ref: string | null }>`
    select 'REQUEST' as kind, r.id, r.ref, r.status, c.display_name as client_name, (select t.ref from trade t where t.trade_request_id = r.id) as trade_ref
    from trade_request r join client c on c.id = r.client_id where upper(r.ref) = ${ref}
    union all
    select 'QUOTE' as kind, q.id, q.ref, q.status, c.display_name as client_name, (select t.ref from trade t where t.quote_id = q.id) as trade_ref
    from quote q join client c on c.id = q.client_id where upper(q.ref) = ${ref}
    union all
    select 'EXCEPTION' as kind, x.id, x.ref, x.status, c.display_name as client_name, t.ref as trade_ref
    from exception_case x left join trade t on t.id = x.trade_id left join client c on c.id = t.client_id where upper(x.ref) = ${ref}`.execute(ex);
  return rows.rows.map((r) => ({ kind: r.kind, id: r.id, ref: r.ref, status: r.status, clientName: r.client_name, tradeRef: r.trade_ref }));
}

/* ------------------------------------------------------------------ *
 * A sent quote                                                         *
 * ------------------------------------------------------------------ */

export interface DeskQuote {
  readonly quoteId: string;
  readonly ref: string;
  readonly requestId: string;
  readonly requestRef: string;
  readonly status: 'DRAFT' | 'SENT' | 'ACCEPTED' | 'EXPIRED' | 'REJECTED' | 'CANCELLED';
  readonly clientId: string;
  readonly clientName: string;
  readonly direction: DirectionValue;
  readonly base: string;
  readonly quoteInr: string;
  readonly clientRate: string;
  readonly sentAt: string | null;
  readonly sentByLabel: string | null;
  readonly expiresAt: string | null;
  readonly destination: string;
  /** The shareable link, if one was made: never its token (only its hash is stored), only what it has seen. */
  readonly link: { readonly createdAt: string; readonly openCount: number; readonly firstOpenedAt: string | null; readonly revoked: boolean } | null;
  readonly tradeRef: string | null;
  /** Economics-gated: the route the quote was priced on and what it would make. */
  readonly routeName?: string;
  readonly routeRate?: string;
  readonly margin?: string;
}

/**
 * One quote as the desk sees it while the client decides. The client rate is not economics — the client sees it
 * too — but the route and the margin are, so they are absent without `economics:view`.
 */
export async function deskQuote(ex: Executor, quoteId: string, access: DeskAccess): Promise<DeskQuote> {
  const id = requireUuid(quoteId, 'quoteId');
  const r = await sql<{
    id: string; ref: string; trade_request_id: string; request_ref: string; status: DeskQuote['status']; client_id: string; client_name: string;
    direction: DirectionValue; base_minor: bigint; quote_inr_minor: bigint; client_rate_micro: bigint; route_rate_micro: bigint; gross_margin_inr_minor: bigint;
    route_name: string; sent_at: Date | null; sent_by: string | null; sent_label: string | null; expires_at: Date | null;
    bank_name: string | null; ifsc: string | null; account_last4: string | null; wallet_address: string | null; wallet_label: string | null;
    link_created_at: Date | null; open_count: number | null; first_opened_at: Date | null; revoked_at: Date | null; trade_ref: string | null;
  }>`
    select q.id, q.ref, q.trade_request_id, r.ref as request_ref, q.status, q.client_id, c.display_name as client_name, q.direction,
           q.base_minor, q.quote_inr_minor, q.client_rate_micro, q.route_rate_micro, q.gross_margin_inr_minor, rt.name as route_name,
           q.sent_at, q.sent_by, coalesce(u.name, u.email) as sent_label, q.expires_at,
           b.bank_name, b.ifsc, b.account_last4, w.address as wallet_address, w.label as wallet_label,
           l.created_at as link_created_at, l.open_count, l.first_opened_at, l.revoked_at,
           (select t.ref from trade t where t.quote_id = q.id) as trade_ref
    from quote q
    join trade_request r on r.id = q.trade_request_id
    join client c on c.id = q.client_id
    join liquidity_route rt on rt.id = q.route_id
    left join bank_account b on b.id = q.bank_account_id
    left join crypto_wallet w on w.id = q.crypto_wallet_id
    left join quote_link l on l.quote_id = q.id
    left join auth_user u on u.id::text = q.sent_by
    where q.id = ${id}`.execute(ex);
  const q = r.rows[0];
  if (!q) throw new DomainError('NOT_FOUND', 'quote not found');
  const base: DeskQuote = {
    quoteId: q.id,
    ref: q.ref,
    requestId: q.trade_request_id,
    requestRef: q.request_ref,
    status: q.status,
    clientId: q.client_id,
    clientName: q.client_name,
    direction: q.direction,
    base: Money.ofMinor(q.base_minor, 'USDT').toDecimalString(),
    quoteInr: Money.ofMinor(q.quote_inr_minor, 'INR').toDecimalString(),
    clientRate: microToDecimal(q.client_rate_micro),
    sentAt: q.sent_at ? q.sent_at.toISOString() : null,
    sentByLabel: label(q.sent_by, q.sent_label),
    expiresAt: q.expires_at ? q.expires_at.toISOString() : null,
    destination: q.bank_name ? `${q.bank_name} · ${q.ifsc} · ••••${q.account_last4}` : q.wallet_address ? `${q.wallet_label ?? 'Wallet'} · ${q.wallet_address}` : 'no destination',
    link: q.link_created_at
      ? { createdAt: q.link_created_at.toISOString(), openCount: q.open_count ?? 0, firstOpenedAt: q.first_opened_at ? q.first_opened_at.toISOString() : null, revoked: q.revoked_at !== null }
      : null,
    tradeRef: q.trade_ref,
  };
  if (!access.economics) return base;
  return { ...base, routeName: q.route_name, routeRate: microToDecimal(q.route_rate_micro), margin: Money.ofMinor(q.gross_margin_inr_minor, 'INR').toDecimalString() };
}

/* ------------------------------------------------------------------ *
 * The shell's own figures                                              *
 * ------------------------------------------------------------------ */

/** The business clock (`inrp2p_now()`), so every age and countdown on a page is measured the way the server measures it. */
export async function deskNow(ex: Executor): Promise<string> {
  const r = await sql<{ now: Date }>`select inrp2p_now() as now`.execute(ex);
  return r.rows[0]!.now.toISOString();
}

/** Counts for the navigation: open cases (and how many hold a trade or block), and decisions waiting for a second person. */
export async function deskBadges(ex: Executor): Promise<{ readonly openCases: number; readonly blockingCases: number; readonly approvals: number }> {
  const r = await sql<{ open_cases: string; blocking: string; approvals: string }>`
    select (select count(*) from exception_case where status in ('OPEN', 'IN_PROGRESS'))::text as open_cases,
           (select count(*) from exception_case where status in ('OPEN', 'IN_PROGRESS') and severity = 'BLOCKING')::text as blocking,
           ((select count(*) from financial_adjustment where status = 'REQUESTED')
             + (select count(*) from settlement_leg where side = 'REFUND_TO_CLIENT' and status in ('PENDING', 'PROCESSING')))::text as approvals`.execute(ex);
  const row = r.rows[0]!;
  return { openCases: Number.parseInt(row.open_cases, 10), blockingCases: Number.parseInt(row.blocking, 10), approvals: Number.parseInt(row.approvals, 10) };
}
