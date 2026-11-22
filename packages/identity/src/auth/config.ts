import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api';
import { emailOTP, genericOAuth, lastLoginMethod, twoFactor } from 'better-auth/plugins';
import { type Kysely, sql } from 'kysely';
import { isDomainError, uuidv7 } from '@inrp2p/kernel';
import type { Db } from '@inrp2p/db';
import { appendAuditDirect } from '@inrp2p/audit';
import { accountSchema, rateLimitSchema, sessionSchema, twoFactorSchema, userSchema, verificationSchema } from './schema-mapping.ts';
import { addEmail } from './add-email.ts';
import { requireFactorChange } from './factors.ts';
import { type StepUpCodeSenders, stepUpCodes } from './step-up-codes.ts';
import { TELEGRAM_PROVIDER, type TelegramLoginConfig, isTelegramPlaceholderEmail, telegramOAuthProvider, telegramUsernameOf } from './telegram.ts';

import { LAST_SIGN_IN_COOKIE, SESSION_POLICY, type Surface } from './policy.ts';
import { originOf, recordSignIn } from './sign-ins.ts';

export { ACTIVITY_WRITE_INTERVAL_SECONDS, LAST_SIGN_IN_COOKIE, SESSION_POLICY, type Surface } from './policy.ts';

export interface EmailOtpSender {
  /**
   * Delivers a client code: a sign-in code (Better Auth's `type`), or a confirmation code (`step-up`, with the fixed
   * sentence of what it confirms). Never persisted outside the hashed verification row.
   */
  send(input: { email: string; otp: string; type: string; purpose?: string }): Promise<void>;
}

export interface AuthDeps {
  /** Kysely over a pool whose int8 parser returns numbers (Better Auth counters). */
  authDb: Db;
  /** Financial/app Kysely (bigint int8) used for INRP2P side tables and audit. */
  appDb: Db;
  secret: string;
  baseURL: string;
  /** Rate limiting on by default; tests may relax limits but never disable it silently in production. */
  rateLimit?: { enabled: boolean; window?: number; max?: number };
  useSecureCookies?: boolean;
}

function database(db: Db) {
  return { db: db as unknown as Kysely<unknown>, type: 'postgres' as const };
}

function sessionAdditional(surface: Surface) {
  return {
    surface: { type: 'string' as const, required: true, input: false, defaultValue: surface, fieldName: 'surface' },
    // Migration 0043: how the session was opened (set by the session guard below, never by a request).
    signInMethod: { type: 'string' as const, required: false, input: false, fieldName: 'sign_in_method' },
  };
}

/**
 * How a new session was opened, from the endpoint creating it. A session Better Auth replaces with another — confirming
 * a new authenticator rotates it — carries the old one's fields, so it keeps how it was opened.
 */
function signInMethodOf(surface: Surface, session: Record<string, unknown>, path: string | undefined): 'EMAIL' | 'TELEGRAM' | 'PASSWORD' {
  if (surface === 'OPERATOR') return 'PASSWORD';
  if (session.signInMethod === 'EMAIL' || session.signInMethod === 'TELEGRAM') return session.signInMethod;
  return path?.startsWith('/callback/') ? 'TELEGRAM' : 'EMAIL';
}

const userAdditional = {
  kind: { type: 'string' as const, required: true, input: false, fieldName: 'kind' },
  status: { type: 'string' as const, required: false, input: false, defaultValue: 'ACTIVE', fieldName: 'status' },
};

/** Blocks session creation for users of the wrong kind or disabled users (defense in depth with DB trigger IX020). */
function sessionCreateGuard(appDb: Db, surface: Surface) {
  return async (session: { userId: string } & Record<string, unknown>, context: { path?: string } | null) => {
    const user = await appDb.selectFrom('auth_user').select(['kind', 'status']).where('id', '=', session.userId).executeTakeFirst();
    if (!user || user.kind !== surface || user.status !== 'ACTIVE') return false;
    return { data: { ...session, surface, signInMethod: signInMethodOf(surface, session, context?.path) } };
  };
}

