import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { sql } from 'kysely';
import { CURRENCIES } from '@inrp2p/kernel';
import { assertLockOrder, dbNow, pgErrorCode } from '../src/index.ts';
import { MIGRATIONS_DIR, loadMigrations, migrate } from '../src/migrate.ts';
import { createTestDatabase, type TestDatabase } from './harness.ts';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('foundation');
});
afterAll(async () => t.close());

describe('database foundation', () => {
  it('runs on PostgreSQL 18 (exact version enforced when REQUIRE_PG_VERSION is set, e.g. in CI)', async () => {
    const version = inject('pgServerVersion');
    expect(Number(version.split('.')[0])).toBeGreaterThanOrEqual(18);
    if (process.env.REQUIRE_PG_VERSION) expect(version.split(' ')[0]).toBe(process.env.REQUIRE_PG_VERSION);
  });

  it('migrations are contiguous and all applied', async () => {
    const files = await loadMigrations();
    const rows = await t.owner.selectFrom('schema_migration' as never).select(['version' as never]).execute();
    expect(rows.length).toBe(files.length);
  });

  it('currency precision in the database equals the kernel definition', async () => {
    const rows = await t.app.selectFrom('currency').selectAll().orderBy('code').execute();
    expect(Object.fromEntries(rows.map((r) => [r.code, r.minor_unit_exponent]))).toEqual(
      Object.fromEntries(Object.values(CURRENCIES).map((c) => [c.code, c.exponent])),
    );
    await expect(sql`update currency set minor_unit_exponent = 0 where code = 'INR'`.execute(t.owner)).rejects.toThrow(/immutable/);
  });

  it('rejects a modified, already-applied migration', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mig-'));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    const first = (await loadMigrations(dir))[0]!;
    await writeFile(path.join(dir, `0001_${first.name}.sql`), `${first.sql}\n-- tampered\n`);
    await expect(migrate(t.ownerPool, { dir })).rejects.toThrow(/modified after being applied/);
  });

  it('the application role cannot run DDL or touch schema_migration', async () => {
    await expect(sql`create table evil (id int)`.execute(t.app)).rejects.toSatisfy((e) => pgErrorCode(e) === '42501');
    await expect(sql`select * from schema_migration`.execute(t.app)).rejects.toSatisfy((e) => pgErrorCode(e) === '42501');
  });

  it('uses database time and UUIDv7 ids', async () => {
    const now = await dbNow(t.app);
    expect(now).toBeInstanceOf(Date);
    const r = await sql<{ v: string }>`select uuid_extract_version(uuidv7())::text as v`.execute(t.app);
    expect(r.rows[0]!.v).toBe('7');
  });

  it('enforces the global lock order inside a transaction', async () => {
    await t.app.transaction().execute(async (tx) => {
      assertLockOrder(tx, 'quote');
      assertLockOrder(tx, 'trade');
      expect(() => assertLockOrder(tx, 'trade_request')).toThrow(expect.objectContaining({ code: 'LOCK_ORDER_VIOLATION' }));
    });
  });

  it('parses BIGINT as bigint on financial pools and as number on the auth pool', async () => {
    const a = await sql<{ v: unknown }>`select 9007199254740993::bigint as v`.execute(t.app);
    expect(a.rows[0]!.v).toBe(9007199254740993n);
    const b = await sql<{ v: unknown }>`select 1726500000000::bigint as v`.execute(t.auth);
    expect(b.rows[0]!.v).toBe(1726500000000);
  });
});
