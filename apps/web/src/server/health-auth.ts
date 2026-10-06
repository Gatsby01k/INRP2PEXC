import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { headers } from 'next/headers';
import { optionalEnv } from './env.ts';
import { can, operatorContext } from './operator.ts';

function tokenMatches(presented: string | null, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Who may read the full health picture: a monitoring system presenting the shared token, or a signed-in operator with
 * `economics:view` (capacity and blocked-trade counts are figures that permission governs). Returns the refusal to send,
 * or `null` when the caller may proceed. There is no third way in.
 */
export async function healthAccessRefusal(): Promise<Response | null> {
  const expected = optionalEnv('INRP2P_HEALTH_TOKEN');
  const presented = (await headers()).get('x-inrp2p-health-token');
  if (expected && tokenMatches(presented, expected)) return null;
  try {
    const ctx = await operatorContext();
    if (!can(ctx, 'economics:view')) {
      return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    }
    return null;
  } catch {
    return new Response(JSON.stringify({ error: 'UNAUTHENTICATED' }), { status: 401, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  }
}
