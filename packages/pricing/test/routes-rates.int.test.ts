import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Rate, encodeTronAddress } from '@inrp2p/kernel';
import { pgErrorCode } from '@inrp2p/db';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { executeCommand } from '@inrp2p/commands';
import { createTestOperator, runAs, type TestOperator } from '@inrp2p/identity/testing';
import { configureRoute, createRoute, getRoute, requireUsableRoute, setRouteStatus, setSettlementModel } from '@inrp2p/routes';
import { currentReferenceRate, currentRouteRate, publishRouteRate, recordReferenceRate, recordReferenceRateCommand, requireCurrentRouteRate } from '../src/index.ts';

let t: TestDatabase;
let owner: TestOperator;
let dealer: TestOperator;
let finance: TestOperator;

beforeAll(async () => {
  t = await createTestDatabase('routes_rates');
  owner = await createTestOperator(t.owner, ['OWNER']);
  dealer = await createTestOperator(t.owner, ['DEALER']);
  finance = await createTestOperator(t.owner, ['FINANCE']);
});
afterAll(async () => t.close());

const newRoute = (overrides: Record<string, unknown> = {}) =>
  runAs(t.app, createRoute(owner.actor), owner.ref, 'routes.create', { name: `Route ${randomUUID().slice(0, 8)}`, direction: 'BOTH' as const, executionMode: 'DIRECT_TO_CLIENT' as const, registeredRouteAddress: encodeTronAddress(randomBytes(20)), availableBaseUsdt: '250000', ...overrides });

