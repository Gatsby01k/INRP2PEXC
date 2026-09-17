import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { getMigrations } from 'better-auth/db/migration';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { pgErrorCode } from '@inrp2p/db';
import {
  authorizeOperator, clientAuthOptions, operatorAuthOptions, provisionClientUser, provisionOperator,
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
  it('Better Auth finds no tables or columns to create for the operator configuration', async () => {
    const { toBeCreated, toBeAdded } = await getMigrations(operatorAuthOptions({ authDb: t.auth, appDb: t.app, secret: 'x'.repeat(32), baseURL: DESK }) as never);
    expect({ toBeCreated: toBeCreated.map((c) => c.table), toBeAdded: toBeAdded.map((c) => [c.table, Object.keys(c.fields)]) }).toEqual({ toBeCreated: [], toBeAdded: [] });
  });

  it('Better Auth finds no tables or columns to create for the client configuration', async () => {
    const { toBeCreated, toBeAdded } = await getMigrations(clientAuthOptions({ authDb: t.auth, appDb: t.app, secret: 'x'.repeat(32), baseURL: APP, otpSender: { send: async () => {} } }) as never);
    expect({ toBeCreated: toBeCreated.map((c) => c.table), toBeAdded: toBeAdded.map((c) => [c.table, Object.keys(c.fields)]) }).toEqual({ toBeCreated: [], toBeAdded: [] });
  });
});

describe('mandatory operator MFA', () => {
  it('a password-only session is refused until TOTP is enrolled and verified', async () => {
    const email = `op-${randomUUID()}@inrp2p.test`;
    await provisionOperator(operator, t.app, { email, name: 'New Op', password: PASSWORD, roles: ['OWNER'] });
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

  it('an operator email cannot sign in through client OTP', async () => {
    const { email } = await enrolledOperator();
    const jar = new CookieJar();
    await call(client, APP, jar, '/email-otp/send-verification-otp', { email, type: 'sign-in' });
    const otp = sentOtps.filter((m) => m.email === email).at(-1)?.otp;
    if (otp) {
      const res = await call(client, APP, jar, '/sign-in/email-otp', { email, otp });
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    await expect(requireClientSession(client, t.app, jar.headers(APP))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('the database refuses a session whose surface does not match the user kind', async () => {
    const { userId } = await enrolledOperator();
    await expect(sql`insert into auth_session (expires_at, token, user_id, surface) values (statement_timestamp() + interval '1 hour', ${randomUUID()}, ${userId}, 'CLIENT')`.execute(t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX020');
  });
});

