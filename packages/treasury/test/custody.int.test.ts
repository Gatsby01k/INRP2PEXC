import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money, encodeTronAddress } from '@inrp2p/kernel';
import { type TxContext, pgErrorCode } from '@inrp2p/db';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { executeCommand } from '@inrp2p/commands';
import { FakeCustodyAdapter } from '@inrp2p/adapters/testing';
import { createTestOperator, runAs, type TestOperator } from '@inrp2p/identity/testing';
import {
  allocateDepositAddress, assertSellAcceptanceSupported, getDepositAddressCapability, getDepositPoolStatus, importPoolAddresses, recordCustodyCapability,
  registerTreasuryWallet, releaseCooledDownAddresses, releaseDepositAssignment, retireDepositAddress, setTreasuryWalletStatus,
} from '../src/index.ts';

const SYSTEM = { type: 'SYSTEM' as const, id: null, surface: 'SYSTEM' as const };
const usdt = (v: string) => Money.parse(v, 'USDT');

function system<R>(db: TestDatabase['app'], fn: (ctx: TxContext) => Promise<R>): Promise<R> {
  return executeCommand(db, { authorize: async () => {}, handle: fn }, { name: 'test.treasury', actor: SYSTEM, payload: { n: randomUUID() }, idempotencyKey: randomUUID(), financial: true }).then((o) => o.result);
}

async function freshDb(label: string) {
  const t = await createTestDatabase(label);
  const owner = await createTestOperator(t.owner, ['OWNER']);
  const finance = await createTestOperator(t.owner, ['FINANCE']);
  const wallet = await runAs(t.app, registerTreasuryWallet(finance.actor), finance.ref, 'treasury.register_wallet', { network: 'TRON' as const, address: encodeTronAddress(randomBytes(20)), label: 'Deposit pool', role: 'DEPOSIT_POOL' as const });
  return { t, owner, finance, walletId: wallet.walletId };
}

const record = (t: TestDatabase, op: TestOperator, provider: string, capability: 'DERIVED' | 'POOL' | 'UNSUPPORTED') =>
  runAs(t.app, recordCustodyCapability(op.actor), op.ref, 'custody.record_capability', { provider, network: 'TRON' as const, capability, consolidationNotes: capability === 'UNSUPPORTED' ? null : 'Sweep to hot wallet by provider; TRX energy delegated by exchange' });