function common(deps: AuthDeps, surface: Surface) {
  const policy = SESSION_POLICY[surface];
  return {
    baseURL: deps.baseURL,
    basePath: '/api/auth',
    secret: deps.secret,
    trustedOrigins: [deps.baseURL],
    database: database(deps.authDb),
    telemetry: { enabled: false },
    user: { ...userSchema, additionalFields: userAdditional },
    session: {
      ...sessionSchema,
      expiresIn: policy.absoluteSeconds,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
      additionalFields: sessionAdditional(surface),
    },
    account: { ...accountSchema, accountLinking: { enabled: false } },
    verification: verificationSchema,
    rateLimit: {
      enabled: deps.rateLimit?.enabled ?? true,
      storage: 'database' as const,
      ...rateLimitSchema,
      window: deps.rateLimit?.window ?? 60,
      max: deps.rateLimit?.max ?? 30,
      customRules: {
        '/sign-in/email': { window: 900, max: 5 },
        '/two-factor/verify-totp': { window: 300, max: 5 },
        '/email-otp/send-verification-otp': { window: 600, max: 3 },
        '/sign-in/email-otp': { window: 600, max: 5 },
      },
    },
    advanced: {
      cookiePrefix: policy.cookiePrefix,
      useSecureCookies: deps.useSecureCookies ?? true,
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: { sameSite: policy.sameSite, httpOnly: true, secure: deps.useSecureCookies ?? true },
      // Every Better Auth write path gets a UUIDv7 (some plugin paths ignore `false` and generate their own ids).
      // `joins`: the session and its user are read in one statement instead of two in a row. Every page, route and
      // action reads the session, so the second round trip was paid on every request.
      database: { generateId: () => uuidv7(), joins: true },
    },
    databaseHooks: {
      session: { create: { before: sessionCreateGuard(deps.appDb, surface) } },
    },
  };
}

/**
 * Records step-up verification after every successful TOTP verification and audits auth events.
 * The TOTP verify endpoint either creates a session (sign-in) or verifies within an existing session
 * (enrollment confirmation or step-up); both cases are recorded against the resulting session.
 */
const AUDITED_FAILURES = new Set([
  '/sign-in/email', '/two-factor/verify-totp', '/two-factor/enable', '/sign-in/email-otp', '/email-otp/send-verification-otp',
  '/sign-in/social', '/link-social', '/unlink-account', '/account-email/send',
]);

async function auditFailure(appDb: Db, surface: Surface, path: string, returned: unknown): Promise<void> {
  if (!AUDITED_FAILURES.has(path)) return;
  // `error`, not `code`: the audit redactor masks any key named `code` (it could be an OTP), which would erase the reason.
  const error = (returned as { body?: { code?: string } } | undefined)?.body?.code ?? 'UNKNOWN';
  await appendAuditDirect(appDb, {
    actorType: 'SYSTEM', actorId: null, surface, correlationId: randomUUID(),
    action: 'session.failed', entityType: 'auth_endpoint', entityId: path, after: { error },
  });
}

type OpenedSession = { user: { id: string }; session: { id: string; ipAddress?: string | null | undefined; userAgent?: string | null | undefined } };

/** Migration 0052: the sign-in that opened `s`, with where it came from — kept after the session itself is gone. */
async function signedIn(appDb: Db, ctx: { headers?: Headers | undefined; request?: Request | undefined }, s: OpenedSession, surface: Surface, method: 'EMAIL' | 'TELEGRAM' | 'PASSWORD') {
  await recordSignIn(appDb, {
    userId: s.user.id,
    sessionId: s.session.id,
    surface,
    method,
    origin: originOf(ctx.headers ?? ctx.request?.headers ?? null, s.session.ipAddress ?? null, s.session.userAgent ?? null),
  });
}

