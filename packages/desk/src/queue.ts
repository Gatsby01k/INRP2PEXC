import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import type { DirectionValue, Executor } from '@inrp2p/db';
import type { DeskAccess } from './access.ts';
import { microToDecimal } from './strip.ts';

export type QueueGroupKey = 'needs_action' | 'exception' | 'settlement' | 'waiting_client' | 'processing';

/** What the row's next action is. The page turns this into a button and a keyboard shortcut. */
export type QueueAction =
  | 'QUOTE'
  | 'CREATE_PAYOUT'
  | 'CONFIRM_INCOMING'
  | 'RECORD_EVIDENCE'
  | 'CONFIRM_PAYOUT'
  | 'RESOLVE_EXCEPTION'
  | 'COPY_LINK'
  | 'NONE';

export interface QueueRow {
  /** Stable row id: `request:{id}`, `quote:{id}` or `trade:{id}`. */
  readonly id: string;
  readonly subject: { readonly kind: 'REQUEST' | 'QUOTE' | 'TRADE'; readonly id: string; readonly ref: string };
  readonly clientId: string;
  readonly clientName: string;
  readonly direction: DirectionValue;
  /** Decimal USDT of the trade or request; null when a request fixed the INR side instead. */
  readonly baseUsdt: string | null;
  readonly quoteInr: string | null;
  /** What the client asked for, when they named a target. Economics-gated. */
  readonly clientRate?: string | null;
  readonly routeRate?: string | null;
  readonly margin?: string | null;
  /** Short status phrase, already domain-accurate ("USDT confirmed", "Short by 50 USDT"). */
  readonly status: string;
  readonly action: QueueAction;
  readonly hold: boolean;
  /** Sort key within a group: oldest work first. */
  readonly since: string;
}

export interface QueueGroup {
  readonly key: QueueGroupKey;
  readonly rows: readonly QueueRow[];
}

export const QUEUE_ORDER: readonly QueueGroupKey[] = ['needs_action', 'exception', 'settlement', 'waiting_client', 'processing'];

interface RawRow {
  kind: 'REQUEST' | 'QUOTE' | 'TRADE';
  id: string;
  ref: string;
  client_id: string;
  client_name: string;
  direction: DirectionValue;
  base_minor: bigint | null;
  quote_minor: bigint | null;
  client_rate_micro: bigint | null;
  route_rate_micro: bigint | null;
  margin_minor: bigint | null;
  lifecycle: string | null;
  hold: boolean;
  since: Date;
  /** Payout legs in flight on this trade. */
  legs_processing: number;
  legs_pending: number;
  /** Whether a payout leg in flight already carries its evidence. */
  legs_with_evidence: number;
  paid_minor: bigint;
  committed_minor: bigint;
  payout_minor: bigint | null;
  blocking_case: string | null;
  case_detail: string | null;
  expires_at: Date | null;
  has_link: boolean;
}

/**
 * The desk queue (UX_FLOWS W5). One query per subject kind, then one ordering rule: work that is waiting on
 * *us* comes first, exceptions next, then money in flight, then work waiting on the client, then what the
 * machines are still doing. Nothing here decides anything — every row names the command the operator would run,
 * and that command authorizes itself.
 */
