export type Surface = 'OPERATOR' | 'CLIENT';

/**
 * Session policy (SECURITY §2.1 / §2.2). Absolute lifetime is enforced by Better Auth; idle timeout by the INRP2P guard.
 *
 * A module of its own, with no imports, because the edge proxy needs the cookie names and nothing else: it must not
 * pull Better Auth's instances, the pools or the database client into a function that runs far from the database.
 */
export const SESSION_POLICY = {
  OPERATOR: { absoluteSeconds: 12 * 3600, idleSeconds: 30 * 60, sameSite: 'strict' as const, cookiePrefix: 'inrp2p-desk' },
  /**
   * ADR 0026: a client stays signed in on their device — thirty days at most, a week without using it — because the
   * session alone moves no money anywhere new. What would (a new bank account or wallet, a withdrawal, new settlement
   * details, who may commit the account, a new way to sign in) is confirmed again, minutes before, by a factor other
   * than the one the session was opened with (`factors.ts`).
   */
  CLIENT: { absoluteSeconds: 30 * 24 * 3600, idleSeconds: 7 * 24 * 3600, sameSite: 'lax' as const, cookiePrefix: 'inrp2p-app' },
} as const;

/** The cookie that remembers, on this device, how the person last signed in (Better Auth's `lastLoginMethod`). */
export const LAST_SIGN_IN_COOKIE = `${SESSION_POLICY.CLIENT.cookiePrefix}.last_sign_in`;

/**
 * How stale a session's recorded activity may get before a request writes it again.
 *
 * The idle timeout is measured from `session_activity.last_activity_at`. Writing it on every request made each page,
 * prefetch and refresh a write on the session's row — concurrent requests of one session queued on that row lock — for
 * a value the timeout reads at minute precision. Writing it at most once a minute can only make the recorded activity
 * older than the real one, never newer: a session ends at most this much *earlier* than its idle timeout, never later.
 */
export const ACTIVITY_WRITE_INTERVAL_SECONDS = 60;
