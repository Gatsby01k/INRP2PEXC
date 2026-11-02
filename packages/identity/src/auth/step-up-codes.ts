import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import type { Db } from '@inrp2p/db';
import { appendAuditDirect } from '@inrp2p/audit';
import { TELEGRAM_PROVIDER } from './telegram.ts';

/**
 * Confirming a sensitive change with a code (ADR 0026): six digits sent to the person's email or, once linked, by the
 * bot to their Telegram — beside the authenticator, which keeps its own Better Auth endpoint. The same shape as that
 * one: a Better Auth endpoint of the client surface, under its rate limits, and a verified code is this session's
 * step-up (`step_up_verification`, with the factor that gave it).
 *
 * One code waits per session; a new one replaces it. It is stored only as an HMAC under the client auth secret, lives
 * five minutes, allows five tries, and is spent by the first right one. What a code may then confirm is not decided
 * here: `factors.ts` counts it only when it is not the factor the session was opened with.
 */
export type CodeChannel = 'EMAIL' | 'TELEGRAM';
export const STEP_UP_CODE_SECONDS = 300;
export const STEP_UP_CODE_ATTEMPTS = 5;

/** What the code is for, said in its message. A fixed list: nothing a page sends is ever written into it. */
export const STEP_UP_PURPOSES = {
  DESTINATION: 'add or archive a bank account or wallet',
  WITHDRAWAL: 'withdraw from your reserve',
  SETTLEMENT: 'change your settlement details',
  TEAM: 'change who may act for your account',
  SECURITY: 'change how you sign in',
  CHANGE: 'confirm a change in your workspace',
} as const;
export type StepUpPurpose = keyof typeof STEP_UP_PURPOSES;

export interface StepUpCodeSenders {
  /** The client sign-in email sender, with `type: 'step-up'`. */
  readonly email: { send(input: { email: string; otp: string; type: string; purpose?: string }): Promise<void> };
  /** The bot's private chat with a person (their Telegram user id). Absent when no bot is configured. */
  readonly telegram?: { send(input: { chatId: string; text: string }): Promise<void> } | undefined;
}

const identifierOf = (sessionId: string) => `inrp2p-step-up:${sessionId}`;

interface Stored {
  readonly h: string;
  readonly c: CodeChannel;
  readonly n: number;
}

const maskEmail = (email: string) => {
  const at = email.lastIndexOf('@');
  return at <= 0 ? email : `${email.slice(0, 1)}•••${email.slice(at)}`;
};

export function telegramCodeText(code: string, purpose: StepUpPurpose): string {
  return [
    `INRP2P code: ${code}`,
    '',
    `It confirms that you want to ${STEP_UP_PURPOSES[purpose]}. It expires in 5 minutes.`,
    'Never share it — INRP2P never asks for it. If you did not ask for it, ignore this message and sign out of devices you do not recognise.',
  ].join('\n');
}

