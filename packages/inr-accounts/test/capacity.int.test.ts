import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import { pgErrorCode } from '@inrp2p/db';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { testFieldProtector } from '@inrp2p/adapters/testing';
import { executeCommand } from '@inrp2p/commands';
import { createTestOperator, runAs, type TestOperator } from '@inrp2p/identity/testing';
import {
  consumeReservation, createInrAccount, createSettlementEntity, getAccountDay, istToday, releasePastDayReservations, releaseReservation,
  reserveCapacity, reserveCapacityCommand, setDayCapacity, setDefaultDailyCapacity, setInrAccountStatus,
} from '../src/index.ts';

let t: TestDatabase;
let owner: TestOperator;
let finance: TestOperator;
let settlementOp: TestOperator;
let settlementOp2: TestOperator;
let dealer: TestOperator;
let entityId: string;
const protector = testFieldProtector();
let accountSeq = 100000000;

beforeAll(async () => {
  t = await createTestDatabase('capacity');
  owner = await createTestOperator(t.owner, ['OWNER']);
  finance = await createTestOperator(t.owner, ['FINANCE']);
  settlementOp = await createTestOperator(t.owner, ['SETTLEMENT_OPERATOR']);
  settlementOp2 = await createTestOperator(t.owner, ['SETTLEMENT_OPERATOR']);
  dealer = await createTestOperator(t.owner, ['DEALER']);
  entityId = (await runAs(t.app, createSettlementEntity(finance.actor), finance.ref, 'settlement_entity.create', { legalName: 'Company A Private Limited', shortName: 'Company A' })).entityId;
});
afterAll(async () => t.close());

async function newAccount(capacity = '10000000.00', direction: 'PAYOUT' | 'COLLECTION' | 'BOTH' = 'PAYOUT') {
  const n = String(accountSeq++);
  return (await runAs(t.app, createInrAccount(finance.actor, protector), finance.ref, 'inr_account.create', {
    entityId, label: `HDFC ${n}`, bankName: 'HDFC Bank', ifsc: 'HDFC0001234', accountNumber: `5010${n}`, rails: ['IMPS', 'NEFT'] as const, direction, defaultDailyCapacity: capacity,
  })).accountId;
}

const payout = () => ({ purpose: 'CLIENT_PAYOUT' as const, tradeId: randomUUID() });
const reserveAs = (op: TestOperator, accountId: string, amount: string, key = randomUUID()) =>
  executeCommand(t.app, reserveCapacityCommand(op.actor), { name: 'capacity.reserve', actor: op.ref, payload: { accountId, amount, subject: payout() }, idempotencyKey: key, financial: true });
const inSystemCommand = <R>(fn: Parameters<typeof executeCommand<unknown, R>>[1]['handle']) =>
  executeCommand(t.app, { authorize: async () => {}, handle: fn }, { name: 'test.capacity', actor: { type: 'SYSTEM', id: null, surface: 'SYSTEM' }, payload: { n: randomUUID() }, idempotencyKey: randomUUID(), financial: true }).then((o) => o.result);

