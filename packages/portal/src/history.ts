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
}

export interface HistoryQuery {
  readonly limit?: number;
  /** `open` is everything still in flight; `completed` is the archive. Omitted means both, newest first. */
  readonly filter?: 'open' | 'completed';
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
    })),
  );
}