function operatorAfterHook(appDb: Db) {
  return createAuthMiddleware(async (ctx) => {
    if (isAPIError(ctx.context.returned)) {
      await auditFailure(appDb, 'OPERATOR', ctx.path, ctx.context.returned);
      return;
    }
    const correlationId = randomUUID();
    const newSession = ctx.context.newSession;
    const current = ctx.context.session;
    if (ctx.path === '/two-factor/verify-totp') {
      const s = newSession ?? current;
      if (!s) return;
      await appDb.insertInto('step_up_verification').values({ user_id: s.user.id, session_id: s.session.id, method: 'TOTP', ip_hash: null }).execute();
      await appendAuditDirect(appDb, {
        actorType: 'USER', actorId: s.user.id, surface: 'OPERATOR', correlationId, sessionId: s.session.id,
        action: newSession && !current ? 'session.login_mfa' : 'session.step_up', entityType: 'auth_session', entityId: s.session.id,
      });
      if (newSession && !current) await signedIn(appDb, ctx, newSession, 'OPERATOR', 'PASSWORD');
      return;
    }
    if (ctx.path === '/sign-in/email' && newSession) {
      await appendAuditDirect(appDb, { actorType: 'USER', actorId: newSession.user.id, surface: 'OPERATOR', correlationId, sessionId: newSession.session.id, action: 'session.login_password_only', entityType: 'auth_session', entityId: newSession.session.id });
      await signedIn(appDb, ctx, newSession, 'OPERATOR', 'PASSWORD');
      return;
    }
    if (ctx.path === '/two-factor/enable' && current) {
      await appendAuditDirect(appDb, { actorType: 'USER', actorId: current.user.id, surface: 'OPERATOR', correlationId, sessionId: current.session.id, action: 'user.mfa_enrollment_started', entityType: 'auth_user', entityId: current.user.id });
      return;
    }
    if (ctx.path === '/sign-out' && current) {
      await appendAuditDirect(appDb, { actorType: 'USER', actorId: current.user.id, surface: 'OPERATOR', correlationId, sessionId: current.session.id, action: 'session.logout', entityType: 'auth_session', entityId: current.session.id });
    }
  });
}

/**
 * Telegram's callback always ends in a redirect: into the workspace with a new session, or back to the page that asked
 * with `?error=` (not linked, cancelled, expired). A link is audited where the account row is written (`account.create`).
 */
async function auditTelegramCallback(appDb: Db, ctx: { context: { newSession?: { user: { id: string }; session: { id: string } } | null; returned?: unknown } }): Promise<void> {
  const s = ctx.context.newSession;
  if (s) {
    await appendAuditDirect(appDb, { actorType: 'USER', actorId: s.user.id, surface: 'CLIENT', correlationId: randomUUID(), sessionId: s.session.id, action: 'session.login_telegram', entityType: 'auth_session', entityId: s.session.id });
    return;
  }
  const location = (ctx.context.returned as { headers?: Headers } | undefined)?.headers?.get?.('location') ?? '';
  const error = /[?&]error=([A-Za-z0-9_]{1,64})/.exec(location)?.[1];
  if (!error) return;
  await appendAuditDirect(appDb, {
    actorType: 'SYSTEM', actorId: null, surface: 'CLIENT', correlationId: randomUUID(),
    action: 'session.failed', entityType: 'auth_endpoint', entityId: `/callback/${TELEGRAM_PROVIDER}`, after: { error: error.toUpperCase() },
  });
}

