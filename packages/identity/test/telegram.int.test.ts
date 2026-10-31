import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { isDomainError } from '@inrp2p/kernel';
import {
  CLIENT_MFA_ENROLMENT_MAX_SESSION_AGE_SECONDS, LAST_SIGN_IN_COOKIE, SESSION_POLICY, TELEGRAM_ISSUER, createClientAuth, hasFreshStepUp, provisionClientUser,
  requireClientSession, requireConfirmation, requireFactorChange, sessionFactors, type ClientAuth,
} from '../src/index.ts';
import { APP, CookieJar, call, currentTotp, totpFromUri } from './support.ts';

/**
 * ADR 0026 end to end against Better Auth itself: Telegram's OpenID Connect flow (its token endpoint and keys played by
 * the test), the codes that confirm a change, and which factor confirms which session.
 */
const CLIENT_ID = '7654321';
let t: TestDatabase;
let client: ClientAuth;
const emails: { email: string; otp: string; type: string }[] = [];
const telegramMessages: { chatId: string; text: string }[] = [];
const linked: string[] = [];
const unlinked: string[] = [];
/** The identity Telegram vouches for, by the authorization code the test hands back to Better Auth. */
const issued = new Map<string, Record<string, unknown>>();
let sign: (claims: Record<string, unknown>, opts?: { audience?: string; issuer?: string }) => Promise<string>;

beforeAll(async () => {
  t = await createTestDatabase('telegram');
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] });
  sign = (claims, opts = {}) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(opts.issuer ?? TELEGRAM_ISSUER).setAudience(opts.audience ?? CLIENT_ID)
      .setSubject(String(claims.id)).setIssuedAt().setExpirationTime('1h').sign(privateKey);
  const tokenEndpoint: typeof fetch = async (_url, init) => {
    const form = new URLSearchParams(String(init?.body));
    expect(String((init?.headers as Record<string, string>).authorization)).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:secret-of-the-bot`).toString('base64')}`);
    expect(form.get('code_verifier')).toBeTruthy();
    const claims = issued.get(form.get('code') ?? '');
    if (!claims) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    const idToken = typeof claims.__token === 'string' ? claims.__token : await sign(claims);
    return new Response(JSON.stringify({ access_token: 'telegram-access', token_type: 'Bearer', expires_in: 3600, id_token: idToken }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  client = createClientAuth({
    authDb: t.auth, appDb: t.app, secret: randomBytes(32).toString('hex'), baseURL: APP, rateLimit: { enabled: false },
    otpSender: { send: async (m) => { emails.push(m); } },
    telegram: {
      login: { clientId: CLIENT_ID, clientSecret: 'secret-of-the-bot', audiences: [CLIENT_ID], fetch: tokenEndpoint, keys },
      send: async (m) => { telegramMessages.push(m); },
      onLinked: async ({ telegramId }) => { linked.push(telegramId); },
      onUnlinked: async ({ telegramId }) => { unlinked.push(telegramId); },
    },
  });
});
afterAll(async () => t.close());

/** A request to the client auth that follows nothing: a redirect comes back as its status and Location. */
async function raw(jar: CookieJar, path: string, init: { method?: string; body?: unknown } = {}) {
  const headers = jar.headers(APP);
  headers.set('x-forwarded-for', '203.0.113.20');
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  const res = await client.handler(new Request(`${APP}/api/auth${path}`, { method: init.method ?? 'POST', headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) }));
  jar.absorb(res);
  const text = await res.text();
  let json: Record<string, unknown> | null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status: res.status, location: res.headers.get('location'), json };
}

/** Telegram's side of a round trip: the person confirms in Telegram, which redirects back with a code for this state. */
async function throughTelegram(jar: CookieJar, start: { url?: unknown }, claims: Record<string, unknown>) {
  const url = new URL(String(start.url));
  expect(url.origin + url.pathname).toBe(`${TELEGRAM_ISSUER}/auth`);
  expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('scope')).toBe('openid profile telegram:bot_access');
  expect(url.searchParams.get('redirect_uri')).toBe(`${APP}/api/auth/callback/telegram`);
  const code = randomUUID();
  issued.set(code, claims);
  return raw(jar, `/callback/telegram?${new URLSearchParams({ code, state: url.searchParams.get('state')! })}`, { method: 'GET' });
}

