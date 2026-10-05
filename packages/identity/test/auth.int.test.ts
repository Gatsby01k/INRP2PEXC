import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { getMigrations } from 'better-auth/db/migration';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { pgErrorCode } from '@inrp2p/db';
import {
  authorizeOperator, clientAuthOptions, ensureClientIdentity, hasFreshStepUp, operatorAuthOptions, provisionClientUser, provisionOperator,
  requireClientSession, requireOperatorSession, type ClientAuth, type OperatorAuth,
} from '../src/index.ts';
import { APP, CookieJar, DESK, buildAuths, call, currentTotp, totpFromUri } from './support.ts';

let t: TestDatabase;
let operator: OperatorAuth;
let client: ClientAuth;
const sentOtps: { email: string; otp: string; type: string }[] = [];

beforeAll(async () => {
  t = await createTestDatabase('auth');
  ({ operator, client } = buildAuths(t, sentOtps));
});
afterAll(async () => t.close());

const PASSWORD = 'correct horse battery staple';

async function enrolledOperator(roles: Parameters<typeof provisionOperator>[2]['roles'] = ['SETTLEMENT_OPERATOR']) {
  const email = `op-${randomUUID()}@inrp2p.test`;
  const userId = await provisionOperator(operator, t.app, { email, name: 'Operator', password: PASSWORD, roles });
  const jar = new CookieJar();
  const signIn = await call(operator, DESK, jar, '/sign-in/email', { email, password: PASSWORD });
  expect(signIn.status).toBe(200);
  const enable = await call(operator, DESK, jar, '/two-factor/enable', { password: PASSWORD });
  expect(enable.status).toBe(200);
  const secret = totpFromUri(String(enable.json!.totpURI));
  const verify = await call(operator, DESK, jar, '/two-factor/verify-totp', { code: await currentTotp(secret) });
  expect(verify.status).toBe(200);
  return { email, userId, jar, secret };
}

describe('Better Auth schema is committed as explicit SQL', () => {
  // TD-01: the planner compares every column with what Better Auth expects and says so through its logger; a type or
  // nullability drift (`auth_rate_limit.last_request` among them) is a warning there, so the plan is clean only when
  // the logger heard nothing at warn level or above.
  const plan = async (options: object) => {
    const heard: string[] = [];
    const out = await getMigrations({ ...options, logger: { level: 'warn', log: (level: string, message: string) => heard.push(`${level}: ${message}`) } } as never);
    return { toBeCreated: out.toBeCreated.map((c) => c.table), toBeAdded: out.toBeAdded.map((c) => [c.table, Object.keys(c.fields)]), heard };
  };

  it('Better Auth finds nothing to create, add or warn about for the operator configuration', async () => {
    expect(await plan(operatorAuthOptions({ authDb: t.auth, appDb: t.app, secret: 'x'.repeat(32), baseURL: DESK }))).toEqual({ toBeCreated: [], toBeAdded: [], heard: [] });
  });

  it('Better Auth finds nothing to create, add or warn about for the client configuration', async () => {
    expect(await plan(clientAuthOptions({ authDb: t.auth, appDb: t.app, secret: 'x'.repeat(32), baseURL: APP, otpSender: { send: async () => {} } }))).toEqual({ toBeCreated: [], toBeAdded: [], heard: [] });
  });

  it('the rate-limit clock round-trips as epoch milliseconds through the auth connection (TD-01)', async () => {
    const now = Date.now();
    await sql`insert into auth_rate_limit (id, key, count, last_request) values (${randomUUID()}, ${`td01:${randomUUID()}`}, 1, ${now})`.execute(t.auth);
    const row = await sql<{ last_request: unknown }>`select last_request from auth_rate_limit where last_request = ${now}`.execute(t.auth);
    // A number, not a string: Better Auth compares it with Date.now() arithmetically.
    expect(row.rows[0]!.last_request).toBe(now);
    expect(now).toBeGreaterThan(2 ** 31);
  });
});