function clientAfterHook(appDb: Db) {
  return createAuthMiddleware(async (ctx) => {
    if (ctx.path === '/email-otp/send-verification-otp' && (ctx.context as unknown as Record<symbol, boolean>)[OTP_NOT_SENT]) {
      const refused = new APIError('SERVICE_UNAVAILABLE', { message: 'the sign-in code could not be sent', code: 'OTP_NOT_SENT' });
      await auditFailure(appDb, 'CLIENT', ctx.path, refused);
      throw refused;
    }
    if (ctx.path.startsWith('/callback/')) {
      if (ctx.context.newSession) await signedIn(appDb, ctx, ctx.context.newSession, 'CLIENT', 'TELEGRAM');
      await auditTelegramCallback(appDb, ctx as never);
      return;
    }
    if (isAPIError(ctx.context.returned)) {
      await auditFailure(appDb, 'CLIENT', ctx.path, ctx.context.returned);
      return;
    }
    const s = ctx.context.newSession;
    if (ctx.path === '/sign-in/email-otp' && s) {
      await appendAuditDirect(appDb, { actorType: 'USER', actorId: s.user.id, surface: 'CLIENT', correlationId: randomUUID(), sessionId: s.session.id, action: 'session.login_email_otp', entityType: 'auth_session', entityId: s.session.id });
      await signedIn(appDb, ctx, s, 'CLIENT', 'EMAIL');
      return;
    }
    // Confirming a new authenticator replaces the session (Better Auth rotates it): the step-up belongs to the new one.
    const current = s ?? ctx.context.session;
    if (!current) return;
    // A verified authenticator code (or a one-time recovery code) is this session's step-up (SECURITY §2.2).
    if (ctx.path === '/two-factor/verify-totp' || ctx.path === '/two-factor/verify-backup-code') {
      await appDb.insertInto('step_up_verification').values({ user_id: current.user.id, session_id: current.session.id, method: 'TOTP', ip_hash: null }).execute();
      await appendAuditDirect(appDb, {
        actorType: 'USER', actorId: current.user.id, surface: 'CLIENT', correlationId: randomUUID(), sessionId: current.session.id,
        action: ctx.path === '/two-factor/verify-totp' ? 'session.step_up' : 'session.step_up_recovery_code', entityType: 'auth_session', entityId: current.session.id,
      });
      return;
    }
    if (ctx.path === '/two-factor/enable') {
      await appendAuditDirect(appDb, { actorType: 'USER', actorId: current.user.id, surface: 'CLIENT', correlationId: randomUUID(), sessionId: current.session.id, action: 'user.mfa_enrollment_started', entityType: 'auth_user', entityId: current.user.id });
      return;
    }
    if (ctx.path === '/two-factor/generate-backup-codes') {
      await appendAuditDirect(appDb, { actorType: 'USER', actorId: current.user.id, surface: 'CLIENT', correlationId: randomUUID(), sessionId: current.session.id, action: 'user.mfa_recovery_codes_replaced', entityType: 'auth_user', entityId: current.user.id });
      return;
    }
    if (ctx.path === '/sign-out') {
      await appendAuditDirect(appDb, { actorType: 'USER', actorId: current.user.id, surface: 'CLIENT', correlationId: randomUUID(), sessionId: current.session.id, action: 'session.logout', entityType: 'auth_session', entityId: current.session.id });
    }
  });
}

/** Operator (desk) authentication: credential login + mandatory TOTP. No self sign-up, no trusted devices. */
export function operatorAuthOptions(deps: AuthDeps) {
  const base = common(deps, 'OPERATOR');
  return {
    ...base,
    appName: 'INRP2P Exchange Desk',
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12, maxPasswordLength: 256 },
    hooks: {
      // Operators never get "trusted device" 2FA bypass cookies.
      before: createAuthMiddleware(async (ctx) => {
        const body = ctx.body as { trustDevice?: unknown } | undefined;
        if (ctx.path.startsWith('/two-factor/') && body?.trustDevice) {
          throw new APIError('FORBIDDEN', { message: 'trusted devices are not permitted for operators' });
        }
      }),
      after: operatorAfterHook(deps.appDb),
    },
    plugins: [
      twoFactor({
        issuer: 'INRP2P Exchange',
        schema: twoFactorSchema,
        skipVerificationOnEnable: false,
        trustDeviceMaxAge: 1,
        accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 900 },
      }),
    ],
  };
}

export function createOperatorAuth(deps: AuthDeps) {
  return betterAuth(operatorAuthOptions(deps));
}

/** The client-surface endpoints that act on an email address before anyone is signed in. */
const CLIENT_EMAIL_PATHS = new Set(['/email-otp/send-verification-otp', '/sign-in/email-otp', '/email-otp/verify-email', '/email-otp/check-verification-otp']);