async function signInWithEmail(email: string, jar = new CookieJar()) {
  await call(client, APP, jar, '/email-otp/send-verification-otp', { email, type: 'sign-in' });
  const otp = emails.filter((m) => m.email === email && m.type === 'sign-in').at(-1)!.otp;
  expect((await call(client, APP, jar, '/sign-in/email-otp', { email, otp })).status).toBe(200);
  const session = await t.app.selectFrom('auth_session').select(['id', 'sign_in_method']).where('user_id', '=', (await userOf(email)).id).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
  return { jar, sessionId: session.id, method: session.sign_in_method };
}

const userOf = (email: string) => t.app.selectFrom('auth_user').select(['id', 'email_verified']).where('email', '=', email).executeTakeFirstOrThrow();

async function newClient() {
  const email = `client-${randomUUID()}@acmepay.in`;
  const userId = await provisionClientUser(client, { email, name: 'Priya' });
  return { email, userId };
}

async function linkTelegram(jar: CookieJar, claims: Record<string, unknown>) {
  const start = await raw(jar, '/link-social', { body: { provider: 'telegram', callbackURL: '/account?telegram=linked', errorCallbackURL: '/account?telegram=failed', disableRedirect: true } });
  expect(start.status).toBe(200);
  return throughTelegram(jar, start.json!, claims);
}

async function signInWithTelegram(claims: Record<string, unknown>, jar = new CookieJar()) {
  const start = await raw(jar, '/sign-in/social', { body: { provider: 'telegram', callbackURL: '/exchange', errorCallbackURL: '/sign-in', disableRedirect: true } });
  expect(start.status).toBe(200);
  return { jar, done: await throughTelegram(jar, start.json!, claims) };
}

async function stepUp(jar: CookieJar, channel: 'EMAIL' | 'TELEGRAM', email?: string) {
  const sent = await raw(jar, '/step-up/send', { body: { channel, purpose: 'DESTINATION' } });
  expect(sent.status).toBe(200);
  const code = channel === 'EMAIL' ? emails.filter((m) => m.email === email && m.type === 'step-up').at(-1)!.otp : /INRP2P code: (\d{6})/.exec(telegramMessages.at(-1)!.text)![1]!;
  return raw(jar, '/step-up/verify', { body: { code } });
}

const telegramUser = () => ({ id: 100_000_000 + Math.floor(Math.random() * 800_000_000), name: 'Priya S', preferred_username: `priya_${randomBytes(3).toString('hex')}` });

async function domainCode(p: Promise<unknown>) {
  try {
    await p;
    return null;
  } catch (e) {
    return isDomainError(e) ? { code: e.code, details: e.details } : e;
  }
}

describe('a session knows how it was opened', () => {
  it('an email code opens an EMAIL session, which lasts a month and survives a quiet week', async () => {
    const c = await newClient();
    const s = await signInWithEmail(c.email);
    expect(s.method).toBe('EMAIL');
    const row = await sql<{ days: number }>`select round(extract(epoch from expires_at - created_at) / 86400) as days from auth_session where id = ${s.sessionId}`.execute(t.app);
    expect(Number(row.rows[0]!.days)).toBe(SESSION_POLICY.CLIENT.absoluteSeconds / 86400);
    await sql`insert into session_activity (session_id, last_activity_at) values (${s.sessionId}, statement_timestamp() - interval '6 days')
              on conflict (session_id) do update set last_activity_at = excluded.last_activity_at`.execute(t.owner);
    await expect(requireClientSession(client, t.app, s.jar.headers(APP))).resolves.toMatchObject({ userId: c.userId });
    expect(s.jar.get(LAST_SIGN_IN_COOKIE)).toBe('email');
  });

  it('the database refuses a desk method on a client session', async () => {
    const c = await newClient();
    const s = await signInWithEmail(c.email);
    await expect(sql`update auth_session set sign_in_method = 'PASSWORD' where id = ${s.sessionId}`.execute(t.owner)).rejects.toThrow();
  });
});