export async function deskQueue(ex: Executor, access: DeskAccess, opts: { limitPerGroup?: number } = {}): Promise<readonly QueueGroup[]> {
  const limit = opts.limitPerGroup ?? 50;

  const requests = await sql<RawRow>`
    select 'REQUEST' as kind, r.id, r.ref, r.client_id, c.display_name as client_name, r.direction,
           r.requested_base_minor as base_minor, r.requested_quote_minor as quote_minor,
           r.target_rate_micro as client_rate_micro, null::bigint as route_rate_micro, null::bigint as margin_minor,
           null::text as lifecycle, false as hold, r.created_at as since,
           0 as legs_processing, 0 as legs_pending, 0 as legs_with_evidence,
           0::bigint as paid_minor, 0::bigint as committed_minor, null::bigint as payout_minor,
           null::text as blocking_case, null::text as case_detail, null::timestamptz as expires_at, false as has_link
    from trade_request r join client c on c.id = r.client_id
    where r.status = 'OPEN'
    order by r.created_at
    limit ${limit}`.execute(ex);

  const quotes = await sql<RawRow>`
    select 'QUOTE' as kind, q.id, q.ref, q.client_id, c.display_name as client_name, q.direction,
           q.base_minor, q.quote_inr_minor as quote_minor, q.client_rate_micro, q.route_rate_micro,
           q.gross_margin_inr_minor as margin_minor,
           null::text as lifecycle, false as hold, q.sent_at as since,
           0 as legs_processing, 0 as legs_pending, 0 as legs_with_evidence,
           0::bigint as paid_minor, 0::bigint as committed_minor, null::bigint as payout_minor,
           null::text as blocking_case, null::text as case_detail, q.expires_at,
           exists (select 1 from quote_link l where l.quote_id = q.id and l.revoked_at is null) as has_link
    from quote q join client c on c.id = q.client_id
    where q.status = 'SENT' and q.expires_at > inrp2p_now()
    order by q.expires_at
    limit ${limit}`.execute(ex);

  const trades = await sql<RawRow>`
    select 'TRADE' as kind, t.id, t.ref, t.client_id, c.display_name as client_name, t.direction,
           e.base_minor, e.quote_inr_minor as quote_minor, e.client_rate_micro, e.route_rate_micro,
           e.gross_margin_inr_minor as margin_minor,
           t.lifecycle_state as lifecycle, t.hold, t.opened_at as since,
           (select count(*) from settlement_leg l where l.trade_id = t.id and l.side = 'EXCHANGE_TO_CLIENT' and l.status = 'PROCESSING')::int as legs_processing,
           (select count(*) from settlement_leg l where l.trade_id = t.id and l.side = 'EXCHANGE_TO_CLIENT' and l.status = 'PENDING')::int as legs_pending,
           (select count(*) from settlement_leg l
              join transfer_allocation a on a.settlement_leg_id = l.id and a.voided_at is null
             where l.trade_id = t.id and l.side = 'EXCHANGE_TO_CLIENT' and l.status = 'PROCESSING')::int as legs_with_evidence,
           coalesce((select sum(l.amount_minor) from settlement_leg l
                      where l.trade_id = t.id and l.side = 'EXCHANGE_TO_CLIENT' and l.status = 'COMPLETED'), 0)::bigint as paid_minor,
           coalesce((select sum(l.amount_minor) from settlement_leg l
                      where l.trade_id = t.id and l.side = 'EXCHANGE_TO_CLIENT' and l.status in ('PENDING', 'PROCESSING', 'COMPLETED')), 0)::bigint as committed_minor,
           inrp2p_trade_payout_obligation(t.id) as payout_minor,
           (select x.type from exception_case x
             where x.trade_id = t.id and x.status in ('OPEN', 'IN_PROGRESS') and x.severity = 'BLOCKING'
             order by x.opened_at limit 1) as blocking_case,
           (select x.details::text from exception_case x
             where x.trade_id = t.id and x.status in ('OPEN', 'IN_PROGRESS') and x.severity = 'BLOCKING'
             order by x.opened_at limit 1) as case_detail,
           null::timestamptz as expires_at, false as has_link
    from trade t
    join client c on c.id = t.client_id
    join trade_economics e on e.trade_id = t.id
    where t.lifecycle_state not in ('COMPLETED', 'CANCELLED')
    order by t.opened_at
    limit ${limit * 3}`.execute(ex);

  const rows: { group: QueueGroupKey; row: QueueRow }[] = [];
  for (const r of requests.rows) rows.push({ group: 'needs_action', row: view(r, access, 'New request', 'QUOTE') });
  for (const r of quotes.rows) rows.push({ group: 'waiting_client', row: view(r, access, 'Quote sent', r.has_link ? 'COPY_LINK' : 'NONE') });
  for (const r of trades.rows) {
    const placed = classifyTrade(r);
    rows.push({ group: placed.group, row: view(r, access, placed.status, placed.action) });
  }

  return QUEUE_ORDER.map((key) => ({
    key,
    rows: rows
      .filter((r) => r.group === key)
      .map((r) => r.row)
      .sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0))
      .slice(0, limit),
  })).filter((g) => g.rows.length > 0);
}

