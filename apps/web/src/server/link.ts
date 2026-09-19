import 'server-only';
import { createHash } from 'node:crypto';
import { headers } from 'next/headers';

/**
 * Who is asking, for rate limiting only (SECURITY §7).
 *
 * The link page is unauthenticated by design — opening a link authorizes nothing (D-01) — so the only thing that
 * can be counted is the caller's address, and it is counted as a hash: the limiter needs to tell two callers
 * apart, not know where either of them is.
 *
 * `x-forwarded-for` is a header, which means it is whatever the last hop wrote. Only the **first** entry matters
 * to us and only because the deployment's own proxy sets it; with nothing in front of the app there is no
 * address to take, and every caller then shares one bucket, which is the safe direction to be wrong in.
 */
export async function callerIpHash(): Promise<string> {
  const h = await headers();
  const forwarded = h.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = forwarded || h.get('x-real-ip')?.trim() || 'unknown';
  return createHash('sha256').update(ip).digest('hex');
}