describe('Telegram: linked from inside, then a way in to the same account', () => {
  it('links from a fresh email session, keeps no Telegram token, and then signs that account in — nobody new', async () => {
    const c = await newClient();
    const s = await signInWithEmail(c.email);
    const who = telegramUser();
    const back = await linkTelegram(s.jar, who);
    expect(back.status).toBe(302);
    expect(back.location).toBe('/account?telegram=linked');
    const account = await sql<{ account_id: string; telegram_username: string | null; access_token: string | null; id_token: string | null }>`
      select account_id, telegram_username, access_token, id_token from auth_account where user_id = ${c.userId} and provider_id = 'telegram'`.execute(t.app);
    expect(account.rows).toEqual([{ account_id: String(who.id), telegram_username: who.preferred_username, access_token: null, id_token: null }]);
    expect(linked).toContain(String(who.id));
    const audit = await t.app.selectFrom('audit_event').select('action').where('actor_id', '=', c.userId).execute();
    expect(audit.map((a) => a.action)).toContain('user.telegram_linked');

    const users = (await sql<{ n: string }>`select count(*)::text as n from auth_user`.execute(t.app)).rows[0]!.n;
    const { jar, done } = await signInWithTelegram(who);
    expect(done.status).toBe(302);
    expect(done.location).toBe('/exchange');
    await expect(requireClientSession(client, t.app, jar.headers(APP))).resolves.toMatchObject({ userId: c.userId });
    expect((await sql<{ n: string }>`select count(*)::text as n from auth_user`.execute(t.app)).rows[0]!.n).toBe(users);
    const session = await t.app.selectFrom('auth_session').select(['sign_in_method']).where('user_id', '=', c.userId).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    expect(session.sign_in_method).toBe('TELEGRAM');
    expect(jar.get(LAST_SIGN_IN_COOKIE)).toBe('telegram');
    const actions = await t.app.selectFrom('audit_event').select('action').where('actor_id', '=', c.userId).execute();
    expect(actions.map((a) => a.action)).toContain('session.login_telegram');
  });

  it('a Telegram nobody linked signs nobody in and creates nothing', async () => {
    const users = (await sql<{ n: string }>`select count(*)::text as n from auth_user`.execute(t.app)).rows[0]!.n;
    const { jar, done } = await signInWithTelegram(telegramUser());
    expect(done.status).toBe(302);
    expect(done.location).toMatch(/^\/sign-in\?error=signup_disabled/);
    expect(jar.get('__Secure-inrp2p-app.session_token')).toBeUndefined();
    expect((await sql<{ n: string }>`select count(*)::text as n from auth_user`.execute(t.app)).rows[0]!.n).toBe(users);
  });

  it('refuses a token Telegram did not sign for this bot, and an ID token handed in by a page', async () => {
    const c = await newClient();
    const s = await signInWithEmail(c.email);
    const who = telegramUser();
    await linkTelegram(s.jar, who);
    const forged = await sign(who, { audience: '999' });
    const { jar, done } = await signInWithTelegram({ ...who, __token: forged });
    expect(done.location).toMatch(/error=/);
    await expect(requireClientSession(client, t.app, jar.headers(APP))).rejects.toThrow();
    const direct = await raw(new CookieJar(), '/sign-in/social', { body: { provider: 'telegram', idToken: { token: await sign(who) }, callbackURL: '/exchange' } });
    expect(direct.status).toBe(400);
    expect((await raw(new CookieJar(), '/sign-in/social', { body: { provider: 'google', callbackURL: '/exchange' } })).status).toBe(400);
  });

  it('one Telegram per person, one person per Telegram', async () => {
    const a = await newClient();
    const b = await newClient();
    const who = telegramUser();
    await linkTelegram((await signInWithEmail(a.email)).jar, who);
    const second = await linkTelegram((await signInWithEmail(b.email)).jar, who);
    expect(second.location).toMatch(/^\/account\?telegram=failed&error=account_already_linked_to_different_user/);
    expect((await sql`select 1 from auth_account where user_id = ${b.userId}`.execute(t.app)).rows).toHaveLength(0);
  });

  it('an operator or an unverified address can never hold a Telegram (IX136)', async () => {
    const c = await newClient();
    await t.owner.updateTable('auth_user').set({ email_verified: false }).where('id', '=', c.userId).execute();
    await expect(sql`insert into auth_account (account_id, provider_id, user_id) values ('123456', 'telegram', ${c.userId})`.execute(t.owner)).rejects.toThrow(/verified email/);
  });
});