/** Where a trade belongs and what the desk would do next with it. */
function classifyTrade(r: RawRow): { group: QueueGroupKey; status: string; action: QueueAction } {
  if (r.hold || r.blocking_case) {
    return { group: 'exception', status: exceptionLabel(r), action: 'RESOLVE_EXCEPTION' };
  }
  const sell = r.direction === 'SELL_USDT';
  switch (r.lifecycle) {
    case 'AWAITING_FIRST_LEG':
      return { group: 'waiting_client', status: sell ? 'Awaiting USDT' : 'Awaiting INR', action: 'NONE' };
    case 'FIRST_LEG_DETECTED':
      // SELL: the chain is still working. BUY: a human claimed an INR reference and must confirm it.
      return sell
        ? { group: 'processing', status: 'USDT detected · awaiting solidification', action: 'NONE' }
        : { group: 'needs_action', status: 'INR claimed', action: 'CONFIRM_INCOMING' };
    case 'FIRST_LEG_CONFIRMED':
      return { group: 'needs_action', status: sell ? 'USDT confirmed' : 'INR confirmed', action: 'CREATE_PAYOUT' };
    case 'SETTLING':
    case 'PARTIALLY_SETTLED': {
      if (r.legs_processing > 0) {
        return r.legs_with_evidence >= r.legs_processing
          ? { group: 'settlement', status: 'Payout in flight', action: 'CONFIRM_PAYOUT' }
          : { group: 'settlement', status: 'Payout sent · needs reference', action: 'RECORD_EVIDENCE' };
      }
      if (r.legs_pending > 0) return { group: 'settlement', status: 'Payout leg pending', action: 'RECORD_EVIDENCE' };
      const remaining = (r.payout_minor ?? 0n) - r.committed_minor;
      return remaining > 0n
        ? { group: 'needs_action', status: 'Payout remaining', action: 'CREATE_PAYOUT' }
        : { group: 'processing', status: 'Settling', action: 'NONE' };
    }
    default:
      return { group: 'processing', status: r.lifecycle ?? 'Open', action: 'NONE' };
  }
}

/** A blocking case is said plainly — "Short by 50 USDT" beats "USDT_WRONG_AMOUNT". */
function exceptionLabel(r: RawRow): string {
  const type = r.blocking_case;
  if (!type) return 'On hold';
  const detail = parseDetails(r.case_detail);
  const expected = typeof detail.expected === 'string' ? detail.expected : null;
  const received = typeof detail.received === 'string' ? detail.received : null;
  if (type === 'USDT_WRONG_AMOUNT' && expected && received) return `Short by ${difference(expected, received)} USDT`;
  if (type === 'USDT_OVERPAYMENT' && expected && received) return `Over by ${difference(received, expected)} USDT`;
  return HUMAN_CASE[type] ?? type.replace(/_/g, ' ').toLowerCase();
}

/** Case details are operator-entered JSON; an unreadable one must never take the queue down. */
function parseDetails(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const HUMAN_CASE: Record<string, string> = {
  USDT_UNEXPECTED_SENDER: 'Unregistered sender',
  WRONG_NETWORK: 'Wrong network',
  FUNDS_AFTER_TRADE_CLOSED: 'Funds after the trade closed',
  UNALLOCATED_DEPOSIT: 'Unallocated deposit',
  ROUTE_DIRECT_PAYOUT_MISMATCH: 'Route payout does not match the obligation',
  ROUTE_SETTLEMENT_MISMATCH: 'Route settlement mismatch',
  DUPLICATE_TX_HASH: 'Duplicate transaction',
  DUPLICATE_UTR: 'Duplicate UTR',
  BANK_TRANSFER_FAILED: 'Bank transfer failed',
  CLIENT_BANK_CHANGED: 'Client bank account changed',
  TRADE_CANCELLATION: 'Cancellation requested',
  OPERATOR_MISTAKE: 'Operator correction',
  RECONCILIATION_MISMATCH: 'Reconciliation mismatch',
};

/** Exact decimal difference of two USDT decimal strings (never floats). */
function difference(a: string, b: string): string {
  return Money.parse(a, 'USDT').sub(Money.parse(b, 'USDT')).toDecimalString();
}

function view(r: RawRow, access: DeskAccess, status: string, action: QueueAction): QueueRow {
  const row: QueueRow = {
    id: `${r.kind.toLowerCase()}:${r.id}`,
    subject: { kind: r.kind, id: r.id, ref: r.ref },
    clientId: r.client_id,
    clientName: r.client_name,
    direction: r.direction,
    baseUsdt: r.base_minor === null ? null : Money.ofMinor(r.base_minor, 'USDT').toDecimalString(),
    quoteInr: r.quote_minor === null ? null : Money.ofMinor(r.quote_minor, 'INR').toDecimalString(),
    status,
    action,
    hold: r.hold,
    since: r.since.toISOString(),
  };
  if (!access.economics) return row;
  return {
    ...row,
    clientRate: r.client_rate_micro === null ? null : microToDecimal(r.client_rate_micro),
    routeRate: r.route_rate_micro === null ? null : microToDecimal(r.route_rate_micro),
    margin: r.margin_minor === null ? null : Money.ofMinor(r.margin_minor, 'INR').toDecimalString(),
  };
}
