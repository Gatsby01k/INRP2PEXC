import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { MIGRATIONS_DIR, migrate } from '../src/migrate.ts';
import { preflight } from '../../../scripts/p2p-only-preflight.ts';

/**
 * Migration 46 drops what the old settlement models left (ADR 0027). A fresh test database has nothing in those tables,
 * and production might: so this runs it from schema 45 against each thing it must refuse over, and on the routes a database
 * at 45 can really have. The refusal is the point: a record of money is never dropped.
 */
let admin: string;
let name: string;
let pool: pg.Pool;
let upTo45: string;

const asReplica = async (statements: (c: pg.PoolClient) => Promise<void>) => {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await statements(c);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
};

beforeAll(async () => {
  admin = inject('pgAdminUrl');
  name = `t_mig46_${randomBytes(4).toString('hex')}`;
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  await c.query(`create database ${name}`);
  await c.end();
  const u = new URL(admin);
  u.pathname = `/${name}`;
  pool = new pg.Pool({ connectionString: u.toString(), max: 3 });
  upTo45 = await mkdtemp(path.join(tmpdir(), 'mig45-'));
  await cp(MIGRATIONS_DIR, upTo45, { recursive: true });
  for (const f of await readdir(upTo45)) if (Number.parseInt(f.slice(0, 4), 10) > 45) await rm(path.join(upTo45, f));
  expect((await migrate(pool, { dir: upTo45 })).at(-1)).toBe(45);
});

afterAll(async () => {
  await pool.end();
  await rm(upTo45, { recursive: true, force: true });
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  await c.query(`drop database if exists ${name} with (force)`);
  await c.end();
});

const version = async () => (await pool.query<{ v: number }>('select max(version)::int as v from schema_migration')).rows[0]!.v;

describe('migration 46 at schema 45', () => {
  it('says why it refuses, in the preflight and in the migration alike, and leaves schema 45 whole', async () => {
    const wallet = randomUUID();
    await asReplica(async (c) => {
      await c.query(`insert into treasury_wallet (id, network, address, label, role, reserved_minor, created_by) values ($1, 'TRON', 'TGzz8gjYiYRqpfmDwnLxfgPuLVNmpCswVp', 'Hot', 'HOT', 5, 'test')`, [wallet]);
      await c.query(`insert into treasury_reservation (treasury_wallet_id, trade_id, amount_minor, created_by) values ($1, $2, 5, 'test')`, [wallet, randomUUID()]);
    });

    const answer = await preflight(pool);
    expect(answer.accepted).toBe(false);
    expect(answer.reasons).toEqual(expect.arrayContaining(['1 row(s) in treasury_reservation', '1 treasury wallet(s) with USDT reserved']));
    // The preflight changed nothing and held nothing.
    expect(await version()).toBe(45);

    await expect(migrate(pool)).rejects.toThrow(/migration 46 refuses, nothing was changed: .*1 row\(s\) in treasury_reservation/);
    expect(await version()).toBe(45);
    expect((await pool.query(`select to_regclass('public.inr_settlement_account') as t`)).rows[0].t).toBe('inr_settlement_account');

    await asReplica(async (c) => {
      await c.query('delete from treasury_reservation');
      await c.query('delete from treasury_wallet where id = $1', [wallet]);
    });
    expect(await preflight(pool)).toEqual({ accepted: true, reasons: [] });
  });

  it('moves a trader’s route to P2P and retires a route with no trader; then nothing live can be anything else', async () => {
    const traderRoute = randomUUID();
    const deskRoute = randomUUID();
    await asReplica(async (c) => {
      await c.query(`insert into liquidity_route (id, name, direction, execution_mode, trader_id, status, created_by) values ($1, 'Trader route', 'SELL_USDT', 'TO_EXCHANGE', $2, 'ACTIVE', 'test')`, [traderRoute, randomUUID()]);
      await c.query(`insert into liquidity_route (id, name, direction, execution_mode, status, created_by) values ($1, 'Old desk route', 'BOTH', 'TO_EXCHANGE', 'ACTIVE', 'test')`, [deskRoute]);
    });

    expect(await migrate(pool)).toEqual([46]);
    expect(await version()).toBe(46);

    const route = async (id: string) => (await pool.query(`select status, execution_mode from liquidity_route where id = $1`, [id])).rows[0];
    expect(await route(traderRoute)).toEqual({ status: 'ACTIVE', execution_mode: 'P2P' });
    expect(await route(deskRoute)).toMatchObject({ status: 'RETIRED' });

    await expect(asReplica((c) => c.query(`insert into liquidity_route (name, direction, execution_mode, status, created_by) values ('New desk route', 'BOTH', 'TO_EXCHANGE', 'ACTIVE', 'test')`).then(() => {})))
      .rejects.toThrow(/liquidity_route_live_is_p2p/);
  });

  it('leaves nothing of the old models behind', async () => {
    const { rows: tables } = await pool.query(`select table_name from information_schema.tables where table_schema = 'public'
      and table_name in ('bank_statement_import', 'bank_statement_line', 'capacity_reservation', 'inr_account_day', 'inr_settlement_account', 'settlement_entity', 'trade_collection', 'trader_reward_payout', 'treasury_reservation')`);
    expect(tables).toEqual([]);
    const { rows: columns } = await pool.query(`select table_name, column_name from information_schema.columns where table_schema = 'public'
      and (column_name ~ '^(reward_|reimbursed_)' or column_name in ('inr_account_id', 'capacity_reservation_id', 'reserve_application_id', 'statement_line_id', 'collection_account_id')
           or (table_name = 'trader_reserve_application' and column_name in ('kind', 'sent_at', 'completed_at'))
           or (table_name = 'treasury_wallet' and column_name = 'reserved_minor')
           or (table_name = 'trader_program' and column_name = 'execution_mode'))`);
    expect(columns).toEqual([]);
    // A function naming a dropped table or column would only fail when it next runs.
    const { rows: functions } = await pool.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
      and p.prosrc ~ '(inr_account_id|capacity_reservation|reward_bps|reward_inr_minor|reimbursed_|treasury_reservation|statement_line|reserve_application_id|inr_settlement_account|inr_account_day|trade_collection|trader_reward_payout)'`);
    expect(functions).toEqual([]);
  });

  it('keeps every guard’s list of what may change free of columns that are gone', async () => {
    const { rows } = await pool.query<{ tgname: string; def: string }>(`select g.tgname, pg_get_triggerdef(g.oid) as def from pg_trigger g where not g.tgisinternal and g.tgname like '%immutable'
      and pg_get_triggerdef(g.oid) ~ '(reward_|reimbursed_|capacity_reservation_id|reserved_minor.*treasury|sent_at.*trader_reserve)'`);
    expect(rows.filter((r) => !r.tgname.startsWith('trader_block'))).toEqual([]);
  });
});