describe('mandatory operator MFA', () => {
  it('a password-only session is refused until TOTP is enrolled and verified', async () => {
    const email = `op-${randomUUID()}@inrp2p.test`;
    // The first OWNER is provisioned the way the bootstrap procedure does it: on the infrastructure connection (IX091).
    await provisionOperator(operator, t.owner, { email, name: 'New Op', password: PASSWORD, roles: ['OWNER'] });
    const jar = new CookieJar();
    expect((await call(operator, DESK, jar, '/sign-in/email', { email, password: PASSWORD })).status).toBe(200);
    await expect(requireOperatorSession(operator, t.app, jar.headers(DESK))).rejects.toMatchObject({ code: 'MFA_ENROLLMENT_REQUIRED' });

    const enable = await call(operator, DESK, jar, '/two-factor/enable', { password: PASSWORD });
    await expect(requireOperatorSession(operator, t.app, jar.headers(DESK))).rejects.toMatchObject({ code: 'MFA_ENROLLMENT_REQUIRED' });

    const wrong = await call(operator, DESK, jar, '/two-factor/verify-totp', { code: '000000' });
    expect(wrong.status).toBe(401);
    const failures = await t.app.selectFrom('audit_event').select(['action', 'entity_id', 'after']).where('action', '=', 'session.failed').where('entity_id', '=', '/two-factor/verify-totp').execute();
    expect(failures.length).toBeGreaterThan(0);
    expect(JSON.stringify(failures)).not.toContain('000000');
    await expect(requireOperatorSession(operator, t.app, jar.headers(DESK))).rejects.toMatchObject({ code: 'MFA_ENROLLMENT_REQUIRED' });

    const ok = await call(operator, DESK, jar, '/two-factor/verify-totp', { code: await currentTotp(totpFromUri(String(enable.json!.totpURI))) });
    expect(ok.status).toBe(200);
    const actor = await requireOperatorSession(operator, t.app, jar.headers(DESK));
    expect(actor.roles).toEqual(['OWNER']);
  });

  it('after enrollment, sign-in yields no session until TOTP is verified', async () => {
    const { email, secret } = await enrolledOperator();
    const jar = new CookieJar();
    const signIn = await call(operator, DESK, jar, '/sign-in/email', { email, password: PASSWORD });
    expect(signIn.json).toMatchObject({ twoFactorRedirect: true });
    await expect(requireOperatorSession(operator, t.app, jar.headers(DESK))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect((await call(operator, DESK, jar, '/two-factor/verify-totp', { code: await currentTotp(secret) })).status).toBe(200);
    await expect(requireOperatorSession(operator, t.app, jar.headers(DESK))).resolves.toMatchObject({ kind: 'OPERATOR' });
  });

  it('a session without a recorded TOTP verification is refused even for an enrolled user', async () => {
    const { jar } = await enrolledOperator();
    const actor = await requireOperatorSession(operator, t.app, jar.headers(DESK));
    await sql`delete from step_up_verification where session_id = ${actor.sessionId}`.execute(t.owner);
    await expect(requireOperatorSession(operator, t.app, jar.headers(DESK))).rejects.toMatchObject({ code: 'MFA_VERIFICATION_REQUIRED' });
  });

  it('operators cannot obtain trusted-device 2FA bypass cookies', async () => {
    const { email, secret } = await enrolledOperator();
    const jar = new CookieJar();
    await call(operator, DESK, jar, '/sign-in/email', { email, password: PASSWORD });
    const res = await call(operator, DESK, jar, '/two-factor/verify-totp', { code: await currentTotp(secret), trustDevice: true });
    expect(res.status).toBe(403);
    expect(jar.raw.some((c) => /trust_device/.test(c) && !/max-age=0/i.test(c))).toBe(false);
  });

  it('desk cookies are Secure, HttpOnly, SameSite=Strict and host-only', async () => {
    const { jar } = await enrolledOperator();
    const session = jar.raw.filter((c) => c.startsWith('__Secure-inrp2p-desk.session_token=')).at(-1)!;
    expect(session).toMatch(/;\s*Secure/i);
    expect(session).toMatch(/;\s*HttpOnly/i);
    expect(session).toMatch(/;\s*SameSite=Strict/i);
    expect(session).not.toMatch(/;\s*Domain=/i);
  });

  it('idle operator sessions expire after 30 minutes and are revoked', async () => {
    const { jar } = await enrolledOperator();
    const actor = await requireOperatorSession(operator, t.app, jar.headers(DESK));
    await sql`update session_activity set last_activity_at = statement_timestamp() - interval '31 minutes' where session_id = ${actor.sessionId}`.execute(t.owner);
    await expect(requireOperatorSession(operator, t.app, jar.headers(DESK))).rejects.toMatchObject({ code: 'SESSION_IDLE_TIMEOUT' });
    expect(await t.app.selectFrom('auth_session').select('id').where('id', '=', actor.sessionId).execute()).toHaveLength(0);
  });

  it('disabled operators are refused immediately', async () => {
    const { jar, userId } = await enrolledOperator();
    await t.app.updateTable('auth_user').set({ status: 'DISABLED' }).where('id', '=', userId).execute();
    await expect(requireOperatorSession(operator, t.app, jar.headers(DESK))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('step-up: ⧗ permissions require a TOTP verification younger than 10 minutes in the current session', async () => {
    const { jar, secret } = await enrolledOperator(['SETTLEMENT_OPERATOR']);
    const actor = await requireOperatorSession(operator, t.app, jar.headers(DESK));
    await expect(authorizeOperator(t.app, actor, 'settlement:confirm_payout')).resolves.toMatchObject({ requirement: 'STEP_UP' });
    await sql`update step_up_verification set verified_at = statement_timestamp() - interval '11 minutes' where session_id = ${actor.sessionId}`.execute(t.owner);
    await expect(authorizeOperator(t.app, actor, 'settlement:confirm_payout')).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await expect(authorizeOperator(t.app, actor, 'settlement:record_utr')).resolves.toMatchObject({ requirement: 'ALLOW' });
    const again = await call(operator, DESK, jar, '/two-factor/verify-totp', { code: await currentTotp(secret) });
    expect(again.status).toBe(200);
    await expect(authorizeOperator(t.app, actor, 'settlement:confirm_payout')).resolves.toMatchObject({ requirement: 'STEP_UP' });
  });
});

describe('client email OTP login', () => {
  it('signs in a provisioned client with a hashed one-time code and verifies the email', async () => {
    const email = `client-${randomUUID()}@acmepay.in`;
    const userId = await provisionClientUser(client, { email, name: 'Acme Trader' });
    const jar = new CookieJar();
    expect((await call(client, APP, jar, '/email-otp/send-verification-otp', { email, type: 'sign-in' })).status).toBe(200);
    const otp = sentOtps.filter((m) => m.email === email).at(-1)!.otp;
    expect(otp).toMatch(/^\d{6}$/);
    const stored = await t.app.selectFrom('auth_verification' as never).select(['value' as never]).execute();
    expect(JSON.stringify(stored)).not.toContain(otp);

    expect((await call(client, APP, jar, '/sign-in/email-otp', { email, otp: otp === '000000' ? '111111' : '000000' })).status).toBeGreaterThanOrEqual(400);
    const ok = await call(client, APP, jar, '/sign-in/email-otp', { email, otp });
    expect(ok.status).toBe(200);
    const actor = await requireClientSession(client, t.app, jar.headers(APP));
    expect(actor.userId).toBe(userId);
    const u = await t.app.selectFrom('auth_user').select('email_verified').where('id', '=', userId).executeTakeFirstOrThrow();
    expect(u.email_verified).toBe(true);
    const cookie = jar.raw.filter((c) => c.startsWith('__Secure-inrp2p-app.session_token=')).at(-1)!;
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/HttpOnly/i);
  });

  it('has no self sign-up: unknown emails get no account', async () => {
    const email = `nobody-${randomUUID()}@example.com`;
    const jar = new CookieJar();
    await call(client, APP, jar, '/email-otp/send-verification-otp', { email, type: 'sign-in' });
    const otp = sentOtps.find((m) => m.email === email)?.otp ?? '123456';
    await call(client, APP, jar, '/sign-in/email-otp', { email, otp });
    expect(await t.app.selectFrom('auth_user').select('id').where('email', '=', email).execute()).toHaveLength(0);
    expect((await call(operator, DESK, new CookieJar(), '/sign-up/email', { email, password: PASSWORD, name: 'x' })).status).toBeGreaterThanOrEqual(400);
  });
});

describe('the trader entry identity (docs/TRADERS.md §3)', () => {
  it('creates a bare client identity for a new address, which the ordinary code then signs in — and nothing more', async () => {
    const email = `Trader-${randomUUID()}@Example.com`;
    const first = await ensureClientIdentity(client, t.app, { email });
    expect(first).toMatchObject({ created: true });
    const userId = (first as { userId: string }).userId;
    const row = await t.app.selectFrom('auth_user').select(['email', 'kind', 'status', 'email_verified']).where('id', '=', userId).executeTakeFirstOrThrow();
    expect(row).toEqual({ email: email.toLowerCase(), kind: 'CLIENT', status: 'ACTIVE', email_verified: false });
    // No client, no role: an identity is not a client.
    expect(await t.app.selectFrom('client_user').select('id').where('user_id', '=', userId).execute()).toHaveLength(0);

    const jar = new CookieJar();
    expect((await call(client, APP, jar, '/email-otp/send-verification-otp', { email, type: 'sign-in' })).status).toBe(200);
    const otp = sentOtps.filter((m) => m.email === email.toLowerCase()).at(-1)!.otp;
    expect((await call(client, APP, jar, '/sign-in/email-otp', { email, otp })).status).toBe(200);
    expect((await requireClientSession(client, t.app, jar.headers(APP))).userId).toBe(userId);
    expect((await t.app.selectFrom('auth_user').select('email_verified').where('id', '=', userId).executeTakeFirstOrThrow()).email_verified).toBe(true);
  });

  it('reuses an existing client identity — never a duplicate — and never hands out an operator’s address', async () => {
    const email = `client-${randomUUID()}@acmepay.in`;
    const userId = await provisionClientUser(client, { email, name: 'Existing Client' });
    expect(await ensureClientIdentity(client, t.app, { email: ` ${email.toUpperCase()} ` })).toEqual({ userId, created: false });
    expect(await t.app.selectFrom('auth_user').select('id').where('email', '=', email).execute()).toHaveLength(1);
    const { email: operatorEmail } = await enrolledOperator();
    expect(await ensureClientIdentity(client, t.app, { email: operatorEmail })).toEqual({ unavailable: true });
  });
});

describe('operator and client session isolation', () => {
  it('a client session cookie is not accepted on the desk and vice versa', async () => {
    const email = `client-${randomUUID()}@acmepay.in`;
    await provisionClientUser(client, { email, name: 'Client' });
    const cjar = new CookieJar();
    await call(client, APP, cjar, '/email-otp/send-verification-otp', { email, type: 'sign-in' });
    await call(client, APP, cjar, '/sign-in/email-otp', { email, otp: sentOtps.filter((m) => m.email === email).at(-1)!.otp });
    await expect(requireOperatorSession(operator, t.app, cjar.headers(DESK))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    // Same raw cookie value presented under the desk cookie name: different secret → rejected.
    const forged = new CookieJar();
    forged.set('__Secure-inrp2p-desk.session_token', cjar.get('__Secure-inrp2p-app.session_token')!);
    await expect(requireOperatorSession(operator, t.app, forged.headers(DESK))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    const { jar } = await enrolledOperator();
    const toClient = new CookieJar();
    toClient.set('__Secure-inrp2p-app.session_token', jar.get('__Secure-inrp2p-desk.session_token')!);
    await expect(requireClientSession(client, t.app, toClient.headers(APP))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('an operator email cannot sign in through client OTP: no code, no session, no cookie, the same answer as a wrong code (TD-02)', async () => {
    const { email } = await enrolledOperator();
    const jar = new CookieJar();
    const sentBefore = sentOtps.length;
    const failures = async () => (await sql<{ n: string }>`select count(*)::text as n from audit_event where action = 'session.failed' and after ->> 'error' = 'NOT_A_CLIENT_ADDRESS'`.execute(t.app)).rows[0]!.n;
    const audited = await failures();

    // Asking for a code answers exactly what an unknown address gets, and sends nothing.
    const unknown = await call(client, APP, new CookieJar(), '/email-otp/send-verification-otp', { email: `nobody-${randomUUID()}@inrp2p.test`, type: 'sign-in' });
    const asked = await call(client, APP, jar, '/email-otp/send-verification-otp', { email, type: 'sign-in' });
    expect({ status: asked.status, json: asked.json }).toEqual({ status: unknown.status, json: unknown.json });
    expect(sentOtps.slice(sentBefore).filter((m) => m.email === email)).toEqual([]);

    // Signing in with any code answers exactly what a wrong code gets from a real client address: a controlled 400.
    const clientUser = `client-${randomUUID()}@inrp2p.test`;
    await provisionClientUser(client, { email: clientUser, name: 'A client' });
    const wrong = await call(client, APP, new CookieJar(), '/sign-in/email-otp', { email: clientUser, otp: '000000' });
    const res = await call(client, APP, jar, '/sign-in/email-otp', { email, otp: '123456' });
    expect(res.status).toBe(400);
    expect({ status: res.status, json: res.json }).toEqual({ status: wrong.status, json: wrong.json });
    expect(jar.headers(APP).get('cookie') ?? '').not.toMatch(/session/i);
    await expect(requireClientSession(client, t.app, jar.headers(APP))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const operatorUser = await t.app.selectFrom('auth_user').select('id').where('email', '=', email).executeTakeFirstOrThrow();
    expect(await t.app.selectFrom('auth_session').select('id').where('user_id', '=', operatorUser.id).where('surface', '=', 'CLIENT').execute()).toEqual([]);
    // Each refusal is on the record once.
    expect(Number(await failures()) - Number(audited)).toBe(2);
  });

  it('the database refuses a session whose surface does not match the user kind', async () => {
    const { userId } = await enrolledOperator();
    await expect(sql`insert into auth_session (expires_at, token, user_id, surface) values (statement_timestamp() + interval '1 hour', ${randomUUID()}, ${userId}, 'CLIENT')`.execute(t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX020');
  });
});

describe('client authenticator (TD-11)', () => {
  /** A code the authenticator has not given yet: Better Auth refuses a code twice, as it should. */
  const nextTotp = async (secret: string) => {
    const first = await currentTotp(secret);
    let code = first;
    while (code === first) {
      await new Promise((r) => setTimeout(r, 1000));
      code = await currentTotp(secret);
    }
    return code;
  };

  /** A client user signed in on the client surface with an email code, as a fresh session. */
  async function signedInClient() {
    const email = `client-${randomUUID()}@inrp2p.test`;
    const userId = await provisionClientUser(client, { email, name: 'Client admin' });
    await t.owner.updateTable('auth_user').set({ email_verified: true }).where('id', '=', userId).execute();
    const jar = new CookieJar();
    await call(client, APP, jar, '/email-otp/send-verification-otp', { email, type: 'sign-in' });
    const otp = sentOtps.filter((m) => m.email === email).at(-1)!.otp;
    expect((await call(client, APP, jar, '/sign-in/email-otp', { email, otp })).status).toBe(200);
    const session = await t.app.selectFrom('auth_session').select('id').where('user_id', '=', userId).executeTakeFirstOrThrow();
    return { email, userId, jar, sessionId: session.id };
  }

  it('enrols in a fresh session, confirms with a code, and the code is this session’s step-up', async () => {
    const c = await signedInClient();
    const enable = await call(client, APP, c.jar, '/two-factor/enable', {});
    expect(enable.status).toBe(200);
    const { totpURI, backupCodes } = enable.json as { totpURI: string; backupCodes: string[] };
    expect(backupCodes.length).toBeGreaterThanOrEqual(8);
    // Not enrolled until a code from the new authenticator is accepted.
    expect((await t.app.selectFrom('auth_user').select('two_factor_enabled').where('id', '=', c.userId).executeTakeFirstOrThrow()).two_factor_enabled).toBe(false);
    const secret = totpFromUri(totpURI);
    expect((await call(client, APP, c.jar, '/two-factor/verify-totp', { code: await currentTotp(secret) })).status).toBe(200);
    expect((await t.app.selectFrom('auth_user').select('two_factor_enabled').where('id', '=', c.userId).executeTakeFirstOrThrow()).two_factor_enabled).toBe(true);
    // Confirming rotated the session; the new one carries the step-up, and the old one is gone.
    const sessions = await t.app.selectFrom('auth_session').select('id').where('user_id', '=', c.userId).execute();
    expect(sessions.map((x) => x.id)).not.toContain(c.sessionId);
    expect(await hasFreshStepUp(t.app, sessions[0]!.id)).toBe(true);
    await expect(requireClientSession(client, t.app, c.jar.headers(APP))).resolves.toMatchObject({ userId: c.userId });
    const actions = await t.app.selectFrom('audit_event').select('action').where('actor_id', '=', c.userId).orderBy('seq').execute();
    expect(actions.map((a) => a.action)).toEqual(expect.arrayContaining(['session.login_email_otp', 'user.mfa_enrollment_started', 'session.step_up']));
    // Already enrolled: a second authenticator cannot be set up over it.
    expect((await call(client, APP, c.jar, '/two-factor/enable', {})).status).toBeGreaterThanOrEqual(400);
  });

  it('offers nothing that hands the authenticator to someone holding only a session', async () => {
    const c = await signedInClient();
    const enable = await call(client, APP, c.jar, '/two-factor/enable', {});
    const secret = totpFromUri(String((enable.json as { totpURI: string }).totpURI));
    await call(client, APP, c.jar, '/two-factor/verify-totp', { code: await currentTotp(secret) });

    expect((await call(client, APP, c.jar, '/two-factor/disable', {})).status).toBe(403);
    expect((await call(client, APP, c.jar, '/two-factor/get-totp-uri', {})).status).toBe(403);
    expect((await call(client, APP, c.jar, '/two-factor/verify-totp', { code: await currentTotp(secret), trustDevice: true })).status).toBe(403);
    // New recovery codes need a fresh step-up with the current authenticator.
    await t.owner.updateTable('step_up_verification').set({ verified_at: new Date(Date.now() - 3_600_000) }).where('user_id', '=', c.userId).execute();
    expect((await call(client, APP, c.jar, '/two-factor/generate-backup-codes', {})).status).toBe(403);
    expect((await call(client, APP, c.jar, '/two-factor/verify-totp', { code: await nextTotp(secret) })).status).toBe(200);
    const fresh = await call(client, APP, c.jar, '/two-factor/generate-backup-codes', {});
    expect(fresh.status).toBe(200);
    expect((fresh.json as { backupCodes: string[] }).backupCodes.length).toBeGreaterThanOrEqual(8);
    expect((await t.app.selectFrom('auth_user').select('two_factor_enabled').where('id', '=', c.userId).executeTakeFirstOrThrow()).two_factor_enabled).toBe(true);
  });

  it('setting one up needs a fresh sign-in', async () => {
    const c = await signedInClient();
    await sql`update auth_session set created_at = statement_timestamp() - interval '20 minutes' where id = ${c.sessionId}`.execute(t.owner);
    const stale = await call(client, APP, c.jar, '/two-factor/enable', {});
    expect(stale.status).toBe(403);
    expect((await sql`select id from auth_two_factor where user_id = ${c.userId}`.execute(t.app)).rows).toEqual([]);
  });
});

