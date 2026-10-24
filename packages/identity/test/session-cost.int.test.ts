import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { countingDb, createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import {
  ACTIVITY_WRITE_INTERVAL_SECONDS, carriesSessionCookie, clientSession, createClientAuth, createOperatorAuth, operatorSession, provisionClientUser, provisionOperator,
  type ClientAuth, type OperatorAuth,
} from '../src/index.ts';
import { APP, CookieJar, DESK, call, currentTotp, totpFromUri } from './support.ts';

/**
 * What reading a session costs (performance budget). Every page, route and server action reads it, so it is paid on
 * every request the desk and the client app answer. These tests count the statements it sends through the very
 * handles Better Auth and the guard use: the number is the round trips a request waits for before its page starts.
 */
let t: TestDatabase;
let auth: ReturnType<typeof countingDb>;
let app: ReturnType<typeof countingDb>;
let operator: OperatorAuth;
let client: ClientAuth;
const sent: { email: string; otp: string }[] = [];
const PASSWORD = 'correct horse battery staple';

beforeAll(async () => {
  t = await createTestDatabase('session_cost');
  auth = countingDb(t.authPool);
  app = countingDb(t.appPool);
  operator = createOperatorAuth({ authDb: auth.db, appDb: app.db, secret: randomBytes(32).toString('hex'), baseURL: DESK, rateLimit: { enabled: false } });
  client = createClientAuth({
    authDb: auth.db, appDb: app.db, secret: randomBytes(32).toString('hex'), baseURL: APP, rateLimit: { enabled: false },
    otpSender: { send: async (m) => void sent.push(m) },
  });
});
afterAll(async () => t.close());

const statements = () => [...auth.statements, ...app.statements];
const reset = () => {
  auth.reset();
  app.reset();
};
const writes = () => statements().filter((s) => /^(insert|update|delete)\b/i.test(s));

async function verifiedOperator() {
  const email = `op-${randomUUID()}@inrp2p.test`;
  await provisionOperator(operator, t.app, { email, name: 'Operator', password: PASSWORD, roles: ['DEALER'] });
  const jar = new CookieJar();
  await call(operator, DESK, jar, '/sign-in/email', { email, password: PASSWORD });
  const enable = await call(operator, DESK, jar, '/two-factor/enable', { password: PASSWORD });
  expect((await call(operator, DESK, jar, '/two-factor/verify-totp', { code: await currentTotp(totpFromUri(String(enable.json!.totpURI))) })).status).toBe(200);
  return jar;
}

describe('reading a session costs two statements (performance budget)', () => {
  it('an operator request: the session with its user, then every INRP2P rule — roles, grants, MFA, idleness, step-up — in one', async () => {
    const jar = await verifiedOperator();
    await operatorSession(operator, app.db, jar.headers(DESK)); // the first request of a session records its activity

    reset();
    const session = await operatorSession(operator, app.db, jar.headers(DESK));
    expect(statements()).toHaveLength(2);
    expect(writes()).toEqual([]);
    expect(session.actor.roles).toEqual(['DEALER']);
    expect(session.stepUpFresh).toBe(true);
    expect(session.name).toBe('Operator');
  });

  it('writes its activity at most once a minute, and again once that is stale', async () => {
    const jar = await verifiedOperator();
    reset();
    const first = await operatorSession(operator, app.db, jar.headers(DESK));
    expect(writes()).toHaveLength(1);

    reset();
    for (let i = 0; i < 5; i++) await operatorSession(operator, app.db, jar.headers(DESK));
    expect(writes()).toEqual([]);
    expect(statements()).toHaveLength(10);

    await sql`update session_activity set last_activity_at = statement_timestamp() - make_interval(secs => ${ACTIVITY_WRITE_INTERVAL_SECONDS + 1})
              where session_id = ${first.actor.sessionId}`.execute(t.owner);
    reset();
    await operatorSession(operator, app.db, jar.headers(DESK));
    expect(writes()).toHaveLength(1);
  });

  it('a session at the edge of its idle timeout still ends there: the throttle only ever records activity as older', async () => {
    const jar = await verifiedOperator();
    const { actor } = await operatorSession(operator, app.db, jar.headers(DESK));
    // Active 29 minutes ago (recorded): the session is live, and this request records it as active now.
    await sql`update session_activity set last_activity_at = statement_timestamp() - interval '29 minutes' where session_id = ${actor.sessionId}`.execute(t.owner);
    await operatorSession(operator, app.db, jar.headers(DESK));
    const recorded = await t.owner.selectFrom('session_activity').select(sql<boolean>`last_activity_at > statement_timestamp() - interval '5 seconds'`.as('now')).where('session_id', '=', actor.sessionId).executeTakeFirstOrThrow();
    expect(recorded.now).toBe(true);
    // Recorded 31 minutes ago: refused and revoked, whatever happened in between.
    await sql`update session_activity set last_activity_at = statement_timestamp() - interval '31 minutes' where session_id = ${actor.sessionId}`.execute(t.owner);
    await expect(operatorSession(operator, app.db, jar.headers(DESK))).rejects.toMatchObject({ code: 'SESSION_IDLE_TIMEOUT' });
  });

  it('a client request: the same two statements', async () => {
    const email = `client-${randomUUID()}@acmepay.in`;
    await provisionClientUser(client, { email, name: 'Client' });
    const jar = new CookieJar();
    await call(client, APP, jar, '/email-otp/send-verification-otp', { email, type: 'sign-in' });
    await call(client, APP, jar, '/sign-in/email-otp', { email, otp: sent.filter((m) => m.email === email).at(-1)!.otp });
    await clientSession(client, app.db, jar.headers(APP));

    reset();
    const session = await clientSession(client, app.db, jar.headers(APP));
    expect(statements()).toHaveLength(2);
    expect(writes()).toEqual([]);
    expect(session.stepUpFresh).toBe(false);
  });

  it('a request with no session costs nothing at all', async () => {
    reset();
    await expect(operatorSession(operator, app.db, new Headers({ origin: DESK }))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(statements()).toEqual([]);
  });
});

describe('the proxy’s cookie check reads no database', () => {
  it('says only whether the surface’s session cookie is there — the guard decides what it is worth', async () => {
    const jar = await verifiedOperator();
    reset();
    expect(carriesSessionCookie(jar.headers(DESK), 'OPERATOR')).toBe(true);
    expect(carriesSessionCookie(jar.headers(DESK), 'CLIENT')).toBe(false);
    expect(carriesSessionCookie(new Headers({ cookie: 'unrelated=1' }), 'OPERATOR')).toBe(false);
    // A forged value passes this filter and nothing else: the guard refuses it.
    const forged = new Headers({ cookie: `__Secure-inrp2p-desk.session_token=${'x'.repeat(32)}.${'A'.repeat(43)}=` });
    expect(carriesSessionCookie(forged, 'OPERATOR')).toBe(true);
    expect(statements()).toEqual([]);
    await expect(operatorSession(operator, app.db, forged)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
