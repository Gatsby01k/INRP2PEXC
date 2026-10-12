import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import { createDb, createPool, databaseDeploymentProblems } from '@inrp2p/db';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { type Login, applyLogins, loginProblems, loginStates, loginUrl } from '../../scripts/database-logins.ts';

/**
 * The logins the web app and the worker connect as (DEPLOYMENT §5): created by the schema owner, members of their group
 * only, their passwords set from verifiers computed client-side — and PostgreSQL lets them in with those passwords.
 * Role names are this file's own: roles are cluster-wide and other suites use the standard logins.
 */
let t: TestDatabase;
let admin: pg.Client;
const suffix = randomBytes(3).toString('hex');
const logins: Login[] = [
  { role: `t_app_login_${suffix}`, group: 'inrp2p_app', key: 'DATABASE_URL', pooled: true },
  { role: `t_worker_login_${suffix}`, group: 'inrp2p_worker', key: 'WORKER_DATABASE_URL', pooled: false },
];

beforeAll(async () => {
  t = await createTestDatabase('logins');
  const u = new URL(inject('pgAdminUrl'));
  u.pathname = `/${t.name}`;
  admin = new pg.Client({ connectionString: u.toString() });
  await admin.connect();
});
afterAll(async () => {
  for (const l of logins) await admin.query(`drop role if exists ${admin.escapeIdentifier(l.role)}`).catch(() => {});
  await admin.end();
  await t.close();
});

describe('database logins (scripts/database-logins.ts)', () => {
  it('creates each login in its group only, and the verifier it sets lets the login in with its password', async () => {
    const passwords = new Map(logins.map((l) => [l.role, randomBytes(32).toString('base64url')]));
    const done = await applyLogins(admin, passwords, logins);
    expect(done).toEqual(expect.arrayContaining([`created ${logins[0]!.role}`, `${logins[0]!.role} joined inrp2p_app`, `${logins[1]!.role} joined inrp2p_worker`]));
    const states = await loginStates(admin, logins);
    expect(states.map((s, i) => loginProblems(s, logins[i]!))).toEqual([[], []]);

    const base = new URL(inject('pgAdminUrl'));
    base.pathname = `/${t.name}`;
    for (const l of logins) {
      const pool = createPool({ connectionString: loginUrl(base.toString(), l, passwords.get(l.role)!), applicationName: 'logins-test', max: 1 });
      try {
        // The release's own check sees an application login — not the owner, not a superuser. (The test template's
        // clock permit is the one thing it objects to, as it must outside tests.)
        expect(await databaseDeploymentProblems(createDb(pool))).toEqual(['the test clock permit exists in this database; it must never exist outside tests']);
      } finally {
        await pool.end();
      }
    }

    // A wrong password is refused, and setting a new one again works (the env file's password is the database's).
    const wrong = new pg.Client({ connectionString: loginUrl(base.toString(), logins[0]!, 'not-the-password') });
    await expect(wrong.connect()).rejects.toThrow(/password authentication failed/);
    const again = await applyLogins(admin, passwords, logins);
    expect(again.filter((x) => x.startsWith('created'))).toEqual([]);

    // The form Neon needs — the password itself — works the same way on PostgreSQL.
    const plain = new Map(logins.map((l) => [l.role, randomBytes(32).toString('base64url')]));
    await applyLogins(admin, plain, logins, 'plaintext');
    const viaPlain = new pg.Client({ connectionString: loginUrl(base.toString(), logins[1]!, plain.get(logins[1]!.role)!) });
    await viaPlain.connect();
    await viaPlain.end();
  });
});
