import { sql } from 'kysely';
import { DomainError } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';
import { STEP_UP_MAX_AGE_SECONDS } from '../rbac/matrix.ts';
import type { StepUpPurpose } from './step-up-codes.ts';
import { TELEGRAM_PLACEHOLDER_DOMAIN } from './telegram.ts';

/**
 * How a client proves it is them (ADR 0026). Three factors, each a different thing the person holds:
 *
 * - `EMAIL` — their inbox: a six-digit code sent to their address. Every account opened by email has it; an account
 *   Telegram opened has it once the person adds their email (`add-email.ts`) — until then its address is a placeholder.
 * - `TELEGRAM` — their Telegram, once it opened the account or was linked from Account & security: Telegram's own
 *   sign-in, and a code sent by the bot.
 * - `TOTP` — an authenticator app, for whoever sets one up.
 *
 * A session is opened with EMAIL or TELEGRAM, and then lasts (SESSION_POLICY). What would move money somewhere new — a
 * bank account or wallet, a withdrawal, new settlement details, who may commit the account, a new way in — is confirmed
 * again, within ten minutes, by a factor **other than the one the session was opened with**. So whoever holds only the
 * inbox, only the Telegram, or only a stolen cookie can sign in and look, and never redirect anything.
 */
export type Factor = 'EMAIL' | 'TELEGRAM' | 'TOTP';
export type SignInMethod = 'EMAIL' | 'TELEGRAM' | 'PASSWORD';

/**
 * - `INDEPENDENT`: a fresh step-up by another factor than the sign-in one (the authenticator always is one).
 * - `RECENT`: signed in, or confirmed by any factor, within the window — for a first destination (D-20) and for the
 *   first second factor of an account that has only its email: there is nothing older to protect or ask.
 */
export type ConfirmationRequirement = 'INDEPENDENT' | 'RECENT';

/** What confirmed a change, as the audit records it. */
export type Confirmation = Factor | 'EMAIL_SIGN_IN' | 'TELEGRAM_SIGN_IN';

export interface SessionFactors {
  readonly signInMethod: 'EMAIL' | 'TELEGRAM';
  /** The factors this person has: the email once it is a real address, Telegram once linked, the authenticator once enrolled. */
  readonly available: readonly Factor[];
  /** The ones a step-up may use to count as independent of this session's sign-in — in the order they are offered. */
  readonly independent: readonly Factor[];
  /** The factor of a fresh step-up independent of the sign-in, if there is one. */
  readonly freshIndependent: Factor | null;
  /** What made the session recent — a fresh step-up of any factor, or the sign-in itself — or null. */
  readonly recentBy: Confirmation | null;
}

interface FactorsRow {
  sign_in_method: 'EMAIL' | 'TELEGRAM';
  email: boolean;
  totp: boolean;
  telegram: boolean;
  /** The factors of this session's step-ups inside the window, the latest first. */
  fresh: Factor[];
  signed_in_recently: boolean;
}

/** Telegram first: on a phone its code arrives as a notification. The authenticator last: not everyone has one. */
const ORDER: readonly Factor[] = ['TELEGRAM', 'EMAIL', 'TOTP'];