describe('what confirms what (ADR 0026)', () => {
  it('an email session with nothing else must set up a second factor; a code to the same email does not confirm it', async () => {
    const c = await newClient();
    const s = await signInWithEmail(c.email);
    expect(await domainCode(requireConfirmation(t.app, s.sessionId))).toMatchObject({ code: 'MFA_ENROLLMENT_REQUIRED', details: { factors: [] } });
    // A first destination asks only for a recent sign-in, which this one is.
    await expect(requireConfirmation(t.app, s.sessionId, 'RECENT')).resolves.toBe('EMAIL_SIGN_IN');
    expect((await stepUp(s.jar, 'EMAIL', c.email)).status).toBe(200);
    expect(await hasFreshStepUp(t.app, s.sessionId)).toBe(false);
    expect(await domainCode(requireConfirmation(t.app, s.sessionId))).toMatchObject({ code: 'MFA_ENROLLMENT_REQUIRED' });
  });

  it('with Telegram linked: an email session confirms by Telegram, a Telegram session by email — never by itself', async () => {
    const c = await newClient();
    const email = await signInWithEmail(c.email);
    const who = telegramUser();
    await linkTelegram(email.jar, who);
    expect(await domainCode(requireConfirmation(t.app, email.sessionId))).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { factors: ['TELEGRAM'], requirement: 'INDEPENDENT' } });
    const viaTelegram = await stepUp(email.jar, 'TELEGRAM');
    expect(viaTelegram.status).toBe(200);
    expect(telegramMessages.at(-1)).toMatchObject({ chatId: String(who.id) });
    expect(telegramMessages.at(-1)!.text).toMatch(/add or archive a bank account or wallet/);
    await expect(requireConfirmation(t.app, email.sessionId)).resolves.toBe('TELEGRAM');

    const { jar } = await signInWithTelegram(who);
    const tgSession = (await sessionFactors(t.app, (await requireClientSession(client, t.app, jar.headers(APP))).sessionId));
    expect(tgSession).toMatchObject({ signInMethod: 'TELEGRAM', available: ['TELEGRAM', 'EMAIL'], independent: ['EMAIL'] });
    const actor = await requireClientSession(client, t.app, jar.headers(APP));
    expect((await stepUp(jar, 'TELEGRAM')).status).toBe(200);
    expect(await domainCode(requireConfirmation(t.app, actor.sessionId))).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { factors: ['EMAIL'] } });
    expect((await stepUp(jar, 'EMAIL', c.email)).status).toBe(200);
    await expect(requireConfirmation(t.app, actor.sessionId)).resolves.toBe('EMAIL');
  });

  it('a code is spent once, wrong five times it is gone, and it never outlives five minutes', async () => {
    const c = await newClient();
    const s = await signInWithEmail(c.email);
    await raw(s.jar, '/step-up/send', { body: { channel: 'EMAIL' } });
    const code = emails.filter((m) => m.email === c.email && m.type === 'step-up').at(-1)!.otp;
    const stored = await sql<{ value: string }>`select value from auth_verification where identifier = ${`inrp2p-step-up:${s.sessionId}`}`.execute(t.app);
    expect(stored.rows[0]!.value).not.toContain(code);
    expect((await raw(s.jar, '/step-up/verify', { body: { code } })).status).toBe(200);
    expect((await raw(s.jar, '/step-up/verify', { body: { code } })).status).toBe(400);

    await raw(s.jar, '/step-up/send', { body: { channel: 'EMAIL' } });
    const next = emails.filter((m) => m.email === c.email && m.type === 'step-up').at(-1)!.otp;
    const wrong = next === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await raw(s.jar, '/step-up/verify', { body: { code: wrong } })).status).toBe(400);
    expect((await raw(s.jar, '/step-up/verify', { body: { code: next } })).status).toBe(400);

    await raw(s.jar, '/step-up/send', { body: { channel: 'EMAIL' } });
    const late = emails.filter((m) => m.email === c.email && m.type === 'step-up').at(-1)!.otp;
    await sql`update auth_verification set expires_at = statement_timestamp() - interval '1 second' where identifier = ${`inrp2p-step-up:${s.sessionId}`}`.execute(t.owner);
    expect((await raw(s.jar, '/step-up/verify', { body: { code: late } })).status).toBe(400);
    // No Telegram linked: nothing is sent there.
    expect((await raw(s.jar, '/step-up/send', { body: { channel: 'TELEGRAM' } })).json).toMatchObject({ code: 'TELEGRAM_NOT_LINKED' });
    expect((await raw(new CookieJar(), '/step-up/send', { body: { channel: 'EMAIL' } })).status).toBe(401);
  });

  it('whoever holds only the inbox cannot swap the person’s Telegram or add an authenticator over it', async () => {
    const c = await newClient();
    const s = await signInWithEmail(c.email);
    const who = telegramUser();
    await linkTelegram(s.jar, who);
    // A fresh email sign-in is not enough any more: Telegram is in charge of changes now.
    const attacker = await signInWithEmail(c.email);
    const replace = await raw(attacker.jar, '/link-social', { body: { provider: 'telegram', callbackURL: '/account', disableRedirect: true } });
    expect(replace.status).toBe(403);
    expect(replace.json).toMatchObject({ code: 'STEP_UP_REQUIRED', factors: ['TELEGRAM'] });
    expect((await raw(attacker.jar, '/two-factor/enable', { body: {} })).json).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const accounts = await raw(attacker.jar, '/list-accounts', { method: 'GET' });
    const telegramAccount = (accounts.json as unknown as { id: string; providerId: string }[]).find((a) => a.providerId === 'telegram')!;
    expect((await raw(attacker.jar, '/unlink-account', { body: { accountId: telegramAccount.id } })).status).toBe(403);

    // The person, confirming with their Telegram, may set up an authenticator, and disconnect Telegram.
    expect((await stepUp(s.jar, 'TELEGRAM')).status).toBe(200);
    const enable = await raw(s.jar, '/two-factor/enable', { body: {} });
    expect(enable.status).toBe(200);
    const secret = totpFromUri(String(enable.json!.totpURI));
    expect((await raw(s.jar, '/two-factor/verify-totp', { body: { code: await currentTotp(secret) } })).status).toBe(200);
    // Confirming the authenticator rotated the session; the new one was still opened by email.
    const rotated = await t.app.selectFrom('auth_session').select(['id', 'sign_in_method']).where('user_id', '=', c.userId).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    expect(rotated.sign_in_method).toBe('EMAIL');
    await expect(requireFactorChange(t.app, rotated.id)).resolves.toBe('TOTP');
    const { jar: telegramDevice } = await signInWithTelegram(who);
    await expect(requireClientSession(client, t.app, telegramDevice.headers(APP))).resolves.toMatchObject({ userId: c.userId });
    expect((await raw(s.jar, '/unlink-account', { body: { accountId: telegramAccount.id } })).status).toBe(200);
    expect(unlinked).toContain(String(who.id));
    // The sessions that Telegram opened end with it; the one that disconnected it stays.
    await expect(requireClientSession(client, t.app, telegramDevice.headers(APP))).rejects.toThrow();
    await expect(requireClientSession(client, t.app, s.jar.headers(APP))).resolves.toMatchObject({ userId: c.userId });
    expect((await sql`select 1 from auth_account where user_id = ${c.userId} and provider_id = 'telegram'`.execute(t.app)).rows).toHaveLength(0);
  });

  it('an account with only its email sets up its first second factor within ten minutes of signing in', async () => {
    const c = await newClient();
    const s = await signInWithEmail(c.email);
    await sql`update auth_session set created_at = statement_timestamp() - make_interval(secs => ${CLIENT_MFA_ENROLMENT_MAX_SESSION_AGE_SECONDS + 60}) where id = ${s.sessionId}`.execute(t.owner);
    const stale = await raw(s.jar, '/link-social', { body: { provider: 'telegram', callbackURL: '/account', disableRedirect: true } });
    expect(stale.json).toMatchObject({ code: 'STEP_UP_REQUIRED', factors: ['EMAIL'], requirement: 'RECENT' });
    // A code to the email, now, is the recent confirmation it needs.
    expect((await stepUp(s.jar, 'EMAIL', c.email)).status).toBe(200);
    const back = await linkTelegram(s.jar, telegramUser());
    expect(back.location).toBe('/account?telegram=linked');
  });
});