/**
 * TD-02: an address that is not an active client's goes nowhere on the client surface — an operator's address, or a
 * disabled one. No code is sent to it and no session is attempted (which used to end in Better Auth's internal error
 * after the session guard refused); the answer is exactly the one an unknown address gets — `{ success: true }` for a
 * code request, the plugin's own "invalid code" for a sign-in — so the response says nothing about whose it is. The
 * session guard and the database trigger (IX020) stay behind it as defence in depth.
 */
/**
 * A first second factor (an account with only its email) may be set up within this long of signing in or of a code —
 * the trust any first factor starts with (`factors.ts`). Also D-20's window for a first destination.
 */
export const CLIENT_MFA_ENROLMENT_MAX_SESSION_AGE_SECONDS = 600;

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/**
 * A domain refusal from `factors.ts`, as Better Auth answers: 403 with the code and, for a step-up, the factors that
 * would confirm it — the page offers exactly those.
 */
function refusal(e: unknown): never {
  if (isDomainError(e)) {
    throw new APIError(e.code === 'UNAUTHENTICATED' ? 'UNAUTHORIZED' : 'FORBIDDEN', { message: e.message, code: e.code, ...e.details });
  }
  throw e;
}

/** ADR 0026: adding, replacing or removing a way in (Telegram, an authenticator) is confirmed first (`requireFactorChange`). */
async function guardFactorChange(appDb: Db, ctx: HookContext): Promise<void> {
  const session = await getSessionFromCtx(ctx);
  if (!session) throw new APIError('UNAUTHORIZED', { message: 'sign in first' });
  await requireFactorChange(appDb, session.session.id).catch(refusal);
}

function clientBeforeHook(appDb: Db, invalidOtp: Parameters<typeof APIError.from>[1]) {
  return createAuthMiddleware(async (ctx) => {
    if (ctx.path.startsWith('/two-factor/')) {
      await guardClientTwoFactor(appDb, ctx);
      return;
    }
    // Telegram is the one provider, and only through its own redirect: an ID token handed in by a page is not taken.
    if (ctx.path === '/sign-in/social' || ctx.path === '/link-social') {
      const body = ctx.body as { provider?: unknown; idToken?: unknown } | undefined;
      if (body?.provider !== TELEGRAM_PROVIDER || body.idToken !== undefined) {
        throw new APIError('BAD_REQUEST', { message: 'sign in with Telegram through Telegram', code: 'PROVIDER_NOT_ALLOWED' });
      }
      if (ctx.path === '/link-social') await guardFactorChange(appDb, ctx);
      return;
    }
    if (ctx.path === '/unlink-account') {
      // An account Telegram opened has no other way in until its email is added: its Telegram stays (ADR 0026).
      const session = await getSessionFromCtx(ctx);
      if (session && isTelegramPlaceholderEmail(session.user.email)) {
        throw new APIError('FORBIDDEN', { message: 'add your email first: Telegram is how you sign in', code: 'ADD_EMAIL_FIRST' });
      }
      await guardFactorChange(appDb, ctx);
      return;
    }
    if (!CLIENT_EMAIL_PATHS.has(ctx.path)) return;
    const raw = (ctx.body as { email?: unknown } | undefined)?.email;
    if (typeof raw !== 'string') return;
    // A Telegram account's stand-in address is nobody's inbox: no code goes there, answered like any address that is not a client's.
    const placeholder = isTelegramPlaceholderEmail(raw);
    const user = placeholder ? null : await appDb.selectFrom('auth_user').select(['kind', 'status']).where('email', '=', raw.trim().toLowerCase()).executeTakeFirst();
    // Unknown addresses go through Better Auth's own handling, which already answers them without enumerating.
    if (!placeholder && (!user || (user.kind === 'CLIENT' && user.status === 'ACTIVE'))) return;
    await appendAuditDirect(appDb, {
      actorType: 'SYSTEM', actorId: null, surface: 'CLIENT', correlationId: randomUUID(),
      action: 'session.failed', entityType: 'auth_endpoint', entityId: ctx.path, after: { error: 'NOT_A_CLIENT_ADDRESS' },
    });
    if (ctx.path === '/email-otp/send-verification-otp') return ctx.json({ success: true });
    throw APIError.from('BAD_REQUEST', invalidOtp);
  });
}

