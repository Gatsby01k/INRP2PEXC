export type Surface = 'OPERATOR' | 'CLIENT';

/**
 * Session policy (SECURITY §2.1 / §2.2). Absolute lifetime is enforced by Better Auth; idle timeout by the INRP2P guard.
 *
 * A module of its own, with no imports, because the edge proxy needs the cookie names and nothing else: it must not
 * pull Better Auth's instances, the pools or the database client into a function that runs far from the database.
 */
export const SESSION_POLICY = {
  OPERATOR: { absoluteSeconds: 12 * 3600, idleSeconds: 30 * 60, sameSite: 'strict' as const, cookiePrefix: 'inrp2p-desk' },
  CLIENT: { absoluteSeconds: 7 * 24 * 3600, idleSeconds: 60 * 60, sameSite: 'lax' as const, cookiePrefix: 'inrp2p-app' },
} as const;

/**
 * How stale a session's recorded activity may get before a request writes it again.
 *
 * The idle timeout is measured from `session_activity.last_activity_at`. Writing it on every request made each page,
 * prefetch and refresh a write on the session's row — concurrent requests of one session queued on that row lock — for
 * a value the timeout reads at minute precision. Writing it at most once a minute can only make the recorded activity
 * older than the real one, never newer: a session ends at most this much *earlier* than its idle timeout, never later.
 */
export const ACTIVITY_WRITE_INTERVAL_SECONDS = 60;
