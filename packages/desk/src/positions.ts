import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import type { DirectionValue, ExecutionMode, Executor } from '@inrp2p/db';
import { obligationRemaining } from '@inrp2p/settlement';

export interface RouteSettlementRow {
  readonly id: string;
  readonly ref: string;
  readonly flow: 'FROM_ROUTE_TO_EXCHANGE' | 'TO_ROUTE' | 'DIRECT_TO_CLIENT';
  readonly side: 'ROUTE_DELIVERS' | 'EXCHANGE_DELIVERS';
  readonly asset: 'INR' | 'USDT';
  readonly amount: string;
  readonly status: 'RECORDED' | 'CONFIRMED' | 'FAILED';
  readonly reference: string | null;
  readonly confirmedAt: string | null;
  /**
   * A `DIRECT_TO_CLIENT` settlement was created by confirming a client payout leg, and is read-only here: it
   * cannot be recorded, confirmed or failed from this screen without breaking FI-64 (Phase 4 §11).
   */
  readonly readOnly: boolean;
  readonly legRef: string | null;
}

export interface RoutePosition {
  readonly obligationId: string;
  readonly ref: string;
  readonly routeId: string;
  readonly routeName: string;
  readonly tradeId: string | null;
  readonly tradeRef: string | null;
  readonly clientName: string | null;
  readonly direction: DirectionValue;
  readonly executionMode: ExecutionMode;
  readonly status: 'OPEN' | 'PARTIALLY_SETTLED' | 'SETTLED' | 'CANCELLED';
  readonly openedAt: string;
  readonly routeDelivers: { readonly amount: string; readonly currency: 'INR' | 'USDT' };
  readonly routeDeliversRemaining: { readonly amount: string; readonly currency: 'INR' | 'USDT' };
  readonly exchangeDelivers: { readonly amount: string; readonly currency: 'INR' | 'USDT' };
  readonly exchangeDeliversRemaining: { readonly amount: string; readonly currency: 'INR' | 'USDT' };
  readonly settlements: readonly RouteSettlementRow[];
}

/**
 * Rates → Route positions (UX_FLOWS F5b), for operators with `route_positions:view`. Each obligation shows both
 * sides and what is left of each, measured the way FI-64 measures it — frozen economics ⊕ posted adjustments,
 * minus confirmed allocations — so the screen and the reconciliation job can never disagree.
 */
export async function routePositions(ex: Executor, opts: { status?: 'OPEN' | 'ALL'; routeId?: string; limit?: number } = {}): Promise<readonly RoutePosition[]> {
  const openOnly = (opts.status ?? 'OPEN') === 'OPEN';
  const rows = await sql<{
    id: string; ref: string; route_id: string; route_name: string; trade_id: string | null; trade_ref: string | null;
    client_name: string | null; direction: DirectionValue; execution_mode: ExecutionMode;
    status: RoutePosition['status']; opened_at: Date;
    route_delivers_asset: 'INR' | 'USDT'; route_delivers_minor: bigint;
    exchange_delivers_asset: 'INR' | 'USDT'; exchange_delivers_minor: bigint;
  }>`
    select o.id, o.ref, o.route_id, r.name as route_name, o.trade_id, t.ref as trade_ref, c.display_name as client_name,
           o.direction, o.execution_mode, o.status, o.opened_at,
           o.route_delivers_asset, o.route_delivers_minor, o.exchange_delivers_asset, o.exchange_delivers_minor
    from route_obligation o
    join liquidity_route r on r.id = o.route_id
    left join trade t on t.id = o.trade_id
    left join client c on c.id = t.client_id
    where (${openOnly}::boolean = false or o.status in ('OPEN', 'PARTIALLY_SETTLED'))
      and (${opts.routeId ?? null}::uuid is null or o.route_id = ${opts.routeId ?? null}::uuid)
    order by o.opened_at
    limit ${opts.limit ?? 100}`.execute(ex);

  const out: RoutePosition[] = [];
  for (const o of rows.rows) {
    const remaining = await obligationRemaining(ex, o.id);
    out.push({
      obligationId: o.id,
      ref: o.ref,
      routeId: o.route_id,
      routeName: o.route_name,
      tradeId: o.trade_id,
      tradeRef: o.trade_ref,
      clientName: o.client_name,
      direction: o.direction,
      executionMode: o.execution_mode,
      status: o.status,
      openedAt: o.opened_at.toISOString(),
      routeDelivers: Money.ofMinor(o.route_delivers_minor, o.route_delivers_asset).toJSON(),
      routeDeliversRemaining: remaining.routeDelivers.toJSON(),
      exchangeDelivers: Money.ofMinor(o.exchange_delivers_minor, o.exchange_delivers_asset).toJSON(),
      exchangeDeliversRemaining: remaining.exchangeDelivers.toJSON(),
      settlements: await settlementsOf(ex, o.id),
    });
  }
  return out;
}

async function settlementsOf(ex: Executor, obligationId: string): Promise<readonly RouteSettlementRow[]> {
  const rows = await sql<{
    id: string; ref: string; flow: RouteSettlementRow['flow']; obligation_side: RouteSettlementRow['side'];
    asset: 'INR' | 'USDT'; amount_minor: bigint; status: RouteSettlementRow['status'];
    utr: string | null; tx_hash: string | null; confirmed_at: Date | null; leg_ref: string | null;
  }>`
    select s.id, s.ref, s.flow, s.obligation_side, s.asset, s.amount_minor, s.status,
           f.utr, c.tx_hash, s.confirmed_at,
           (select l.ref from transfer_allocation a
              join settlement_leg l on l.id = a.settlement_leg_id
             where a.voided_at is null
               and ((s.fiat_transfer_id is not null and a.fiat_transfer_id = s.fiat_transfer_id)
                 or (s.crypto_transfer_id is not null and a.crypto_transfer_id = s.crypto_transfer_id))
             limit 1) as leg_ref
    from route_settlement s
    left join fiat_transfer f on f.id = s.fiat_transfer_id
    left join crypto_transfer c on c.id = s.crypto_transfer_id
    where s.route_obligation_id = ${obligationId}
    order by s.recorded_at`.execute(ex);
  return rows.rows.map((r) => ({
    id: r.id,
    ref: r.ref,
    flow: r.flow,
    side: r.obligation_side,
    asset: r.asset,
    amount: Money.ofMinor(r.amount_minor, r.asset).toDecimalString(),
    status: r.status,
    reference: r.utr ?? r.tx_hash ?? null,
    confirmedAt: r.confirmed_at ? r.confirmed_at.toISOString() : null,
    readOnly: r.flow === 'DIRECT_TO_CLIENT',
    legRef: r.leg_ref,
  }));
}