/**
 * TD-11: the client authenticator confirms a client's sensitive changes (SECURITY §2.2), so nothing that would hand it
 * to someone holding only a session is offered on the client surface:
 *
 * - setting one up is a change of factor (ADR 0026): with Telegram linked, a step-up by a factor other than the sign-in
 *   one; with the email alone, a sign-in or code within the last ten minutes. It is refused once one exists;
 * - removing one, or showing its secret again, is not a client action — the desk resets it after verifying who is
 *   asking (`client_user.reset_mfa`), so a stolen session cannot swap the authenticator for its own;
 * - new recovery codes need a fresh step-up with the current authenticator;
 * - trusted devices are not offered: every step-up asks for a code.
 */
async function guardClientTwoFactor(appDb: Db, ctx: HookContext): Promise<void> {
  const body = ctx.body as { trustDevice?: unknown } | undefined;
  if (body?.trustDevice) throw new APIError('FORBIDDEN', { message: 'trusted devices are not offered on the client workspace' });
  if (ctx.path === '/two-factor/disable' || ctx.path === '/two-factor/get-totp-uri') {
    throw new APIError('FORBIDDEN', { message: 'an authenticator is removed or replaced by the desk, after confirming who is asking' });
  }
  if (ctx.path === '/two-factor/enable') {
    await guardFactorChange(appDb, ctx);
    return;
  }
  if (ctx.path === '/two-factor/generate-backup-codes') {
    const session = await getSessionFromCtx(ctx);
    if (!session) throw new APIError('UNAUTHORIZED', { message: 'sign in first' });
    const fresh = await sql<{ fresh: boolean }>`
      select exists (select 1 from step_up_verification where session_id = ${session.session.id} and method = 'TOTP'
                      and verified_at > statement_timestamp() - make_interval(secs => 600)) as fresh`.execute(appDb);
    if (!fresh.rows[0]!.fresh) throw new APIError('FORBIDDEN', { message: 'verify with your authenticator first' });
  }
}

/**
 * Set on a request's own auth context when its sign-in code could not be handed to the email provider. Better Auth
 * runs the sender inside `runInBackgroundOrAwait`, which logs a failure and answers `{ success: true }` regardless —
 * so a client was told "check your email" while no email had left. The after hook turns the mark into a refusal the
 * sign-in surface shows ("we couldn't send a code").
 */
const OTP_NOT_SENT = Symbol('inrp2p.otp_not_sent');

/** What the client surface needs to offer Telegram (ADR 0026). Without it, Telegram is simply not offered. */
export interface ClientTelegram {
  readonly login: TelegramLoginConfig;
  /** The bot's private chat with a person — for their confirmation codes. */
  readonly send: (input: { chatId: string; text: string }) => Promise<void>;
  /** A Telegram was linked or unlinked (the web turns the person's deal alerts on or off with it). Never fails the link. */
  readonly onLinked?: (input: { userId: string; telegramId: string; username: string | null }) => Promise<void>;
  readonly onUnlinked?: (input: { userId: string; telegramId: string }) => Promise<void>;
}

export interface ClientAuthDeps extends AuthDeps {
  readonly otpSender: EmailOtpSender;
  readonly telegram?: ClientTelegram | undefined;
}

/** How each way in is named in the last-sign-in cookie (Better Auth's `lastLoginMethod`). */
function lastSignInOf(ctx: { path?: string }): string | null {
  if (ctx.path === '/sign-in/email-otp') return 'email';
  if (ctx.path?.startsWith('/callback/')) return 'telegram';
  return null;
}

/**
 * A linked Telegram is Better Auth's account row (`telegram`): its id and username, never Telegram's tokens — INRP2P
 * calls nothing on the person's behalf (IX137).
 */