describe('INR accounts', () => {
  it('encrypts the account number and rejects registering the same account twice', async () => {
    const id = await newAccount();
    const row = await t.owner.selectFrom('inr_settlement_account').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.account_number_enc).toMatch(/^v1\./);
    expect(JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toMatch(/5010\d{9}/);
    await expect(runAs(t.app, createInrAccount(finance.actor, protector), finance.ref, 'inr_account.create', {
      entityId, label: 'Duplicate', bankName: 'HDFC Bank', ifsc: 'HDFC0001234', accountNumber: `5010${String(accountSeq - 1)}`, rails: ['IMPS'] as const, direction: 'PAYOUT' as const, defaultDailyCapacity: '1.00',
    })).rejects.toMatchObject({ code: 'DUPLICATE_DESTINATION' });
  });

  it('account management needs inr_account:manage with step-up', async () => {
    const stale = await createTestOperator(t.owner, ['FINANCE'], 'stale');
    await expect(runAs(t.app, createSettlementEntity(stale.actor), stale.ref, 'settlement_entity.create', { legalName: 'B', shortName: 'Company B' })).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await expect(runAs(t.app, createSettlementEntity(dealer.actor), dealer.ref, 'settlement_entity.create', { legalName: 'B', shortName: 'Company B' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('capacity reservations (FI-30, FI-31, FI-32)', () => {
  it('exit: two concurrent reservations on the last capacity — exactly one succeeds', async () => {
    const accountId = await newAccount('2000000.00');
    await reserveAs(settlementOp, accountId, '1000000.00');
    for (let round = 0; round < 5; round++) {
      const acc = round === 0 ? accountId : await newAccount('1000000.00');
      const results = await Promise.allSettled([reserveAs(settlementOp, acc, '1000000.00'), reserveAs(settlementOp2, acc, '1000000.00')]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(failed[0]!.reason).toMatchObject({ code: 'CAPACITY_INSUFFICIENT' });
      const day = await getAccountDay(t.app, acc);
      expect(day.remaining.minor).toBe(0n);
      const active = await t.app.selectFrom('capacity_reservation').select(['amount_minor']).where('account_id', '=', acc).where('status', '=', 'ACTIVE').execute();
      expect(active.reduce((s, r) => s + r.amount_minor, 0n)).toBe(round === 0 ? 200_000_000n : 100_000_000n);
    }
  });

  it('many concurrent reservations never exceed working capacity', async () => {
    const accountId = await newAccount('1000000.00');
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => reserveAs(i % 2 ? settlementOp : settlementOp2, accountId, '150000.00')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
    const day = await getAccountDay(t.app, accountId);
    expect(day.reserved.minor).toBe(90_000_000n);
    expect(day.remaining.minor).toBe(10_000_000n);
  });

  it('exit: a PAUSED or UNAVAILABLE account rejects reservations; ACTIVE again accepts', async () => {
    const accountId = await newAccount();
    await runAs(t.app, setInrAccountStatus(finance.actor), finance.ref, 'inr_account.set_status', { accountId, status: 'PAUSED' as const, reason: 'bank limit review' });
    await expect(reserveAs(settlementOp, accountId, '1.00')).rejects.toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });
    await runAs(t.app, setInrAccountStatus(finance.actor), finance.ref, 'inr_account.set_status', { accountId, status: 'UNAVAILABLE' as const, reason: 'bank down' });
    await expect(reserveAs(settlementOp, accountId, '1.00')).rejects.toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });
    await runAs(t.app, setInrAccountStatus(finance.actor), finance.ref, 'inr_account.set_status', { accountId, status: 'ACTIVE' as const, reason: 'restored' });
    await expect(reserveAs(settlementOp, accountId, '1.00')).resolves.toMatchObject({ replayed: false });
    const statusAudit = await t.app.selectFrom('audit_event').select('action').where('entity_id', '=', accountId).where('action', '=', 'settlement_account.status_changed').execute();
    expect(statusAudit).toHaveLength(3);
  });

  it('collection-only accounts cannot reserve outgoing capacity; permission and idempotency are enforced', async () => {
    const collection = await newAccount('1000.00', 'COLLECTION');
    await expect(reserveAs(settlementOp, collection, '1.00')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const acc = await newAccount('1000.00');
    await expect(reserveAs(dealer, acc, '1.00')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(executeCommand(t.app, reserveCapacityCommand(settlementOp.actor), { name: 'capacity.reserve', actor: settlementOp.ref, payload: { accountId: acc, amount: '1.00', subject: payout() }, financial: true })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    const key = randomUUID();
    const payload = { accountId: acc, amount: '100.00', subject: payout() };
    const a = await executeCommand(t.app, reserveCapacityCommand(settlementOp.actor), { name: 'capacity.reserve', actor: settlementOp.ref, payload, idempotencyKey: key, financial: true });
    const b = await executeCommand(t.app, reserveCapacityCommand(settlementOp.actor), { name: 'capacity.reserve', actor: settlementOp.ref, payload, idempotencyKey: key, financial: true });
    expect(b.replayed).toBe(true);
    expect(b.result).toEqual(a.result);
    expect((await getAccountDay(t.app, acc)).reserved.minor).toBe(10_000n);
  });

  it('partial consume then release returns exactly the remainder, once (FI-31)', async () => {
    const acc = await newAccount('5000000.00');
    const { reservationId } = await inSystemCommand((ctx) => reserveCapacity(ctx, { accountId: acc, amount: Money.parse('2500000.00', 'INR'), subject: payout() }));
    await inSystemCommand((ctx) => consumeReservation(ctx, reservationId, Money.parse('2000000.00', 'INR')));
    let day = await getAccountDay(t.app, acc);
    expect([day.used.minor, day.reserved.minor, day.remaining.minor]).toEqual([200_000_000n, 50_000_000n, 250_000_000n]);
    const first = await inSystemCommand((ctx) => releaseReservation(ctx, reservationId, 'TRADE_COMPLETED'));
    const second = await inSystemCommand((ctx) => releaseReservation(ctx, reservationId, 'TRADE_COMPLETED'));
    expect(first).toMatchObject({ released: true });
    expect(first.releasedAmount.minor).toBe(50_000_000n);
    expect(second).toMatchObject({ released: false });
    day = await getAccountDay(t.app, acc);
    expect([day.used.minor, day.reserved.minor, day.remaining.minor]).toEqual([200_000_000n, 0n, 300_000_000n]);
    const res = await t.app.selectFrom('capacity_reservation').selectAll().where('id', '=', reservationId).executeTakeFirstOrThrow();
    expect(res).toMatchObject({ status: 'RELEASED', consumed_minor: 200_000_000n, released_minor: 50_000_000n, released_reason: 'TRADE_COMPLETED' });
    await expect(inSystemCommand((ctx) => consumeReservation(ctx, reservationId, Money.parse('1.00', 'INR')))).rejects.toMatchObject({ code: 'RESERVATION_NOT_ACTIVE' });

    const full = await inSystemCommand((ctx) => reserveCapacity(ctx, { accountId: acc, amount: Money.parse('1000.00', 'INR'), subject: payout() }));
    await expect(inSystemCommand((ctx) => consumeReservation(ctx, full.reservationId, Money.parse('1000.01', 'INR')))).rejects.toMatchObject({ code: 'CAPACITY_INSUFFICIENT' });
    await inSystemCommand((ctx) => consumeReservation(ctx, full.reservationId, Money.parse('1000.00', 'INR')));
    await expect(inSystemCommand((ctx) => releaseReservation(ctx, full.reservationId, 'LEG_CANCELLED'))).rejects.toMatchObject({ code: 'RESERVATION_NOT_ACTIVE' });
    const trail = await t.app.selectFrom('audit_event').select('action').where('entity_id', '=', reservationId).orderBy('seq').execute();
    expect(trail.map((x) => x.action)).toEqual(['capacity.reserved', 'capacity.consumed', 'capacity.released']);
  });

  it('lowering capacity below commitments never cancels anything, blocks new reservations and signals over-commitment', async () => {
    const acc = await newAccount('3000000.00');
    await reserveAs(settlementOp, acc, '2000000.00');
    const stale = await createTestOperator(t.owner, ['FINANCE'], 'stale');
    await expect(runAs(t.app, setDayCapacity(stale.actor), stale.ref, 'capacity.set_day', { accountId: acc, capacity: '1000000.00', reason: 'bank limit' })).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const r = await runAs(t.app, setDayCapacity(finance.actor), finance.ref, 'capacity.set_day', { accountId: acc, capacity: '1000000.00', reason: 'bank limit' });
    expect(r).toMatchObject({ overCommitted: true, remaining: '-1000000.00' });
    expect(await t.app.selectFrom('capacity_reservation').select('status').where('account_id', '=', acc).execute()).toEqual([{ status: 'ACTIVE' }]);
    await expect(reserveAs(settlementOp, acc, '0.01')).rejects.toMatchObject({ code: 'CAPACITY_INSUFFICIENT' });
    const events = await t.app.selectFrom('outbox_event').select('type').where('aggregate_id', '=', acc).execute();
    expect(events.map((e) => e.type)).toEqual(['capacity.over_committed']);
    expect(await t.app.selectFrom('audit_event').select('action').where('entity_id', '=', `${acc}:${await istToday(t.app)}`).execute()).toEqual([{ action: 'capacity.changed' }]);
  });

  it('the database independently refuses growing commitments past capacity and inconsistent day totals', async () => {
    const acc = await newAccount('100.00');
    const today = await istToday(t.app);
    await reserveAs(settlementOp, acc, '100.00');
    await expect(sql`update inr_account_day set reserved_minor = reserved_minor + 1 where account_id = ${acc} and day = ${today}::date`.execute(t.app)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX030');
    // Reserved total must equal open reservations at commit, even with room left.
    await sql`update inr_account_day set capacity_minor = 100000 where account_id = ${acc} and day = ${today}::date`.execute(t.app);
    await expect(sql`update inr_account_day set reserved_minor = reserved_minor + 1 where account_id = ${acc} and day = ${today}::date`.execute(t.app)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX031');
    await expect(sql`delete from capacity_reservation where account_id = ${acc}`.execute(t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX001');
    await expect(sql`update capacity_reservation set status = 'CONSUMED' where account_id = ${acc}`.execute(t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === '23514');
  });

  it('day rollover releases past-day reservations and never carries them into today', async () => {
    const acc = await newAccount('500000.00');
    const yesterday = (await sql<{ d: string }>`select to_char((statement_timestamp() at time zone 'Asia/Kolkata')::date - 1, 'YYYY-MM-DD') as d`.execute(t.owner)).rows[0]!.d;
    const tradeId = randomUUID();
    await t.owner.transaction().execute(async (tx) => {
      await sql`insert into inr_account_day (account_id, day, capacity_minor) values (${acc}, ${yesterday}::date, 50000000)`.execute(tx);
      await sql`update inr_account_day set reserved_minor = 30000000 where account_id = ${acc} and day = ${yesterday}::date`.execute(tx);
      await sql`insert into capacity_reservation (purpose, trade_id, account_id, day, amount_minor, created_by) values ('CLIENT_PAYOUT', ${tradeId}, ${acc}, ${yesterday}::date, 30000000, 'fixture')`.execute(tx);
    });
    await expect(executeCommand(t.app, reserveCapacityCommand(settlementOp.actor), { name: 'capacity.reserve', actor: settlementOp.ref, payload: { accountId: acc, amount: '1.00', subject: payout(), day: yesterday }, idempotencyKey: randomUUID(), financial: true })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const released = await inSystemCommand((ctx) => releasePastDayReservations(ctx));
    expect(released).toBeGreaterThanOrEqual(1);
    const res = await t.app.selectFrom('capacity_reservation').select(['status', 'released_reason']).where('trade_id', '=', tradeId).executeTakeFirstOrThrow();
    expect(res).toEqual({ status: 'RELEASED', released_reason: 'DAY_ROLLOVER' });
    expect((await getAccountDay(t.app, acc, yesterday)).reserved.minor).toBe(0n);
    expect((await getAccountDay(t.app, acc)).reserved.minor).toBe(0n);
    expect(await inSystemCommand((ctx) => releasePastDayReservations(ctx))).toBe(0);
  });

  it('a new day opens from the current default capacity; default changes are audited', async () => {
    const acc = await newAccount('1000.00');
    await runAs(t.app, setDefaultDailyCapacity(owner.actor), owner.ref, 'capacity.set_default', { accountId: acc, capacity: '2500000.00', reason: 'new bank limit' });
    const tomorrow = (await sql<{ d: string }>`select to_char((statement_timestamp() at time zone 'Asia/Kolkata')::date + 1, 'YYYY-MM-DD') as d`.execute(t.owner)).rows[0]!.d;
    const { day } = await inSystemCommand((ctx) => reserveCapacity(ctx, { accountId: acc, amount: Money.parse('1.00', 'INR'), subject: payout(), day: tomorrow }));
    expect(day).toBe(tomorrow);
    expect((await getAccountDay(t.app, acc, tomorrow)).capacity.minor).toBe(250_000_000n);
  });
});
