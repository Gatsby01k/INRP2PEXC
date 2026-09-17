import { sql } from 'kysely';
import { DomainError, Money, optionalText, parseTronAddress, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import { type DirectionValue, type ExecutionMode, type Executor, type RouteStatus, type SettlementModel, type Tx, isUniqueViolation, pgErrorCode } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { type OperatorActor, actorLabel, operatorCommand } from '@inrp2p/identity';

/** Settlement models implemented in V1 (FI-63). The schema knows all three; only these are accepted. */
export const IMPLEMENTED_SETTLEMENT_MODELS: readonly SettlementModel[] = Object.freeze(['PER_TRADE']);
const ALL_MODELS = ['PER_TRADE', 'PREFUNDED', 'NET_SETTLED'] as const;

function acceptedModel(value: unknown): SettlementModel {
  const model = requireOneOf(value, 'settlementModel', ALL_MODELS);
  if (!IMPLEMENTED_SETTLEMENT_MODELS.includes(model)) {
    throw new DomainError('ROUTE_SETTLEMENT_MODEL_UNSUPPORTED', `settlement model ${model} is not implemented in V1; only PER_TRADE is accepted`, { model });
  }
  return model;
}

export interface CreateRoutePayload {
  readonly name: string;
  readonly direction: DirectionValue | 'BOTH';
  readonly settlementModel?: SettlementModel;
  readonly executionMode: ExecutionMode;
  readonly registeredPayoutIdentity?: string | null;
  readonly registeredRouteAddress?: string | null;
  readonly availableBaseUsdt?: string;
  readonly notes?: string | null;
}

function baseAmount(value: string | undefined): bigint {
  if (value === undefined) return 0n;
  const m = Money.parse(value, 'USDT');
  if (m.isNegative()) throw new DomainError('INVALID_AMOUNT', 'available base must not be negative');
  return m.minor;
}

/** `routes.create` — `routes:configure` (⧗). */
export function createRoute(actor: OperatorActor) {
  return operatorCommand(actor, 'routes:configure', async (ctx, p: CreateRoutePayload) => {
    const settlementModel = acceptedModel(p.settlementModel ?? 'PER_TRADE');
    let row;
    try {
      row = await ctx.tx
        .insertInto('liquidity_route')
        .values({
          name: requireText(p.name, 'name', 80),
          direction: requireOneOf(p.direction, 'direction', ['SELL_USDT', 'BUY_USDT', 'BOTH'] as const),
          settlement_model: settlementModel,
          execution_mode: requireOneOf(p.executionMode, 'executionMode', ['DIRECT_TO_CLIENT', 'TO_EXCHANGE'] as const),
          registered_payout_identity: optionalText(p.registeredPayoutIdentity, 'registeredPayoutIdentity', 200),
          registered_route_address: p.registeredRouteAddress ? parseTronAddress(p.registeredRouteAddress.trim()) : null,
          available_base_minor: baseAmount(p.availableBaseUsdt),
          notes: optionalText(p.notes, 'notes'),
          created_by: actorLabel(ctx),
        })
        .returning(['id', 'name', 'direction', 'status', 'settlement_model', 'execution_mode', 'registered_route_address', 'available_base_minor'])
        .executeTakeFirstOrThrow();
    } catch (e) {
      if (isUniqueViolation(e)) throw new DomainError('INVALID_ARGUMENT', 'route name already in use');
      throw e;
    }
    await appendAudit(ctx, { action: 'routes.created', entityType: 'liquidity_route', entityId: row.id, after: row });
    return { routeId: row.id };
  });
}

async function lockRoute(tx: Tx, routeId: string) {
  const row = await tx.selectFrom('liquidity_route').selectAll().where('id', '=', requireUuid(routeId, 'routeId')).forUpdate().executeTakeFirst();
  if (!row) throw new DomainError('NOT_FOUND', 'route not found');
  return row;
}

/**
 * `routes.set_settlement_model` — `routes:configure` (⧗). Rejects models not implemented in V1 before touching the
 * row; the database constraint `liquidity_route_v1_per_trade_only` rejects them independently.
 */
export function setSettlementModel(actor: OperatorActor) {
  return operatorCommand(actor, 'routes:configure', async (ctx, p: { routeId: string; settlementModel: SettlementModel; reason: string }) => {
    const model = acceptedModel(p.settlementModel);
    const reason = requireText(p.reason, 'reason', 500);
    const before = await lockRoute(ctx.tx, p.routeId);
    if (before.settlement_model === model) return { changed: false };
    try {
      await ctx.tx.updateTable('liquidity_route').set({ settlement_model: model, version: before.version + 1, updated_at: sql<Date>`statement_timestamp()` }).where('id', '=', before.id).execute();
    } catch (e) {
      if (pgErrorCode(e) === '23514') throw new DomainError('ROUTE_SETTLEMENT_MODEL_UNSUPPORTED', `settlement model ${model} is not implemented`);
      throw e;
    }
    await appendAudit(ctx, { action: 'routes.settlement_model_changed', entityType: 'liquidity_route', entityId: before.id, before: { settlement_model: before.settlement_model }, after: { settlement_model: model, reason } });
    return { changed: true };
  });
}

export interface ConfigureRoutePayload {
  readonly routeId: string;
  readonly expectedVersion: number;
  readonly executionMode?: ExecutionMode;
  readonly registeredPayoutIdentity?: string | null;
  readonly registeredRouteAddress?: string | null;
  readonly availableBaseUsdt?: string;
  readonly notes?: string | null;
  readonly reason: string;
}

/**
 * `routes.configure` — `routes:configure` (⧗). The execution mode applies to trades accepted afterwards; accepted
 * trades keep the mode frozen at acceptance (D-14, FI-60).
 */
export function configureRoute(actor: OperatorActor) {
  return operatorCommand(actor, 'routes:configure', async (ctx, p: ConfigureRoutePayload) => {
    const reason = requireText(p.reason, 'reason', 500);
    const before = await lockRoute(ctx.tx, p.routeId);
    if (before.version !== p.expectedVersion) throw new DomainError('STALE_VERSION', `route is at version ${before.version}`);
    const changes = {
      ...(p.executionMode !== undefined ? { execution_mode: requireOneOf(p.executionMode, 'executionMode', ['DIRECT_TO_CLIENT', 'TO_EXCHANGE'] as const) } : {}),
      ...(p.registeredPayoutIdentity !== undefined ? { registered_payout_identity: optionalText(p.registeredPayoutIdentity, 'registeredPayoutIdentity', 200) } : {}),
      ...(p.registeredRouteAddress !== undefined ? { registered_route_address: p.registeredRouteAddress ? parseTronAddress(p.registeredRouteAddress.trim()) : null } : {}),
      ...(p.availableBaseUsdt !== undefined ? { available_base_minor: baseAmount(p.availableBaseUsdt) } : {}),
      ...(p.notes !== undefined ? { notes: optionalText(p.notes, 'notes') } : {}),
    };
    const after = await ctx.tx
      .updateTable('liquidity_route')
      .set({ ...changes, version: before.version + 1, updated_at: sql<Date>`statement_timestamp()` })
      .where('id', '=', before.id)
      .returning(['execution_mode', 'registered_payout_identity', 'registered_route_address', 'available_base_minor', 'notes', 'version'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, {
      action: before.execution_mode !== after.execution_mode ? 'routes.execution_mode_changed' : 'routes.configured',
      entityType: 'liquidity_route', entityId: before.id,
      before: { execution_mode: before.execution_mode, registered_payout_identity: before.registered_payout_identity, registered_route_address: before.registered_route_address, available_base_minor: before.available_base_minor, notes: before.notes, version: before.version },
      after: { ...after, reason },
    });
    return { version: after.version };
  });
}

/** `routes.set_status` — `routes:configure` (⧗). RETIRED is terminal. */
export function setRouteStatus(actor: OperatorActor) {
  return operatorCommand(actor, 'routes:configure', async (ctx, p: { routeId: string; status: RouteStatus; reason: string }) => {
    const status = requireOneOf(p.status, 'status', ['ACTIVE', 'PAUSED', 'RETIRED'] as const);
    const reason = requireText(p.reason, 'reason', 500);
    const before = await lockRoute(ctx.tx, p.routeId);
    if (before.status === status) return { changed: false };
    if (before.status === 'RETIRED') throw new DomainError('INVALID_TRANSITION', 'route is retired');
    await ctx.tx.updateTable('liquidity_route').set({ status, version: before.version + 1, updated_at: sql<Date>`statement_timestamp()` }).where('id', '=', before.id).execute();
    await appendAudit(ctx, { action: 'routes.status_changed', entityType: 'liquidity_route', entityId: before.id, before: { status: before.status }, after: { status, reason } });
    return { changed: true };
  });
}

export interface RouteView {
  readonly id: string;
  readonly name: string;
  readonly direction: DirectionValue | 'BOTH';
  readonly status: RouteStatus;
  readonly settlementModel: SettlementModel;
  readonly executionMode: ExecutionMode;
  readonly availableBase: Money<'USDT'>;
  readonly version: number;
}

/** Operator-only read model (never serialized to client surfaces; callers must hold `economics:view` or `route_positions:view`). */
export async function getRoute(ex: Executor, routeId: string): Promise<RouteView> {
  const r = await ex.selectFrom('liquidity_route').selectAll().where('id', '=', requireUuid(routeId, 'routeId')).executeTakeFirst();
  if (!r) throw new DomainError('NOT_FOUND', 'route not found');
  return { id: r.id, name: r.name, direction: r.direction, status: r.status, settlementModel: r.settlement_model, executionMode: r.execution_mode, availableBase: Money.ofMinor(r.available_base_minor, 'USDT'), version: r.version };
}

/**
 * Precondition shared by rate publishing and quote creation: the route is ACTIVE, uses an implemented settlement
 * model and serves the direction. Takes a share lock so a concurrent status change waits for the caller's commit.
 */
export async function requireUsableRoute(tx: Tx, routeId: string, direction: DirectionValue): Promise<RouteView> {
  const r = await tx.selectFrom('liquidity_route').selectAll().where('id', '=', requireUuid(routeId, 'routeId')).forShare().executeTakeFirst();
  if (!r) throw new DomainError('NOT_FOUND', 'route not found');
  if (r.status !== 'ACTIVE') throw new DomainError('ROUTE_INACTIVE', `route is ${r.status}`);
  if (!IMPLEMENTED_SETTLEMENT_MODELS.includes(r.settlement_model)) throw new DomainError('ROUTE_SETTLEMENT_MODEL_UNSUPPORTED', `route uses ${r.settlement_model}`);
  if (r.direction !== 'BOTH' && r.direction !== direction) throw new DomainError('ROUTE_DIRECTION_MISMATCH', `route serves ${r.direction} only`);
  return { id: r.id, name: r.name, direction: r.direction, status: r.status, settlementModel: r.settlement_model, executionMode: r.execution_mode, availableBase: Money.ofMinor(r.available_base_minor, 'USDT'), version: r.version };
}