function telegramAccountHooks(deps: ClientAuthDeps) {
  const scrub = (account: Record<string, unknown>) =>
    account.providerId === TELEGRAM_PROVIDER
      ? { data: { ...account, accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null, telegramUsername: telegramUsernameOf(account.idToken as string | undefined) } }
      : undefined;
  const log = (userId: string, action: string, after: Record<string, unknown>) =>
    appendAuditDirect(deps.appDb, { actorType: 'USER', actorId: userId, surface: 'CLIENT', correlationId: randomUUID(), action, entityType: 'auth_user', entityId: userId, after });
  const quietly = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', event: what, message: (e instanceof Error ? e.message : String(e)).slice(0, 200) }));
    }
  };
  return {
    create: {
      before: async (account: Record<string, unknown>) => scrub(account),
      after: async (account: { providerId: string; accountId: string; userId: string } & Record<string, unknown>) => {
        if (account.providerId !== TELEGRAM_PROVIDER) return;
        const username = typeof account.telegramUsername === 'string' ? account.telegramUsername : null;
        await log(account.userId, 'user.telegram_linked', { telegram_username: username });
        if (deps.telegram?.onLinked) await quietly('telegram.on_linked_failed', () => deps.telegram!.onLinked!({ userId: account.userId, telegramId: account.accountId, username }));
      },
    },
    update: { before: async (account: Record<string, unknown>) => scrub(account) },
    delete: {
      after: async (account: { providerId: string; accountId: string; userId: string }, context: { context?: { session?: { session?: { id?: string } } | null } } | null) => {
        if (account.providerId !== TELEGRAM_PROVIDER) return;
        // Whoever disconnects a Telegram may be shutting out someone who has it: every other session it opened ends.
        const current = context?.context?.session?.session?.id ?? null;
        const ended = await deps.appDb
          .deleteFrom('auth_session')
          .where('user_id', '=', account.userId)
          .where('sign_in_method', '=', 'TELEGRAM')
          .$if(current !== null, (q) => q.where('id', '<>', current!))
          .executeTakeFirst();
        await log(account.userId, 'user.telegram_unlinked', { sessions_ended: String(ended.numDeletedRows) });
        if (deps.telegram?.onUnlinked) await quietly('telegram.on_unlinked_failed', () => deps.telegram!.onUnlinked!({ userId: account.userId, telegramId: account.accountId }));
      },
    },
  };
}

/**
 * A person Telegram is opening an account for (ADR 0026, amended 2026-11-22): Better Auth creates them from Telegram's
 * profile with a placeholder address, and they are a client — an identity with no client, no role and no permission,
 * exactly what the email door creates (`ensureClientIdentity`); the account itself is opened on `/open-account`. A user
 * the client surface creates is a client (`kind` defaults to CLIENT here); the email code never creates one.
 */
function clientUserHooks(appDb: Db) {
  return {
    create: {
      before: async (user: { email: string } & Record<string, unknown>) => {
        if (!isTelegramPlaceholderEmail(user.email)) return;
        return { data: { ...user, kind: 'CLIENT', status: 'ACTIVE', emailVerified: false } };
      },
      after: async (user: { id: string; email: string }) => {
        if (!isTelegramPlaceholderEmail(user.email)) return;
        await appendAuditDirect(appDb, {
          actorType: 'SYSTEM', actorId: null, surface: 'CLIENT', correlationId: randomUUID(),
          action: 'client_user.identity_created', entityType: 'auth_user', entityId: user.id, after: { via: 'telegram' },
        });
      },
    },
  };
}

/**
 * Client authentication (ADR 0026): an email code (hashed at rest), or Telegram's own sign-in. An email opens an
 * account through the workspace's access step; Telegram opens one by itself, with a placeholder address until the person
 * adds theirs (`add-email.ts`); a Telegram linked from inside signs in the account it was linked to. A session lasts
 * (SESSION_POLICY); what matters is confirmed again by another factor (`factors.ts`, `/step-up/*`).
 */
