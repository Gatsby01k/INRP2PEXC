import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import { sql } from 'kysely';
import type { Db } from '@inrp2p/db';
import { appendAuditDirect } from '@inrp2p/audit';
import { isDomainError } from '@inrp2p/kernel';
import { requireFactorChange } from './factors.ts';
import { STEP_UP_CODE_ATTEMPTS, STEP_UP_CODE_SECONDS } from './step-up-codes.ts';
import { TELEGRAM_PLACEHOLDER_DOMAIN, TELEGRAM_PROVIDER, isTelegramPlaceholderEmail } from './telegram.ts';

/**
 * Adding an email to an account Telegram opened (ADR 0026, amended 2026-11-22). Such an account has a placeholder
 * address and so only one factor, its Telegram; its email becomes the second — a way to sign in, and the code that
 * confirms what a Telegram session alone must not.
 *
 * Adding it is a change of factor (`requireFactorChange`): within ten minutes of signing in, or after a code by the bot.
 * A code goes to the address — whoever it belongs to, so the answer never says whether an address has an account — and
 * only a right code says what happens next:
 *
 * - nobody has that address: it becomes this account's, verified;
 * - it is the address of an account opened by email earlier, and this Telegram account is still empty (no client, no
 *   application): the person holds both, so the Telegram moves to that account — exactly what signing in by email and
 *   connecting Telegram there would have done — and this empty one is closed. That account must have no Telegram and no
 *   authenticator of its own: a second factor already guarding it is never bypassed by an inbox and a Telegram;
 * - otherwise it is refused (`EMAIL_HAS_ACCOUNT`): two accounts that both hold something are never joined here.
 */
export const ADD_EMAIL_PURPOSE = 'add this email to your INRP2P account';

const identifierOf = (sessionId: string) => `inrp2p-add-email:${sessionId}`;
const ADDRESS = /^[^\s@<>"'()]+@[^\s@<>"'()]+\.[^\s@<>"'()]+$/;

interface Stored {
  readonly h: string;
  /** The address the code went to. */
  readonly e: string;
  readonly n: number;
}

const maskEmail = (email: string) => {
  const at = email.lastIndexOf('@');
  return at <= 0 ? email : `${email.slice(0, 1)}•••${email.slice(at)}`;
};

export interface AddEmailDeps {
  readonly appDb: Db;
  readonly secret: string;
  readonly sender: { send(input: { email: string; otp: string; type: string; purpose?: string }): Promise<void> };
  /** The Telegram moved to the account its person already had (the web turns that account's deal alerts on). Never fails the move. */
  readonly onTelegramMoved?: ((input: { userId: string; telegramId: string; username: string | null }) => Promise<void>) | undefined;
}

export type AddEmailOutcome = { readonly added: true } | { readonly merged: true };