describe('custody capability (D-02 gate record)', () => {
  let t: TestDatabase;
  let finance: TestOperator;
  let dealer: TestOperator;
  beforeAll(async () => {
    ({ t, finance } = await freshDb('custody_cap'));
    dealer = await createTestOperator(t.owner, ['DEALER']);
  });
  afterAll(async () => t.close());

  it('exit: with nothing recorded the capability is UNSUPPORTED and SELL acceptance is refused', async () => {
    expect(await getDepositAddressCapability(t.app, 'TRON')).toMatchObject({ capability: 'UNSUPPORTED', provider: null });
    await expect(assertSellAcceptanceSupported(t.app, 'TRON')).rejects.toMatchObject({ code: 'CUSTODY_CAPABILITY_UNSUPPORTED' });
    await expect(system(t.app, (ctx) => allocateDepositAddress(ctx, new FakeCustodyAdapter({ capability: 'POOL' }), { network: 'TRON', tradeId: randomUUID(), tradeRef: 'IX-1', expectedAmount: usdt('100000') }))).rejects.toMatchObject({ code: 'CUSTODY_CAPABILITY_UNSUPPORTED' });
  });

  it('exit: a recorded capability is queryable by acceptance; history is append-only and audited', async () => {
    await expect(record(t, dealer, 'fake-custody', 'POOL')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runAs(t.app, recordCustodyCapability(finance.actor), finance.ref, 'custody.record_capability', { provider: 'fake-custody', network: 'TRON' as const, capability: 'POOL' as const })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await record(t, finance, 'fake-custody', 'POOL');
    expect(await assertSellAcceptanceSupported(t.app, 'TRON')).toMatchObject({ capability: 'POOL', provider: 'fake-custody' });
    const unsupported = await record(t, finance, 'fake-custody', 'UNSUPPORTED');
    expect(await getDepositAddressCapability(t.app, 'TRON')).toMatchObject({ capability: 'UNSUPPORTED', configId: unsupported.configId });
    const rows = await t.app.selectFrom('custody_provider_config').select('deposit_address_capability').orderBy('verified_at').orderBy('id').execute();
    expect(rows.map((r) => r.deposit_address_capability)).toEqual(['POOL', 'UNSUPPORTED']);
    await expect(sql`update custody_provider_config set deposit_address_capability = 'POOL'`.execute(t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX001');
    const audit = await t.app.selectFrom('audit_event').select(['before', 'after']).where('action', '=', 'custody.capability_changed').orderBy('seq').execute();
    expect(audit.map((a) => [(a.before as { capability: string }).capability, (a.after as { capability: string }).capability])).toEqual([['UNSUPPORTED', 'POOL'], ['POOL', 'UNSUPPORTED']]);
  });
});

describe('POOL deposit addresses', () => {
  let t: TestDatabase;
  let owner: TestOperator;
  let finance: TestOperator;
  const adapter = new FakeCustodyAdapter({ capability: 'POOL', seed: 'pool', poolSize: 30 });
  beforeAll(async () => {
    ({ t, owner, finance } = await freshDb('custody_pool'));
    await record(t, finance, adapter.provider, 'POOL');
  });
  afterAll(async () => t.close());

  it('imports provider addresses once; re-import skips known addresses', async () => {
    const first = await runAs(t.app, importPoolAddresses(finance.actor, adapter), finance.ref, 'custody.import_pool_addresses', { network: 'TRON' as const });
    const again = await runAs(t.app, importPoolAddresses(finance.actor, adapter), finance.ref, 'custody.import_pool_addresses', { network: 'TRON' as const });
    expect(first).toEqual({ imported: 30, skipped: 0 });
    expect(again).toEqual({ imported: 0, skipped: 30 });
    expect(await getDepositPoolStatus(t.app, 'TRON')).toMatchObject({ capability: 'POOL', available: 30, assigned: 0 });
  });

  it('refuses to import or allocate through an adapter whose provider or mode differs from the record', async () => {
    const other = new FakeCustodyAdapter({ provider: 'other-provider', capability: 'POOL' });
    await expect(runAs(t.app, importPoolAddresses(finance.actor, other), finance.ref, 'custody.import_pool_addresses', { network: 'TRON' as const })).rejects.toMatchObject({ code: 'CUSTODY_CAPABILITY_MISMATCH' });
    const drifted = new FakeCustodyAdapter({ capability: 'DERIVED' });
    await expect(system(t.app, (ctx) => allocateDepositAddress(ctx, drifted, { network: 'TRON', tradeId: randomUUID(), tradeRef: 'IX-X', expectedAmount: usdt('1') }))).rejects.toMatchObject({ code: 'CUSTODY_CAPABILITY_MISMATCH' });
  });

  it('exit: concurrent allocations never return the same address', async () => {
    const results = await Promise.all(Array.from({ length: 24 }, (_, i) =>
      system(t.app, (ctx) => allocateDepositAddress(ctx, adapter, { network: 'TRON', tradeId: randomUUID(), tradeRef: `IX-260917-${1000 + i}`, expectedAmount: usdt('100000') })),
    ));
    expect(new Set(results.map((r) => r.address)).size).toBe(24);
    expect(new Set(results.map((r) => r.depositAddressId)).size).toBe(24);
    expect(results.every((r) => r.source === 'POOL')).toBe(true);
    const open = await t.app.selectFrom('deposit_assignment').select(['deposit_address_id']).where('released_at', 'is', null).execute();
    expect(new Set(open.map((o) => o.deposit_address_id)).size).toBe(open.length);
    expect(await getDepositPoolStatus(t.app, 'TRON')).toMatchObject({ available: 6, assigned: 24 });
  });

  it('an exhausted pool fails cleanly with DEPOSIT_ADDRESS_UNAVAILABLE and writes nothing', async () => {
    const more = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
      system(t.app, (ctx) => allocateDepositAddress(ctx, adapter, { network: 'TRON', tradeId: randomUUID(), tradeRef: `IX-EX-${i}`, expectedAmount: usdt('10') })),
    ));
    expect(more.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
    const failures = more.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failures).toHaveLength(2);
    expect(failures.every((f) => f.reason.code === 'DEPOSIT_ADDRESS_UNAVAILABLE')).toBe(true);
    expect(await t.app.selectFrom('deposit_assignment').select('id').execute()).toHaveLength(30);
  });

  it('a trade gets one assignment only; release puts the address in COOLDOWN; the job returns it to the pool', async () => {
    const tradeId = (await t.app.selectFrom('deposit_assignment').select('trade_id').where('released_at', 'is', null).limit(1).executeTakeFirstOrThrow()).trade_id;
    await expect(system(t.app, (ctx) => allocateDepositAddress(ctx, adapter, { network: 'TRON', tradeId, tradeRef: 'IX-DUP', expectedAmount: usdt('1') }))).rejects.toMatchObject({ code: 'DEPOSIT_ASSIGNMENT_EXISTS' });
    const released = await system(t.app, (ctx) => releaseDepositAssignment(ctx, { tradeId, reason: 'TRADE_CANCELLED', cooldownSeconds: 0 }));
    const again = await system(t.app, (ctx) => releaseDepositAssignment(ctx, { tradeId, reason: 'TRADE_CANCELLED', cooldownSeconds: 0 }));
    expect([released.released, again.released]).toEqual([true, false]);
    const addr = await t.app.selectFrom('deposit_assignment as a').innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id').select(['d.id', 'd.status']).where('a.trade_id', '=', tradeId).executeTakeFirstOrThrow();
    expect(addr.status).toBe('COOLDOWN');

    const long = (await t.app.selectFrom('deposit_assignment').select('trade_id').where('released_at', 'is', null).limit(1).executeTakeFirstOrThrow()).trade_id;
    await system(t.app, (ctx) => releaseDepositAssignment(ctx, { tradeId: long, reason: 'TRADE_COMPLETED' }));

    const job = await system(t.app, (ctx) => releaseCooledDownAddresses(ctx));
    expect(job).toEqual({ available: 1, retired: 0 });
    expect((await t.app.selectFrom('deposit_address').select('status').where('id', '=', addr.id).executeTakeFirstOrThrow()).status).toBe('AVAILABLE');
    expect(await getDepositPoolStatus(t.app, 'TRON')).toMatchObject({ available: 1, cooldown: 1 });

    const reused = await system(t.app, (ctx) => allocateDepositAddress(ctx, adapter, { network: 'TRON', tradeId: randomUUID(), tradeRef: 'IX-REUSE', expectedAmount: usdt('5') }));
    expect(reused.depositAddressId).toBe(addr.id);
    const actions = await t.app.selectFrom('audit_event').select('action').where('entity_id', '=', addr.id).orderBy('seq').execute();
    expect(actions.map((a) => a.action)).toEqual(['deposit_address.assigned', 'deposit_address.released', 'deposit_address.cooldown_elapsed', 'deposit_address.assigned']);

    await expect(runAs(t.app, retireDepositAddress(owner.actor), owner.ref, 'custody.retire_deposit_address', { depositAddressId: addr.id, reason: 'x' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('the database refuses two open assignments on one address and an ASSIGNED address without an assignment', async () => {
    const open = await t.app.selectFrom('deposit_assignment').select(['deposit_address_id']).where('released_at', 'is', null).limit(1).executeTakeFirstOrThrow();
    await expect(t.owner.insertInto('deposit_assignment').values({ deposit_address_id: open.deposit_address_id, trade_id: randomUUID(), expected_amount_minor: 1n, created_by: 'x' }).execute()).rejects.toSatisfy((e) => pgErrorCode(e) === '23505');
    const cooldown = await t.app.selectFrom('deposit_address').select('id').where('status', '=', 'COOLDOWN').limit(1).executeTakeFirstOrThrow();
    await expect(sql`update deposit_address set status = 'ASSIGNED', cooldown_until = null where id = ${cooldown.id}`.execute(t.owner)).rejects.toSatisfy((e) => ['IX040', 'IX043'].includes(pgErrorCode(e) ?? ''));
    await expect(sql`update deposit_address set status = 'AVAILABLE', cooldown_until = null where status = 'ASSIGNED'`.execute(t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX040');
    await expect(sql`delete from deposit_assignment`.execute(t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX001');
    await expect(sql`update deposit_address set address = ${encodeTronAddress(randomBytes(20))} where id = ${cooldown.id}`.execute(t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX041');
  });
});

describe('DERIVED deposit addresses', () => {
  let t: TestDatabase;
  let finance: TestOperator;
  let walletId: string;
  const adapter = new FakeCustodyAdapter({ capability: 'DERIVED', seed: 'derived' });
  beforeAll(async () => {
    ({ t, finance, walletId } = await freshDb('custody_derived'));
    await record(t, finance, adapter.provider, 'DERIVED');
  });
  afterAll(async () => t.close());

  it('exit: concurrent derived allocations produce distinct addresses, each assigned once', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      system(t.app, (ctx) => allocateDepositAddress(ctx, adapter, { network: 'TRON', tradeId: randomUUID(), tradeRef: `IX-D-${i}`, expectedAmount: usdt('2500') })),
    ));
    expect(new Set(results.map((r) => r.address)).size).toBe(12);
    const rows = await t.app.selectFrom('deposit_address').select(['status', 'source', 'treasury_wallet_id']).execute();
    expect(rows.every((r) => r.status === 'ASSIGNED' && r.source === 'DERIVED' && r.treasury_wallet_id === walletId)).toBe(true);
  });

  it('a provider that re-issues an address is refused (FI-26); nothing is written', async () => {
    adapter.rewind(0);
    await expect(system(t.app, (ctx) => allocateDepositAddress(ctx, adapter, { network: 'TRON', tradeId: randomUUID(), tradeRef: 'IX-REISSUE', expectedAmount: usdt('1') }))).rejects.toMatchObject({ code: 'DEPOSIT_ADDRESS_UNAVAILABLE' });
    expect(await t.app.selectFrom('deposit_assignment').select('id').execute()).toHaveLength(12);
    adapter.rewind(100);
  });

  it('derived addresses are retired after cooldown, never reused', async () => {
    const tradeId = (await t.app.selectFrom('deposit_assignment').select('trade_id').limit(1).executeTakeFirstOrThrow()).trade_id;
    await system(t.app, (ctx) => releaseDepositAssignment(ctx, { tradeId, reason: 'TRADE_COMPLETED', cooldownSeconds: 0 }));
    expect(await system(t.app, (ctx) => releaseCooledDownAddresses(ctx))).toEqual({ available: 0, retired: 1 });
    expect(await getDepositPoolStatus(t.app, 'TRON')).toMatchObject({ capability: 'DERIVED', assigned: 11, retired: 1, available: 0 });
  });

  it('allocation requires an ACTIVE deposit pool wallet', async () => {
    await runAs(t.app, setTreasuryWalletStatus(finance.actor), finance.ref, 'treasury.set_wallet_status', { walletId, status: 'PAUSED' as const, reason: 'rotation' });
    await expect(system(t.app, (ctx) => allocateDepositAddress(ctx, adapter, { network: 'TRON', tradeId: randomUUID(), tradeRef: 'IX-P', expectedAmount: usdt('1') }))).rejects.toMatchObject({ code: 'WALLET_NOT_ACTIVE' });
  });
});
