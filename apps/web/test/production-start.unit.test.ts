import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import type pg from 'pg';
import { SCHEMA_VERSION, createDb } from '@inrp2p/db';
import { databaseStartCheck } from '../src/server/production-start.ts';

/**
 * The database half of the production start-up check runs before the first statement a process sends, not when the
 * process starts (ADR 0021 §4): the proxy — a process of its own on Vercel, in the region nearest the visitor — never
 * uses the database, so it must never wait on it. These hold the other half of that bargain: in production, nothing
 * reaches the database through the runtime's handles until the check has passed on it, and a failed check stops the
 * process before any statement of the application's is sent.
 *
 * The pool is a stand-in that records what it was sent and answers the check's one statement as the test says.
 */
function fakePool(answer: { version: number; superuser?: boolean }): { pool: pg.Pool; sent: string[] } {
  const sent: string[] = [];
  const client = {
    processID: 1,
    query: async (text: string) => {
      sent.push(text);
      if (text.includes('inrp2p_schema_version()')) {
        return { command: 'SELECT', rowCount: 1, rows: [{ superuser: answer.superuser ?? false, application: true, version: answer.version, test_clock: false }] };
      }
      return { command: 'SELECT', rowCount: 1, rows: [{ ok: 1 }] };
    },
    release: () => {},
  };
  return { pool: { connect: async () => client, options: {} } as unknown as pg.Pool, sent };
}

const isCheck = (s: string) => s.includes('inrp2p_schema_version()');
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.INRP2P_ENV;
});
afterEach(() => {
  if (saved === undefined) delete process.env.INRP2P_ENV;
  else process.env.INRP2P_ENV = saved;
  vi.restoreAllMocks();
});

describe('the database start-up check gates the first statement', () => {
  it('outside production there is nothing to check and no gate', () => {
    process.env.INRP2P_ENV = 'e2e';
    expect(databaseStartCheck(fakePool({ version: SCHEMA_VERSION }).pool)).toBeUndefined();
  });

  it('in production the check goes first, once, however many handles and statements wait on it', async () => {
    process.env.INRP2P_ENV = 'production';
    const { pool, sent } = fakePool({ version: SCHEMA_VERSION });
    const exit = vi.fn() as unknown as (code: number) => never;
    const ready = databaseStartCheck(pool, exit)!;
    const app = createDb(pool, { ready });
    const auth = createDb(pool, { ready });
    expect(sent).toHaveLength(0);

    await Promise.all([sql`select 1 as ok`.execute(app), sql`select 2 as ok`.execute(auth), sql`select 3 as ok`.execute(app)]);
    expect(isCheck(sent[0]!)).toBe(true);
    expect(sent.filter(isCheck)).toHaveLength(1);
    expect(sent).toHaveLength(4);
    expect(exit).not.toHaveBeenCalled();
  });

  it('a database at another schema version stops the process before the application sends anything', async () => {
    process.env.INRP2P_ENV = 'production';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pool, sent } = fakePool({ version: SCHEMA_VERSION - 1 });
    const stopped = new Error('exited');
    const exit = vi.fn(() => {
      throw stopped;
    }) as unknown as (code: number) => never;
    const app = createDb(pool, { ready: databaseStartCheck(pool, exit)! });

    await expect(sql`select 1 as ok`.execute(app)).rejects.toBe(stopped);
    expect(exit).toHaveBeenCalledWith(1);
    expect(sent.filter((s) => !isCheck(s))).toHaveLength(0);
  });

  it('a database that cannot be reached stops it the same way', async () => {
    process.env.INRP2P_ENV = 'production';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const pool = { connect: async () => Promise.reject(Object.assign(new Error('quota'), { code: '53000' })), options: {} } as unknown as pg.Pool;
    const exit = vi.fn(() => {
      throw new Error('exited');
    }) as unknown as (code: number) => never;
    const app = createDb(pool, { ready: databaseStartCheck(pool, exit)! });

    await expect(sql`select 1 as ok`.execute(app)).rejects.toThrow('exited');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
