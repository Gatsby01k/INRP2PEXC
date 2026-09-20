import { timingSafeEqual } from 'node:crypto';
import { headers } from 'next/headers';
import { systemHealth } from '@inrp2p/desk';
import { getRuntime } from '../../../../server/runtime.ts';
import { optionalEnv } from '../../../../server/env.ts';
import { can, operatorContext } from '../../../../server/operator.ts';

export const dynamic = 'force-dynamic';

/**
 * The full picture: every signal, its threshold and the runbook it points at.
 *
 * Unlike liveness and readiness, this carries business figures — capacity left today, how many trades are on
 * hold, how far behind the scanner is. So it is **not** open: either a monitoring system presents the shared
 * token, or a signed-in operator with `economics:view` asks for it. There is no third way in, and no version of
 * this response that is safe to serve anonymously.
 *
 * The status code carries the state as well as the body, so a check that only looks at the code still works:
 * 200 when everything is fine, 200 with `state: "warn"` when something is worth looking at, and 503 when a
 * signal is in alarm — which is the code an orchestrator and a pager both already understand.
 */
function tokenMatches(presented: string | null, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET() {
  const rt = getRuntime();
  const expected = optionalEnv('INRP2P_HEALTH_TOKEN');
  const presented = (await headers()).get('x-inrp2p-health-token');

  if (!expected || !tokenMatches(presented, expected)) {
    // No token, or the wrong one: fall back to an operator session. `economics:view` rather than any session,
    // because capacity and margin-adjacent figures are exactly what that permission governs.
    try {
      const ctx = await operatorContext();
      if (!can(ctx, 'economics:view')) {
        return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
      }
    } catch {
      return new Response(JSON.stringify({ error: 'UNAUTHENTICATED' }), { status: 401, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    }
  }

  const health = await systemHealth(rt.appDb);
  return new Response(JSON.stringify(health), {
    status: health.state === 'alarm' ? 503 : 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
