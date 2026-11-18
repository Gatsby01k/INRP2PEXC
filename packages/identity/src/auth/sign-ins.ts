import { isIP } from 'node:net';
import type { Db } from '@inrp2p/db';
import type { Surface } from './policy.ts';

/**
 * Where a sign-in came from (migration 0052): the address Better Auth resolved for the request, where the edge placed
 * that address, and the device's user agent.
 *
 * The place is what Vercel's edge writes on every request it forwards — `x-vercel-ip-country` (ISO 3166-1),
 * `x-vercel-ip-country-region` (the ISO 3166-2 subdivision, without the country) and `x-vercel-ip-city` (URL-encoded).
 * On Vercel a caller cannot set them; anywhere else they are whatever the caller sent, which is why this is shown to the
 * desk as where a sign-in appeared to come from, and never decides anything. No address is sent anywhere to be looked up.
 */
export interface SignInOrigin {
  readonly ip: string | null;
  readonly country: string | null;
  readonly region: string | null;
  readonly city: string | null;
  readonly userAgent: string | null;
}

const header = (headers: Headers | null | undefined, name: string): string | null => {
  const v = headers?.get(name);
  return v && v.trim() !== '' ? v.trim() : null;
};

const decoded = (value: string | null): string | null => {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** An address as Postgres' `inet` takes it, or null: a header is never trusted to be one. */
function address(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v && isIP(v) !== 0 ? v : null;
}

/**
 * The origin of a request that opened a session. `sessionIp` and `sessionUserAgent` are what Better Auth stored on the
 * session (its own, trusted-header resolution of the address); the request's headers fill what it did not.
 */
export function originOf(headers: Headers | null | undefined, sessionIp?: string | null, sessionUserAgent?: string | null): SignInOrigin {
  const country = header(headers, 'x-vercel-ip-country')?.toUpperCase() ?? null;
  const region = header(headers, 'x-vercel-ip-country-region')?.toUpperCase() ?? null;
  const city = decoded(header(headers, 'x-vercel-ip-city'));
  const userAgent = (sessionUserAgent && sessionUserAgent.trim() !== '' ? sessionUserAgent : header(headers, 'user-agent'))?.slice(0, 512) ?? null;
  return {
    ip: address(sessionIp) ?? address(header(headers, 'x-real-ip')),
    country: country && /^[A-Z]{2}$/.test(country) && country !== 'XX' ? country : null,
    region: region && /^[A-Z0-9]{1,3}$/.test(region) ? region : null,
    city: city && city.trim().length > 0 ? city.trim().slice(0, 120) : null,
    userAgent,
  };
}

/**
 * Records one sign-in. It never stands between a person and their session: a sign-in whose record cannot be written
 * still signs in, and the failure is logged — the desk loses one line, the person loses nothing.
 */
export async function recordSignIn(
  appDb: Db,
  row: { readonly userId: string; readonly sessionId: string; readonly surface: Surface; readonly method: 'EMAIL' | 'TELEGRAM' | 'PASSWORD' | null; readonly origin: SignInOrigin },
): Promise<void> {
  try {
    await appDb
      .insertInto('sign_in')
      .values({
        user_id: row.userId,
        session_id: row.sessionId,
        surface: row.surface,
        method: row.method,
        ip: row.origin.ip,
        country: row.origin.country,
        region: row.origin.region,
        city: row.origin.city,
        user_agent: row.origin.userAgent,
      })
      .execute();
  } catch (error) {
    console.warn('sign-in origin not recorded', { surface: row.surface, error: error instanceof Error ? error.message : String(error) });
  }
}