describe('liquidity routes (D-03, D-14, FI-63)', () => {
  it('creates PER_TRADE routes; configuring needs routes:configure with step-up (OWNER only)', async () => {
    const r = await newRoute();
    const view = await getRoute(t.app, r.routeId);
    expect(view).toMatchObject({ settlementModel: 'PER_TRADE', executionMode: 'DIRECT_TO_CLIENT', status: 'ACTIVE' });
    expect(view.availableBase.minor).toBe(250_000_000_000n);
    await expect(runAs(t.app, createRoute(dealer.actor), dealer.ref, 'routes.create', { name: 'x', direction: 'BOTH' as const, executionMode: 'TO_EXCHANGE' as const })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runAs(t.app, createRoute(finance.actor), finance.ref, 'routes.create', { name: 'x', direction: 'BOTH' as const, executionMode: 'TO_EXCHANGE' as const })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const staleOwner = await createTestOperator(t.owner, ['OWNER'], 'stale');
    await expect(runAs(t.app, createRoute(staleOwner.actor), staleOwner.ref, 'routes.create', { name: 'x', direction: 'BOTH' as const, executionMode: 'TO_EXCHANGE' as const })).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  it('exit: a non-PER_TRADE settlement model is rejected by the command and by the database', async () => {
    for (const model of ['PREFUNDED', 'NET_SETTLED'] as const) {
      await expect(newRoute({ settlementModel: model })).rejects.toMatchObject({ code: 'ROUTE_SETTLEMENT_MODEL_UNSUPPORTED' });
    }
    const r = await newRoute();
    await expect(runAs(t.app, setSettlementModel(owner.actor), owner.ref, 'routes.set_settlement_model', { routeId: r.routeId, settlementModel: 'PREFUNDED' as const, reason: 'try' })).rejects.toMatchObject({ code: 'ROUTE_SETTLEMENT_MODEL_UNSUPPORTED' });
    await expect(runAs(t.app, setSettlementModel(owner.actor), owner.ref, 'routes.set_settlement_model', { routeId: r.routeId, settlementModel: 'SOMETHING' as never, reason: 'try' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(sql`update liquidity_route set settlement_model = 'NET_SETTLED' where id = ${r.routeId}`.execute(t.app)).rejects.toSatisfy((e) => pgErrorCode(e) === '23514');
    await expect(sql`insert into liquidity_route (name, direction, settlement_model, execution_mode, created_by) values ('raw', 'BOTH', 'PREFUNDED', 'TO_EXCHANGE', 'x')`.execute(t.owner)).rejects.toThrow(/liquidity_route_v1_per_trade_only/);
    expect((await getRoute(t.app, r.routeId)).settlementModel).toBe('PER_TRADE');
    expect(await t.app.selectFrom('audit_event').select('action').where('entity_id', '=', r.routeId).where('action', '=', 'routes.settlement_model_changed').execute()).toEqual([]);
  });

  it('execution mode changes are versioned and audited; retired routes stay retired', async () => {
    const r = await newRoute();
    await runAs(t.app, configureRoute(owner.actor), owner.ref, 'routes.configure', { routeId: r.routeId, expectedVersion: 1, executionMode: 'TO_EXCHANGE' as const, reason: 'provider requires settlement to our accounts' });
    await expect(runAs(t.app, configureRoute(owner.actor), owner.ref, 'routes.configure', { routeId: r.routeId, expectedVersion: 1, notes: 'x', reason: 'stale' })).rejects.toMatchObject({ code: 'STALE_VERSION' });
    await expect(runAs(t.app, configureRoute(owner.actor), owner.ref, 'routes.configure', { routeId: r.routeId, expectedVersion: 2, registeredRouteAddress: 'TXqH2JBkDgGWyCFg4GZzg8eUjG5KdK9fA2', reason: 'bad address' })).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
    const audit = await t.app.selectFrom('audit_event').select(['action', 'before', 'after']).where('entity_id', '=', r.routeId).orderBy('seq').execute();
    expect(audit.map((a) => a.action)).toEqual(['routes.created', 'routes.execution_mode_changed']);
    await runAs(t.app, setRouteStatus(owner.actor), owner.ref, 'routes.set_status', { routeId: r.routeId, status: 'RETIRED' as const, reason: 'contract ended' });
    await expect(runAs(t.app, setRouteStatus(owner.actor), owner.ref, 'routes.set_status', { routeId: r.routeId, status: 'ACTIVE' as const, reason: 'undo' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(sql`update liquidity_route set status = 'ACTIVE' where id = ${r.routeId}`.execute(t.app)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX040');
  });

  it('usable-route precondition checks status and direction', async () => {
    const sell = await newRoute({ direction: 'SELL_USDT' });
    await t.app.transaction().execute(async (tx) => {
      await expect(requireUsableRoute(tx, sell.routeId, 'SELL_USDT')).resolves.toMatchObject({ id: sell.routeId });
    });
    await t.app.transaction().execute(async (tx) => {
      await expect(requireUsableRoute(tx, sell.routeId, 'BUY_USDT')).rejects.toMatchObject({ code: 'ROUTE_DIRECTION_MISMATCH' });
    });
    await runAs(t.app, setRouteStatus(owner.actor), owner.ref, 'routes.set_status', { routeId: sell.routeId, status: 'PAUSED' as const, reason: 'maintenance' });
    await t.app.transaction().execute(async (tx) => {
      await expect(requireUsableRoute(tx, sell.routeId, 'SELL_USDT')).rejects.toMatchObject({ code: 'ROUTE_INACTIVE' });
    });
  });
});

describe('rate snapshots (FI-01, FI-11)', () => {
  it('publishing appends a new snapshot chained to the previous one; the latest is current', async () => {
    const r = await newRoute();
    expect(await currentRouteRate(t.app, r.routeId, 'SELL_USDT')).toBeNull();
    await expect(requireCurrentRouteRate(t.app, r.routeId, 'SELL_USDT')).rejects.toMatchObject({ code: 'ROUTE_RATE_MISSING' });
    const a = await runAs(t.app, publishRouteRate(dealer.actor), dealer.ref, 'rates.publish_route_rate', { routeId: r.routeId, direction: 'SELL_USDT' as const, rate: '104.20' });
    const b = await runAs(t.app, publishRouteRate(dealer.actor), dealer.ref, 'rates.publish_route_rate', { routeId: r.routeId, direction: 'SELL_USDT' as const, rate: '104.35' });
    expect(a.supersedesId).toBeNull();
    expect(b.supersedesId).toBe(a.snapshotId);
    const current = await requireCurrentRouteRate(t.app, r.routeId, 'SELL_USDT');
    expect(current.id).toBe(b.snapshotId);
    expect(current.rate.micro).toBe(104_350_000n);
    expect(current.rate.kind).toBe('ROUTE');
    expect(current.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(await currentRouteRate(t.app, r.routeId, 'BUY_USDT')).toBeNull();
    const audit = await t.app.selectFrom('audit_event').select(['action', 'after']).where('entity_id', '=', b.snapshotId).executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ action: 'rate.changed', after: expect.objectContaining({ rate: { rate: '104.350000', kind: 'ROUTE' } }) });
  });

  it('exit: rate snapshots are append-only at the database', async () => {
    const r = await newRoute();
    const s = await runAs(t.app, publishRouteRate(dealer.actor), dealer.ref, 'rates.publish_route_rate', { routeId: r.routeId, direction: 'BUY_USDT' as const, rate: '100.00' });
    await expect(sql`update rate_snapshot set rate_micro = 1 where id = ${s.snapshotId}`.execute(t.app)).rejects.toThrow(/permission denied/);
    await expect(sql`update rate_snapshot set rate_micro = 1 where id = ${s.snapshotId}`.execute(t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX001');
    await expect(sql`delete from rate_snapshot where id = ${s.snapshotId}`.execute(t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX001');
    await expect(sql`truncate rate_snapshot cascade`.execute(t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX001');
    const other = await newRoute();
    await expect(sql`insert into rate_snapshot (kind, route_id, direction, rate_micro, source, supersedes_id, created_by) values ('ROUTE', ${other.routeId}, 'BUY_USDT', 1, 'OPERATOR', ${s.snapshotId}, 'x')`.execute(t.app)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX042');
    expect((await currentRouteRate(t.app, r.routeId, 'BUY_USDT'))!.rate.micro).toBe(100_000_000n);
  });

  it('concurrent publishers keep one linear chain per series', async () => {
    const r = await newRoute();
    await Promise.all(Array.from({ length: 8 }, (_, i) =>
      runAs(t.app, publishRouteRate(dealer.actor), dealer.ref, 'rates.publish_route_rate', { routeId: r.routeId, direction: 'SELL_USDT' as const, rate: `104.${String(10 + i)}` }),
    ));
    const rows = await t.app.selectFrom('rate_snapshot').select(['id', 'supersedes_id']).where('route_id', '=', r.routeId).execute();
    expect(rows).toHaveLength(8);
    expect(rows.filter((x) => x.supersedes_id === null)).toHaveLength(1);
    expect(new Set(rows.map((x) => x.supersedes_id)).size).toBe(8);
  });

  it('paused routes cannot publish; DEALER can, SETTLEMENT_OPERATOR cannot', async () => {
    const r = await newRoute();
    const settlementOp = await createTestOperator(t.owner, ['SETTLEMENT_OPERATOR']);
    await expect(runAs(t.app, publishRouteRate(settlementOp.actor), settlementOp.ref, 'rates.publish_route_rate', { routeId: r.routeId, direction: 'SELL_USDT' as const, rate: '104.20' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await runAs(t.app, setRouteStatus(owner.actor), owner.ref, 'routes.set_status', { routeId: r.routeId, status: 'PAUSED' as const, reason: 'x' });
    await expect(runAs(t.app, publishRouteRate(dealer.actor), dealer.ref, 'rates.publish_route_rate', { routeId: r.routeId, direction: 'SELL_USDT' as const, rate: '104.20' })).rejects.toMatchObject({ code: 'ROUTE_INACTIVE' });
    await expect(runAs(t.app, publishRouteRate(dealer.actor), dealer.ref, 'rates.publish_route_rate', { routeId: r.routeId, direction: 'SELL_USDT' as const, rate: '104.2000001' })).rejects.toMatchObject({ code: 'INVALID_AMOUNT_PRECISION' });
  });

  it('reference rates are a separate series and type (FI-01)', async () => {
    await runAs(t.app, recordReferenceRateCommand(dealer.actor), dealer.ref, 'rates.record_reference_rate', { direction: 'SELL_USDT' as const, rate: '101.80' });
    await executeCommand(t.app, { authorize: async () => {}, handle: (ctx) => recordReferenceRate(ctx, { direction: 'SELL_USDT', rate: Rate.parse('101.85', 'REFERENCE'), source: 'FEED:coingecko' }) }, { name: 'test.reference', actor: { type: 'SYSTEM', id: null, surface: 'SYSTEM' }, payload: {}, idempotencyKey: randomUUID(), financial: true });
    const ref = await currentReferenceRate(t.app, 'SELL_USDT');
    expect(ref).toMatchObject({ source: 'FEED:coingecko' });
    expect(ref!.rate.kind).toBe('REFERENCE');
    await expect(executeCommand(t.app, { authorize: async () => {}, handle: (ctx) => recordReferenceRate(ctx, { direction: 'SELL_USDT', rate: Rate.parse('1', 'ROUTE') as never, source: 'OPERATOR' }) }, { name: 'test.reference', actor: { type: 'SYSTEM', id: null, surface: 'SYSTEM' }, payload: { x: 1 }, idempotencyKey: randomUUID(), financial: true })).rejects.toMatchObject({ code: 'INVALID_RATE' });
    await expect(sql`insert into rate_snapshot (kind, route_id, direction, rate_micro, source, created_by) values ('ROUTE', null, 'SELL_USDT', 1, 'OPERATOR', 'x')`.execute(t.app)).rejects.toSatisfy((e) => pgErrorCode(e) === '23514');
  });
});