export function clientAuthOptions(deps: ClientAuthDeps) {
  const base = common(deps, 'CLIENT');
  const otp = emailOTP({
    otpLength: 6,
    expiresIn: 600,
    allowedAttempts: 5,
    storeOTP: 'hashed',
    disableSignUp: true,
    sendVerificationOTP: async ({ email, otp: code, type }: { email: string; otp: string; type: string }, ctx?: { context?: object }) => {
      try {
        await deps.otpSender.send({ email, otp: code, type });
      } catch (e) {
        if (ctx?.context) (ctx.context as Record<symbol, boolean>)[OTP_NOT_SENT] = true;
        // The reason, never the code or the address (SECURITY §5).
        console.error(JSON.stringify({ level: 'error', event: 'client_otp.not_sent', reason: (e instanceof Error ? e.message : String(e)).split(':')[0]!.slice(0, 80) }));
        throw e;
      }
    },
  });
  const telegram = deps.telegram;
  return {
    ...base,
    appName: 'INRP2P Exchange',
    emailAndPassword: { enabled: false },
    // Whoever the client surface creates is a client: Telegram's own sign-up passes no kind (ADR 0026).
    user: { ...base.user, additionalFields: { ...userAdditional, kind: { ...userAdditional.kind, defaultValue: 'CLIENT' } } },
    session: {
      ...base.session,
      // Unlinking a Telegram is guarded by a step-up of its own (ADR 0026), not by how old the session is.
      freshAge: 0,
    },
    account: {
      ...accountSchema,
      additionalFields: { telegramUsername: { type: 'string' as const, required: false, input: false, fieldName: 'telegram_username' } },
      // Linking happens only from inside a signed-in session (`/link-social`), never by matching an address.
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        trustedProviders: [TELEGRAM_PROVIDER],
        allowDifferentEmails: true,
        allowUnlinkingAll: true,
        updateUserInfoOnLink: false,
      },
      updateAccountOnSignIn: false,
    },
    rateLimit: {
      ...base.rateLimit,
      customRules: {
        ...base.rateLimit.customRules,
        '/sign-in/social': { window: 600, max: 10 },
        '/link-social': { window: 600, max: 10 },
        [`/callback/${TELEGRAM_PROVIDER}`]: { window: 600, max: 20 },
      },
    },
    databaseHooks: { ...base.databaseHooks, user: clientUserHooks(deps.appDb), account: telegramAccountHooks(deps) },
    hooks: { before: clientBeforeHook(deps.appDb, otp.$ERROR_CODES.INVALID_OTP), after: clientAfterHook(deps.appDb) },
    plugins: [
      otp,
      twoFactor({
        issuer: 'INRP2P Exchange',
        schema: twoFactorSchema,
        // Clients sign in with a code and have no password to re-enter; the guard above asks for a confirmation instead.
        allowPasswordless: true,
        skipVerificationOnEnable: false,
        trustDeviceMaxAge: 1,
        accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 900 },
      }),
      stepUpCodes({ appDb: deps.appDb, secret: deps.secret, senders: { email: deps.otpSender, ...(telegram ? { telegram: { send: telegram.send } } : {}) } satisfies StepUpCodeSenders }),
      addEmail({ appDb: deps.appDb, secret: deps.secret, sender: deps.otpSender, onTelegramMoved: telegram?.onLinked }),
      // The device remembers how the person signed in last, so the sign-in page offers that first. A name, never an address.
      lastLoginMethod({ cookieName: LAST_SIGN_IN_COOKIE, maxAge: 365 * 24 * 3600, customResolveMethod: lastSignInOf }),
      ...(telegram ? [genericOAuth({ config: [telegramOAuthProvider(telegram.login)] })] : []),
    ],
  };
}

export function createClientAuth(deps: ClientAuthDeps) {
  return betterAuth(clientAuthOptions(deps));
}

export type OperatorAuth = ReturnType<typeof createOperatorAuth>;
export type ClientAuth = ReturnType<typeof createClientAuth>;