export function stepUpCodes(deps: { appDb: Db; secret: string; senders: StepUpCodeSenders }) {
  const digest = (code: string) => createHmac('sha256', deps.secret).update(`inrp2p-step-up:${code}`).digest('hex');
  const audit = (userId: string, sessionId: string, action: string, after: Record<string, unknown>) =>
    appendAuditDirect(deps.appDb, { actorType: 'USER', actorId: userId, surface: 'CLIENT', correlationId: randomUUID(), sessionId, action, entityType: 'auth_session', entityId: sessionId, after });

  return {
    id: 'inrp2p-step-up-codes',
    endpoints: {
      sendStepUpCode: createAuthEndpoint('/step-up/send', { method: 'POST', use: [sessionMiddleware] }, async (ctx) => {
        const body = (ctx.body ?? {}) as { channel?: unknown; purpose?: unknown };
        const channel = body.channel === 'EMAIL' || body.channel === 'TELEGRAM' ? body.channel : null;
        if (!channel) throw new APIError('BAD_REQUEST', { message: 'choose where the code goes', code: 'INVALID_CHANNEL' });
        const purpose: StepUpPurpose = typeof body.purpose === 'string' && body.purpose in STEP_UP_PURPOSES ? (body.purpose as StepUpPurpose) : 'CHANGE';
        const { session, user } = ctx.context.session;

        let to: string;
        let deliver: (code: string) => Promise<void>;
        if (channel === 'EMAIL') {
          to = maskEmail(user.email);
          deliver = (code) => deps.senders.email.send({ email: user.email, otp: code, type: 'step-up', purpose: STEP_UP_PURPOSES[purpose] });
        } else {
          const bot = deps.senders.telegram;
          if (!bot) throw new APIError('SERVICE_UNAVAILABLE', { message: 'Telegram is not available just now', code: 'TELEGRAM_UNAVAILABLE' });
          const linked = await deps.appDb.selectFrom('auth_account').select(['account_id', 'telegram_username']).where('user_id', '=', user.id).where('provider_id', '=', TELEGRAM_PROVIDER).executeTakeFirst();
          if (!linked) throw new APIError('BAD_REQUEST', { message: 'no Telegram is linked to this account', code: 'TELEGRAM_NOT_LINKED' });
          to = linked.telegram_username ? `@${linked.telegram_username}` : 'your Telegram';
          deliver = (code) => bot.send({ chatId: linked.account_id, text: telegramCodeText(code, purpose) });
        }

        const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        const identifier = identifierOf(session.id);
        await ctx.context.internalAdapter.deleteVerificationByIdentifier(identifier);
        await ctx.context.internalAdapter.createVerificationValue({
          identifier,
          value: JSON.stringify({ h: digest(code), c: channel, n: 0 } satisfies Stored),
          expiresAt: new Date(Date.now() + STEP_UP_CODE_SECONDS * 1000),
        });
        try {
          await deliver(code);
        } catch (e) {
          await ctx.context.internalAdapter.deleteVerificationByIdentifier(identifier);
          // The reason, never the code or the address (SECURITY §5).
          const reason = (e instanceof Error ? (e as Error & { code?: string }).code ?? e.message : String(e)).split(':')[0]!.slice(0, 80);
          console.error(JSON.stringify({ level: 'error', event: 'step_up_code.not_sent', channel, reason }));
          await audit(user.id, session.id, 'session.failed', { error: 'STEP_UP_CODE_NOT_SENT', channel });
          throw new APIError('SERVICE_UNAVAILABLE', {
            message: channel === 'TELEGRAM' ? 'Telegram did not take the message' : 'the code could not be sent',
            code: channel === 'TELEGRAM' && reason === 'TELEGRAM_BLOCKED' ? 'TELEGRAM_BLOCKED' : 'CODE_NOT_SENT',
          });
        }
        await audit(user.id, session.id, 'session.step_up_code_sent', { channel, purpose });
        return ctx.json({ sent: true, channel, to, expiresIn: STEP_UP_CODE_SECONDS });
      }),

      verifyStepUpCode: createAuthEndpoint('/step-up/verify', { method: 'POST', use: [sessionMiddleware] }, async (ctx) => {
        const raw = (ctx.body as { code?: unknown } | undefined)?.code;
        const code = typeof raw === 'string' ? raw.replace(/\D/g, '') : '';
        const { session, user } = ctx.context.session;
        const identifier = identifierOf(session.id);
        const refuse = async (error: string) => {
          await audit(user.id, session.id, 'session.failed', { error });
          throw new APIError('BAD_REQUEST', { message: 'that code was not accepted', code: 'INVALID_CODE' });
        };
        const row = await ctx.context.internalAdapter.findVerificationValue(identifier);
        if (!row || new Date(row.expiresAt).getTime() <= Date.now()) return refuse('STEP_UP_CODE_EXPIRED');
        let stored: Stored;
        try {
          stored = JSON.parse(row.value) as Stored;
        } catch {
          return refuse('STEP_UP_CODE_INVALID');
        }
        if (stored.n >= STEP_UP_CODE_ATTEMPTS) {
          await ctx.context.internalAdapter.deleteVerificationByIdentifier(identifier);
          return refuse('STEP_UP_CODE_ATTEMPTS');
        }
        const given = Buffer.from(digest(code.length === 6 ? code : 'x'));
        const right = Buffer.from(stored.h);
        if (code.length !== 6 || given.length !== right.length || !timingSafeEqual(given, right)) {
          await ctx.context.internalAdapter.updateVerificationByIdentifier(identifier, { value: JSON.stringify({ ...stored, n: stored.n + 1 } satisfies Stored) });
          return refuse('STEP_UP_CODE_WRONG');
        }
        // Spent once: of two requests with the right code, only the one that takes the row confirms.
        const consumed = await ctx.context.internalAdapter.consumeVerificationValue(identifier);
        if (!consumed || consumed.id !== row.id) return refuse('STEP_UP_CODE_SPENT');
        await deps.appDb.insertInto('step_up_verification').values({ user_id: user.id, session_id: session.id, method: stored.c, ip_hash: null }).execute();
        await audit(user.id, session.id, 'session.step_up', { method: stored.c });
        return ctx.json({ verified: true, method: stored.c });
      }),
    },
    rateLimit: [
      { pathMatcher: (path: string) => path === '/step-up/send', window: 600, max: 5 },
      { pathMatcher: (path: string) => path === '/step-up/verify', window: 300, max: 10 },
    ],
  } satisfies BetterAuthPlugin;
}