/** One statement: how the session was opened, what the person has, and what was confirmed in this session lately. */
export async function sessionFactors(ex: Executor, sessionId: string): Promise<SessionFactors> {
  const r = await sql<FactorsRow>`
    select coalesce(s.sign_in_method, 'EMAIL') as sign_in_method,
           u.email not like ${`%@${TELEGRAM_PLACEHOLDER_DOMAIN}`} as email,
           coalesce(u.two_factor_enabled, false) as totp,
           exists (select 1 from auth_account a where a.user_id = s.user_id and a.provider_id = 'telegram') as telegram,
           array(select v.method from step_up_verification v
                  where v.session_id = s.id and v.verified_at > statement_timestamp() - make_interval(secs => ${STEP_UP_MAX_AGE_SECONDS})
                  order by v.verified_at desc) as fresh,
           s.created_at > statement_timestamp() - make_interval(secs => ${STEP_UP_MAX_AGE_SECONDS}) as signed_in_recently
    from auth_session s
    join auth_user u on u.id = s.user_id
    where s.id = ${sessionId} and s.surface = 'CLIENT' and s.expires_at > statement_timestamp()`.execute(ex);
  const row = r.rows[0];
  if (!row) throw new DomainError('UNAUTHENTICATED', 'this session has ended; sign in again');
  const has: Record<Factor, boolean> = { EMAIL: row.email, TELEGRAM: row.telegram, TOTP: row.totp };
  const available = ORDER.filter((f) => has[f]);
  // A step-up counts only by a factor the person still has: an authenticator the desk has since reset, or a Telegram
  // since disconnected, confirms nothing more.
  const fresh = row.fresh.filter((f) => has[f]);
  const latest = fresh[0];
  return {
    signInMethod: row.sign_in_method,
    available,
    independent: available.filter((f) => f !== row.sign_in_method),
    freshIndependent: fresh.find((f) => f !== row.sign_in_method) ?? null,
    recentBy: latest ?? (row.signed_in_recently ? `${row.sign_in_method}_SIGN_IN` : null),
  };
}

/**
 * The confirmation a sensitive change needs, or the refusal that says how to give one: `STEP_UP_REQUIRED` with the
 * factors that would do (`details.factors`, best first), or `MFA_ENROLLMENT_REQUIRED` when the person has none yet —
 * signed in with their email and nothing else, they connect Telegram or set up an authenticator first; signed in with
 * a Telegram that opened the account, they add their email or set up an authenticator.
 */
export function confirmationOf(f: SessionFactors, requirement: ConfirmationRequirement, purpose: StepUpPurpose = 'CHANGE'): Confirmation {
  if (f.freshIndependent) return f.freshIndependent;
  if (requirement === 'RECENT' && f.recentBy) return f.recentBy;
  const factors = requirement === 'RECENT' ? f.available : f.independent;
  if (factors.length === 0) {
    const add = f.signInMethod === 'TELEGRAM' && !f.available.includes('EMAIL') ? 'add your email' : 'connect Telegram';
    throw new DomainError('MFA_ENROLLMENT_REQUIRED', `${add} or set up an authenticator to confirm this`, { factors: [], requirement, purpose, add: add === 'add your email' ? 'EMAIL' : 'TELEGRAM' });
  }
  throw new DomainError('STEP_UP_REQUIRED', 'confirm it is you with a code', { factors: [...factors], requirement, purpose });
}

/** `purpose` names what is confirmed, for the code's message (`STEP_UP_PURPOSES`); the page passes it back unchanged. */
export async function requireConfirmation(ex: Executor, sessionId: string, requirement: ConfirmationRequirement = 'INDEPENDENT', purpose: StepUpPurpose = 'CHANGE'): Promise<Confirmation> {
  return confirmationOf(await sessionFactors(ex, sessionId), requirement, purpose);
}

/**
 * Adding, replacing or removing a way to sign in or confirm (linking or disconnecting Telegram, setting up an
 * authenticator). An account that already has a second factor keeps it in charge: the change needs a step-up by a
 * factor other than the sign-in one, so whoever holds only the inbox cannot swap the person's Telegram or authenticator
 * for their own. An account with only its email — or only the Telegram that opened it — needs a recent sign-in or
 * code: the trust any first factor starts with, as the authenticator always has (TD-11).
 */
export function factorChangeRequirement(f: SessionFactors): ConfirmationRequirement {
  return f.available.length > 1 ? 'INDEPENDENT' : 'RECENT';
}

export async function requireFactorChange(ex: Executor, sessionId: string): Promise<Confirmation> {
  const f = await sessionFactors(ex, sessionId);
  return confirmationOf(f, factorChangeRequirement(f), 'SECURITY');
}
