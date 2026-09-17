import { sql } from 'kysely';
import { DomainError, Rate, requireOneOf, requireUuid } from '@inrp2p/kernel';
import type { DirectionValue, Executor, Tx, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { type OperatorActor, actorLabel, operatorCommand } from '@inrp2p/identity';
import { requireUsableRoute } from '@inrp2p/routes';

const DIRECTIONS = ['SELL_USDT', 'BUY_USDT'] as const;

export interface RouteRateSnapshot {
  readonly id: string;
  readonly routeId: string;
  readonly direction: DirectionValue;
  readonly rate: Rate<'ROUTE'>;
  readonly source: string;
  readonly effectiveAt: Date;
  /** Seconds between effective_at and database now; quote send compares this to the max snapshot age (Phase 3). */
  readonly ageSeconds: number;
}

export interface ReferenceRateSnapshot {
  readonly id: string;
  readonly direction: DirectionValue;
  readonly rate: Rate<'REFERENCE'>;
  readonly source: string;
  readonly effectiveAt: Date;
  readonly ageSeconds: number;
}

/** Serialises publishers of one series so `supersedes_id` always points at the series head. */
async function lockSeries(tx: Tx, key: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${`inrp2p.rate_series:${key}`}))`.execute(tx);
}

async function seriesHead(tx: Tx, kind: 'ROUTE' | 'REFERENCE', routeId: string | null, direction: DirectionValue) {
  let q = tx.selectFrom('rate_snapshot').select(['id', 'rate_micro']).where('kind', '=', kind).where('direction', '=', direction);
  q = routeId ? q.where('route_id', '=', routeId) : q.where('route_id', 'is', null);
  return q.orderBy('effective_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
}

/**
 * `rates.publish_route_rate` — `rates:update_route`. Appends a new ROUTE snapshot (FI-11): existing quotes and trades
 * keep the snapshot they copied. The route must be ACTIVE, PER_TRADE and serve the direction.
 */
export function publishRouteRate(actor: OperatorActor) {
  return operatorCommand(actor, 'rates:update_route', async (ctx, p: { routeId: string; direction: DirectionValue; rate: string }) => {
    const direction = requireOneOf(p.direction, 'direction', DIRECTIONS);
    const rate = Rate.parse(p.rate, 'ROUTE');
    const route = await requireUsableRoute(ctx.tx, p.routeId, direction);
    await lockSeries(ctx.tx, `ROUTE:${route.id}:${direction}`);
    const head = await seriesHead(ctx.tx, 'ROUTE', route.id, direction);
    const row = await ctx.tx
      .insertInto('rate_snapshot')
      .values({ kind: 'ROUTE', route_id: route.id, direction, rate_micro: rate.micro, source: 'OPERATOR', supersedes_id: head?.id ?? null, created_by: actorLabel(ctx) })
      .returning(['id', 'effective_at'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, {
      action: 'rate.changed', entityType: 'rate_snapshot', entityId: row.id,
      before: head ? { snapshot_id: head.id, rate: Rate.ofMicro(head.rate_micro, 'ROUTE') } : null,
      after: { kind: 'ROUTE', route_id: route.id, direction, rate, source: 'OPERATOR' },
    });
    return { snapshotId: row.id, supersedesId: head?.id ?? null };
  });
}

/** Records a REFERENCE rate (market context only; never used as client or route rate — FI-01). */
export async function recordReferenceRate(ctx: TxContext, input: { direction: DirectionValue; rate: Rate<'REFERENCE'>; source: 'OPERATOR' | `FEED:${string}` }): Promise<{ snapshotId: string }> {
  const direction = requireOneOf(input.direction, 'direction', DIRECTIONS);
  if (input.rate.kind !== 'REFERENCE') throw new DomainError('INVALID_RATE', 'reference snapshots accept REFERENCE rates only');
  if (!/^(OPERATOR|FEED:[a-z0-9_]{1,40})$/.test(input.source)) throw new DomainError('INVALID_ARGUMENT', 'invalid rate source');
  await lockSeries(ctx.tx, `REFERENCE:${direction}`);
  const head = await seriesHead(ctx.tx, 'REFERENCE', null, direction);
  const row = await ctx.tx
    .insertInto('rate_snapshot')
    .values({ kind: 'REFERENCE', route_id: null, direction, rate_micro: input.rate.micro, source: input.source, supersedes_id: head?.id ?? null, created_by: actorLabel(ctx) })
    .returning('id')
    .executeTakeFirstOrThrow();
  await appendAudit(ctx, { action: 'rate.reference_recorded', entityType: 'rate_snapshot', entityId: row.id, after: { direction, rate: input.rate, source: input.source } });
  return { snapshotId: row.id };
}

/** `rates.record_reference_rate` — `rates:update_route`; operator-entered reference rate. */
export function recordReferenceRateCommand(actor: OperatorActor) {
  return operatorCommand(actor, 'rates:update_route', async (ctx, p: { direction: DirectionValue; rate: string }) =>
    recordReferenceRate(ctx, { direction: p.direction, rate: Rate.parse(p.rate, 'REFERENCE'), source: 'OPERATOR' }),
  );
}

interface SnapshotRow {
  id: string;
  route_id: string | null;
  direction: DirectionValue;
  rate_micro: bigint;
  source: string;
  effective_at: Date;
  age_seconds: string;
}

/** Current route rate for a route and direction (latest effective snapshot), with its age in database time. */
export async function currentRouteRate(ex: Executor, routeId: string, direction: DirectionValue): Promise<RouteRateSnapshot | null> {
  const r = await sql<SnapshotRow>`
    select id, route_id, direction, rate_micro, source, effective_at,
           extract(epoch from (statement_timestamp() - effective_at))::bigint::text as age_seconds
    from rate_snapshot
    where kind = 'ROUTE' and route_id = ${requireUuid(routeId, 'routeId')} and direction = ${requireOneOf(direction, 'direction', DIRECTIONS)}
    order by effective_at desc, id desc limit 1`.execute(ex);
  const row = r.rows[0];
  if (!row) return null;
  return { id: row.id, routeId: row.route_id!, direction: row.direction, rate: Rate.ofMicro(row.rate_micro, 'ROUTE'), source: row.source, effectiveAt: row.effective_at, ageSeconds: parseInt(row.age_seconds, 10) };
}

export async function currentReferenceRate(ex: Executor, direction: DirectionValue): Promise<ReferenceRateSnapshot | null> {
  const r = await sql<SnapshotRow>`
    select id, route_id, direction, rate_micro, source, effective_at,
           extract(epoch from (statement_timestamp() - effective_at))::bigint::text as age_seconds
    from rate_snapshot
    where kind = 'REFERENCE' and direction = ${requireOneOf(direction, 'direction', DIRECTIONS)}
    order by effective_at desc, id desc limit 1`.execute(ex);
  const row = r.rows[0];
  if (!row) return null;
  return { id: row.id, direction: row.direction, rate: Rate.ofMicro(row.rate_micro, 'REFERENCE'), source: row.source, effectiveAt: row.effective_at, ageSeconds: parseInt(row.age_seconds, 10) };
}

/** Quote creation precondition (STATE_MACHINES §2 create → DRAFT): a current snapshot must exist. */
export async function requireCurrentRouteRate(ex: Executor, routeId: string, direction: DirectionValue): Promise<RouteRateSnapshot> {
  const s = await currentRouteRate(ex, routeId, direction);
  if (!s) throw new DomainError('ROUTE_RATE_MISSING', 'no route rate snapshot for this route and direction');
  return s;
}
