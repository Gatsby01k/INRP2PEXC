import { getSessionCookie } from 'better-auth/cookies';
import { SESSION_POLICY, type Surface } from './policy.ts';

/**
 * Whether a request carries this surface's session cookie at all.
 *
 * This is the optimistic check Better Auth provides for a proxy: it reads the cookie and nothing else — no signature,
 * no database. It proves nothing about the session and grants nothing. It lets the edge send someone with no session to
 * sign in, and refuse an API call that carries none, without a round trip to a database on another continent; whether
 * the session is real, unexpired, not idle, MFA-verified and on this surface is decided where the data is, by
 * `requireOperatorSession` / `requireClientSession` in every page, route and action, and again inside every command
 * (`authorizeOperator`).
 */
export function carriesSessionCookie(headers: Headers, surface: Surface): boolean {
  return getSessionCookie(headers, { cookiePrefix: SESSION_POLICY[surface].cookiePrefix }) !== null;
}
