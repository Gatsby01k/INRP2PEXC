import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api';
import { emailOTP, twoFactor } from 'better-auth/plugins';
import type { Kysely } from 'kysely';
import { uuidv7 } from '@inrp2p/kernel';
import type { Db } from '@inrp2p/db';
import { appendAuditDirect } from '@inrp2p/audit';
import { accountSchema, rateLimitSchema, sessionSchema, twoFactorSchema, userSchema, verificationSchema } from './schema-mapping.ts';

export type Surface = 'OPERATOR' | 'CLIENT';

/** Session policy (SECURITY §2.1 / §2.2). Absolute lifetime is enforced by Better Auth; idle timeout by the INRP2P guard. */
export const SESSION_POLICY = {
  OPERATOR: { absoluteSeconds: 12 * 3600, idleSeconds: 30 * 60, sameSite: 'strict' as const, cookiePrefix: 'inrp2p-desk' },
  CLIENT: { absoluteSeconds: 7 * 24 * 3600, idleSeconds: 60 * 60, sameSite: 'lax' as const, cookiePrefix: 'inrp2p-app' },
} as const;

export interface EmailOtpSender {
  /** Delivers a client login OTP. Never persisted outside Better Auth's hashed verification row. */
  send(input: { email: string; otp: string; type: string }): Promise<void>;
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
  return { surface: { type: 'string' as const, required: true, input: false, defaultValue: surface, fieldName: 'surface' } };
}

const userAdditional = {
  kind: { type: 'string' as const, required: true, input: false, fieldName: 'kind' },
  status: { type: 'string' as const, required: false, input: false, defaultValue: 'ACTIVE', fieldName: 'status' },
};

/** Blocks session creation for users of the wrong kind or disabled users (defense in depth with DB trigger IX020). */
function sessionCreateGuard(appDb: Db, surface: Surface) {
  return async (session: { userId: string }) => {
    const user = await appDb.selectFrom('auth_user').select(['kind', 'status']).where('id', '=', session.userId).executeTakeFirst();
    if (!user || user.kind !== surface || user.status !== 'ACTIVE') return false;
    return { data: { ...session, surface } };
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
      database: { generateId: () => uuidv7() },
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
const AUDITED_FAILURES = new Set(['/sign-in/email', '/two-factor/verify-totp', '/two-factor/enable', '/sign-in/email-otp', '/email-otp/send-verification-otp']);

async function auditFailure(appDb: Db, surface: Surface, path: string, returned: unknown): Promise<void> {
  if (!AUDITED_FAILURES.has(path)) return;
  const code = (returned as { body?: { code?: string } } | undefined)?.body?.code ?? 'UNKNOWN';
  await appendAuditDirect(appDb, {
    actorType: 'SYSTEM', actorId: null, surface, correlationId: randomUUID(),
    action: 'session.failed', entityType: 'auth_endpoint', entityId: path, after: { code },
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
      return;
    }
    if (ctx.path === '/sign-in/email' && newSession) {
      await appendAuditDirect(appDb, { actorType: 'USER', actorId: newSession.user.id, surface: 'OPERATOR', correlationId, sessionId: newSession.session.id, action: 'session.login_password_only', entityType: 'auth_session', entityId: newSession.session.id });
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

function clientAfterHook(appDb: Db) {
  return createAuthMiddleware(async (ctx) => {
    if (isAPIError(ctx.context.returned)) {
      await auditFailure(appDb, 'CLIENT', ctx.path, ctx.context.returned);
      return;
    }
    const s = ctx.context.newSession;
    if (ctx.path === '/sign-in/email-otp' && s) {
      await appendAuditDirect(appDb, { actorType: 'USER', actorId: s.user.id, surface: 'CLIENT', correlationId: randomUUID(), sessionId: s.session.id, action: 'session.login_email_otp', entityType: 'auth_session', entityId: s.session.id });
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

/** Client authentication: passwordless email OTP (hashed at rest), no self sign-up. */
export function clientAuthOptions(deps: AuthDeps & { otpSender: EmailOtpSender }) {
  const base = common(deps, 'CLIENT');
  return {
    ...base,
    appName: 'INRP2P Exchange',
    emailAndPassword: { enabled: false },
    hooks: { after: clientAfterHook(deps.appDb) },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        allowedAttempts: 5,
        storeOTP: 'hashed',
        disableSignUp: true,
        sendVerificationOTP: async ({ email, otp, type }: { email: string; otp: string; type: string }) => deps.otpSender.send({ email, otp, type }),
      }),
    ],
  };
}

export function createClientAuth(deps: AuthDeps & { otpSender: EmailOtpSender }) {
  return betterAuth(clientAuthOptions(deps));
}

export type OperatorAuth = ReturnType<typeof createOperatorAuth>;
export type ClientAuth = ReturnType<typeof createClientAuth>;
