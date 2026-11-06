import { sql } from 'kysely';
import { DomainError, Money, optionalText, parseTronAddress, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import { type DirectionValue, type RouteStatus, type SettlementModel, type Tx, type TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { actorLabel } from '@inrp2p/identity';

export interface RouteView {
  readonly id: string;
  readonly name: string;
  /** Set when the route is a trader's own (docs/TRADERS.md). */
  readonly traderId: string | null;
  readonly direction: DirectionValue | 'BOTH';
  readonly status: RouteStatus;
  readonly settlementModel: SettlementModel;
  readonly availableBase: Money<'USDT'>;
  readonly version: number;
}

/**
 * Precondition shared by rate publishing and quote creation: the route is ACTIVE, uses an implemented settlement
 * model and serves the direction. Takes a share lock so a concurrent status change waits for the caller's commit.
 */
export async function requireUsableRoute(tx: Tx, routeId: string, direction: DirectionValue): Promise<RouteView> {
  const r = await tx.selectFrom('liquidity_route').selectAll().where('id', '=', requireUuid(routeId, 'routeId')).forShare().executeTakeFirst();
  if (!r) throw new DomainError('NOT_FOUND', 'route not found');
  if (r.status !== 'ACTIVE') throw new DomainError('ROUTE_INACTIVE', `route is ${r.status}`);
  if (r.settlement_model !== 'PER_TRADE') throw new DomainError('ROUTE_SETTLEMENT_MODEL_UNSUPPORTED', `route uses ${r.settlement_model}`);
  if (r.direction !== 'BOTH' && r.direction !== direction) throw new DomainError('ROUTE_DIRECTION_MISMATCH', `route serves ${r.direction} only`);
  return { id: r.id, name: r.name, traderId: r.trader_id, direction: r.direction, status: r.status, settlementModel: r.settlement_model, availableBase: Money.ofMinor(r.available_base_minor, 'USDT'), version: r.version };
}

export interface OpenRouteObligationInput {
  readonly tradeId: string;
  readonly routeId: string;
  readonly direction: DirectionValue;
  readonly base: Money<'USDT'>;
  readonly routeValueInr: Money<'INR'>;
}

/**
 * Opens the PER_TRADE route obligation inside the acceptance transaction (D-03, FI-60). Amounts are the trade's frozen
 * economics; the database re-checks them against `trade_economics`.
 * SELL: exchange delivers base USDT, route delivers route value INR. BUY: exchange delivers route value INR,
 * route delivers base USDT.
 */
export async function openRouteObligation(ctx: TxContext, input: OpenRouteObligationInput): Promise<{ routeObligationId: string; ref: string }> {
  const sell = input.direction === 'SELL_USDT';
  const row = await ctx.tx
    .insertInto('route_obligation')
    .values({
      route_id: input.routeId,
      trade_id: input.tradeId,
      direction: input.direction,
      exchange_delivers_asset: sell ? 'USDT' : 'INR',
      exchange_delivers_minor: sell ? input.base.minor : input.routeValueInr.minor,
      route_delivers_asset: sell ? 'INR' : 'USDT',
      route_delivers_minor: sell ? input.routeValueInr.minor : input.base.minor,
      settlement_model: 'PER_TRADE',
      execution_mode: 'P2P',
      created_by: ctx.actor.id ?? 'SYSTEM',
    })
    .returning(['id', 'ref'])
    .executeTakeFirstOrThrow();
  await appendAudit(ctx, {
    action: 'route_obligation.created', entityType: 'route_obligation', entityId: row.id,
    after: { trade_id: input.tradeId, route_id: input.routeId, direction: input.direction, exchange_delivers: sell ? input.base : input.routeValueInr, route_delivers: sell ? input.routeValueInr : input.base },
  });
  return { routeObligationId: row.id, ref: row.ref };
}

/**
 * Opens a trader's own route for one direction, inside the trader approval command (docs/TRADERS.md), which has
 * already authorized the operator. A trader's route pays and is paid by the client directly (`P2P`, ADR 0019); the
 * database refuses any other shape (`liquidity_route_trader_shape`).
 */
export async function createTraderRoute(
  ctx: TxContext,
  input: { traderId: string; name: string; direction: DirectionValue; registeredRouteAddress: string; registeredPayoutIdentity: string },
): Promise<{ routeId: string }> {
  const row = await ctx.tx
    .insertInto('liquidity_route')
    .values({
      name: requireText(input.name, 'name', 80),
      direction: requireOneOf(input.direction, 'direction', ['SELL_USDT', 'BUY_USDT'] as const),
      settlement_model: 'PER_TRADE',
      execution_mode: 'P2P',
      registered_payout_identity: optionalText(input.registeredPayoutIdentity, 'registeredPayoutIdentity', 200),
      registered_route_address: parseTronAddress(input.registeredRouteAddress.trim()),
      available_base_minor: 0n,
      trader_id: requireUuid(input.traderId, 'traderId'),
      created_by: actorLabel(ctx),
    })
    .returning(['id', 'name', 'direction', 'execution_mode', 'registered_route_address'])
    .executeTakeFirstOrThrow();
  await appendAudit(ctx, { action: 'routes.created', entityType: 'liquidity_route', entityId: row.id, after: { ...row, trader_id: input.traderId } });
  return { routeId: row.id };
}

/**
 * Keeps a trader's routes pointing at its registered settlement details after an operator changed them: the
 * wallet the route delivers from and is paid to, and the bank identity its INR is expected from.
 */
export async function updateTraderRouteRegistration(ctx: TxContext, input: { traderId: string; registeredRouteAddress: string; registeredPayoutIdentity: string; reason: string }): Promise<{ updated: number }> {
  const routes = await ctx.tx.selectFrom('liquidity_route').selectAll().where('trader_id', '=', requireUuid(input.traderId, 'traderId')).orderBy('id').forUpdate().execute();
  const address = parseTronAddress(input.registeredRouteAddress.trim());
  for (const r of routes) {
    await ctx.tx
      .updateTable('liquidity_route')
      .set({ registered_route_address: address, registered_payout_identity: optionalText(input.registeredPayoutIdentity, 'registeredPayoutIdentity', 200), version: r.version + 1, updated_at: sql<Date>`statement_timestamp()` })
      .where('id', '=', r.id)
      .execute();
    await appendAudit(ctx, {
      action: 'routes.configured', entityType: 'liquidity_route', entityId: r.id,
      before: { registered_route_address: r.registered_route_address, registered_payout_identity: r.registered_payout_identity, version: r.version },
      after: { registered_route_address: address, registered_payout_identity: input.registeredPayoutIdentity, version: r.version + 1, reason: input.reason },
    });
  }
  return { updated: routes.length };
}