export function addEmail(deps: AddEmailDeps) {
  const digest = (email: string, code: string) => createHmac('sha256', deps.secret).update(`inrp2p-add-email:${email}:${code}`).digest('hex');
  const audit = (userId: string, sessionId: string | null, action: string, after: Record<string, unknown> = {}) =>
    appendAuditDirect(deps.appDb, { actorType: 'USER', actorId: userId, surface: 'CLIENT', correlationId: randomUUID(), ...(sessionId ? { sessionId } : {}), action, entityType: 'auth_user', entityId: userId, after });
  const alreadySet = () => new APIError('BAD_REQUEST', { message: 'this account already has its email', code: 'EMAIL_ALREADY_SET' });

  return {
    id: 'inrp2p-add-email',
    endpoints: {
      sendAddEmailCode: createAuthEndpoint('/account-email/send', { method: 'POST', use: [sessionMiddleware] }, async (ctx) => {
        const { session, user } = ctx.context.session;
        if (!isTelegramPlaceholderEmail(user.email)) throw alreadySet();
        const raw = (ctx.body as { email?: unknown } | undefined)?.email;
        const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
        if (email.length > 254 || !ADDRESS.test(email) || isTelegramPlaceholderEmail(email)) {
          throw new APIError('BAD_REQUEST', { message: 'enter your full email, like name@example.com', code: 'INVALID_EMAIL' });
        }
        try {
          await requireFactorChange(deps.appDb, session.id);
        } catch (e) {
          if (isDomainError(e)) throw new APIError(e.code === 'UNAUTHENTICATED' ? 'UNAUTHORIZED' : 'FORBIDDEN', { message: e.message, code: e.code, ...e.details });
          throw e;
        }

        const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        const identifier = identifierOf(session.id);
        await ctx.context.internalAdapter.deleteVerificationByIdentifier(identifier);
        await ctx.context.internalAdapter.createVerificationValue({
          identifier,
          value: JSON.stringify({ h: digest(email, code), e: email, n: 0 } satisfies Stored),
          expiresAt: new Date(Date.now() + STEP_UP_CODE_SECONDS * 1000),
        });
        try {
          await deps.sender.send({ email, otp: code, type: 'step-up', purpose: ADD_EMAIL_PURPOSE });
        } catch (e) {
          await ctx.context.internalAdapter.deleteVerificationByIdentifier(identifier);
          // The reason, never the code or the address (SECURITY §5).
          const reason = (e instanceof Error ? e.message : String(e)).split(':')[0]!.slice(0, 80);
          console.error(JSON.stringify({ level: 'error', event: 'add_email_code.not_sent', reason }));
          await audit(user.id, session.id, 'session.failed', { error: 'ADD_EMAIL_CODE_NOT_SENT' });
          throw new APIError('SERVICE_UNAVAILABLE', { message: 'the code could not be sent', code: 'CODE_NOT_SENT' });
        }
        await audit(user.id, session.id, 'user.email_code_sent');
        return ctx.json({ sent: true, to: maskEmail(email), expiresIn: STEP_UP_CODE_SECONDS });
      }),

      verifyAddEmailCode: createAuthEndpoint('/account-email/verify', { method: 'POST', use: [sessionMiddleware] }, async (ctx) => {
        const raw = (ctx.body as { code?: unknown } | undefined)?.code;
        const code = typeof raw === 'string' ? raw.replace(/\D/g, '') : '';
        const { session, user } = ctx.context.session;
        if (!isTelegramPlaceholderEmail(user.email)) throw alreadySet();
        const identifier = identifierOf(session.id);
        const refuse = async (error: string) => {
          await audit(user.id, session.id, 'session.failed', { error });
          throw new APIError('BAD_REQUEST', { message: 'that code was not accepted', code: 'INVALID_CODE' });
        };
        const row = await ctx.context.internalAdapter.findVerificationValue(identifier);
        if (!row || new Date(row.expiresAt).getTime() <= Date.now()) return refuse('ADD_EMAIL_CODE_EXPIRED');
        let stored: Stored;
        try {
          stored = JSON.parse(row.value) as Stored;
        } catch {
          return refuse('ADD_EMAIL_CODE_INVALID');
        }
        if (stored.n >= STEP_UP_CODE_ATTEMPTS) {
          await ctx.context.internalAdapter.deleteVerificationByIdentifier(identifier);
          return refuse('ADD_EMAIL_CODE_ATTEMPTS');
        }
        const given = Buffer.from(digest(stored.e, code.length === 6 ? code : 'x'));
        const right = Buffer.from(stored.h);
        if (code.length !== 6 || given.length !== right.length || !timingSafeEqual(given, right)) {
          await ctx.context.internalAdapter.updateVerificationByIdentifier(identifier, { value: JSON.stringify({ ...stored, n: stored.n + 1 } satisfies Stored) });
          return refuse('ADD_EMAIL_CODE_WRONG');
        }
        const consumed = await ctx.context.internalAdapter.consumeVerificationValue(identifier);
        if (!consumed || consumed.id !== row.id) return refuse('ADD_EMAIL_CODE_SPENT');

        const email = stored.e;
        const outcome = await deps.appDb.transaction().execute(async (tx) => {
          // Two accounts adding one address at once: the second waits, then finds it taken.
          await sql`select pg_advisory_xact_lock(hashtext(${`inrp2p.add-email:${email}`}))`.execute(tx);
          const me = await tx.selectFrom('auth_user').select(['email']).where('id', '=', user.id).forUpdate().executeTakeFirst();
          if (!me || !isTelegramPlaceholderEmail(me.email)) return { kind: 'ALREADY_SET' as const };
          const owner = await tx.selectFrom('auth_user').select(['id', 'kind', 'status', 'two_factor_enabled']).where('email', '=', email).forUpdate().executeTakeFirst();

          if (!owner) {
            await tx.updateTable('auth_user').set({ email, email_verified: true }).where('id', '=', user.id).execute();
            // The code to this inbox, in this session, is a confirmation by the email (`factors.ts` decides what it counts for).
            await tx.insertInto('step_up_verification').values({ user_id: user.id, session_id: session.id, method: 'EMAIL', ip_hash: null }).execute();
            return { kind: 'ADDED' as const };
          }

          const [telegram, member, ownerTelegram] = await Promise.all([
            tx.selectFrom('auth_account').select(['account_id', 'telegram_username']).where('user_id', '=', user.id).where('provider_id', '=', TELEGRAM_PROVIDER).executeTakeFirst(),
            tx.selectFrom('client_user').select('id').where('user_id', '=', user.id).executeTakeFirst(),
            tx.selectFrom('auth_account').select('id').where('user_id', '=', owner.id).where('provider_id', '=', TELEGRAM_PROVIDER).executeTakeFirst(),
          ]);
          const joinable = telegram && !member && !ownerTelegram && owner.kind === 'CLIENT' && owner.status === 'ACTIVE' && owner.two_factor_enabled !== true;
          if (!joinable) return { kind: 'TAKEN' as const };

          // The person proved this inbox now: the account it opened has a verified email, which may hold a Telegram (IX136).
          await tx.updateTable('auth_user').set({ email_verified: true }).where('id', '=', owner.id).execute();
          await tx.updateTable('auth_account').set({ user_id: owner.id, updated_at: new Date() }).where('user_id', '=', user.id).where('provider_id', '=', TELEGRAM_PROVIDER).execute();
          // The empty account Telegram opened is closed: no way in, its address freed for nobody, its sessions ended.
          await tx
            .updateTable('auth_user')
            .set({ email: `joined-${user.id}@${TELEGRAM_PLACEHOLDER_DOMAIN}`, status: 'DISABLED' })
            .where('id', '=', user.id)
            .execute();
          await tx.deleteFrom('auth_session').where('user_id', '=', user.id).execute();
          return { kind: 'MERGED' as const, ownerId: owner.id, telegramId: telegram.account_id, username: telegram.telegram_username };
        });

        if (outcome.kind === 'ALREADY_SET') throw alreadySet();
        if (outcome.kind === 'TAKEN') {
          await audit(user.id, session.id, 'session.failed', { error: 'EMAIL_HAS_ACCOUNT' });
          throw new APIError('CONFLICT', { message: 'this email already has its own INRP2P account', code: 'EMAIL_HAS_ACCOUNT' });
        }
        if (outcome.kind === 'ADDED') {
          await audit(user.id, session.id, 'user.email_added');
          return ctx.json({ added: true } satisfies AddEmailOutcome);
        }
        await audit(user.id, null, 'client_user.identity_joined', { into: outcome.ownerId });
        await audit(outcome.ownerId, null, 'user.telegram_linked', { telegram_username: outcome.username, via: 'joined' });
        if (deps.onTelegramMoved) {
          await deps.onTelegramMoved({ userId: outcome.ownerId, telegramId: outcome.telegramId, username: outcome.username }).catch((e: unknown) => {
            console.error(JSON.stringify({ level: 'error', event: 'telegram.on_linked_failed', reason: (e instanceof Error ? e.message : String(e)).split(':')[0]!.slice(0, 80) }));
          });
        }
        return ctx.json({ merged: true } satisfies AddEmailOutcome);
      }),
    },
    rateLimit: [
      { pathMatcher: (path: string) => path === '/account-email/send', window: 600, max: 5 },
      { pathMatcher: (path: string) => path === '/account-email/verify', window: 300, max: 10 },
    ],
  } satisfies BetterAuthPlugin;
}
