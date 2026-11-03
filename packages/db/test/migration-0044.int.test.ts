import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { MIGRATIONS_DIR, migrate } from '../src/migrate.ts';

/**
 * Migration 0044 on a database that already has traders in every state — as production has, and as a fresh test
 * database never does. Production refused the first version of it (2026-11-03, rolled back whole): it filled
 * `approved_at` before the immutable-columns guard let that column change.
 */
let admin: string;
let name: string;
let pool: pg.Pool;
beforeAll(async () => {
  admin = inject('pgAdminUrl');
  name = `t_mig44_${randomBytes(4).toString('hex')}`;
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  await c.query(`create database ${name}`);
  await c.end();
  const u = new URL(admin);
  u.pathname = `/${name}`;
  pool = new pg.Pool({ connectionString: u.toString(), max: 2 });
});
afterAll(async () => {
  await pool.end();
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  await c.query(`drop database if exists ${name} with (force)`);
  await c.end();
});

describe('migration 0044 (and what follows it) upgrades a database with traders', () => {
  it('fills approved_at for approved and paused traders, leaves the others, and then requires it', async () => {
    const upTo43 = await mkdtemp(path.join(tmpdir(), 'mig43-'));
    await cp(MIGRATIONS_DIR, upTo43, { recursive: true });
    for (const f of await readdir(upTo43)) if (Number.parseInt(f.slice(0, 4), 10) > 43) await rm(path.join(upTo43, f));
    expect((await migrate(pool, { dir: upTo43 })).at(-1)).toBe(43);

    // Traders as the release at 43 left them; the rows they point at are beside the point here.
    const reviewed = new Date('2026-10-20T10:00:00Z');
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      for (const status of ['APPROVED', 'PAUSED', 'UNDER_REVIEW', 'REJECTED'] as const) {
        const done = status !== 'UNDER_REVIEW';
        const t = await c.query<{ id: string }>(
          `insert into trader_profile (client_id, status, offers_buy, offers_sell, typical_usdt_minor, bank_account_id, wallet_id, required_reserve_minor, applied_by, reviewed_by, reviewed_at, review_note)
           values ($1, $2, false, true, 1000000000, $3, $4, $5, $6, $7, $8, $9) returning id`,
          [randomUUID(), status, randomUUID(), randomUUID(), done && status !== 'REJECTED' ? 500_000_000 : null, randomUUID(), done ? 'operator' : null, done ? reviewed : null, status === 'REJECTED' ? 'no' : null],
        );
        // An approved trader's block, as later migrations (0045) find one.
        if (status === 'APPROVED') await c.query(`insert into trader_block (trader_id, side, route_id) values ($1, 'SELL_USDT', $2)`, [t.rows[0]!.id, randomUUID()]);
      }
      await c.query('commit');
    } finally {
      c.release();
    }

    expect((await migrate(pool))[0]).toBe(44);
    const rows = (await pool.query<{ status: string; approved_at: Date | null }>('select status, approved_at from trader_profile order by status')).rows;
    expect(Object.fromEntries(rows.map((r) => [r.status, r.approved_at?.toISOString() ?? null]))).toEqual({
      APPROVED: reviewed.toISOString(), PAUSED: reviewed.toISOString(), REJECTED: null, UNDER_REVIEW: null,
    });
    const program = (await pool.query('select auto_review, risk_policy is not null as limits, settlement_change_hold_hours from trader_program where id = 1')).rows[0];
    expect(program).toEqual({ auto_review: false, limits: true, settlement_change_hold_hours: 24 });
  });
});
