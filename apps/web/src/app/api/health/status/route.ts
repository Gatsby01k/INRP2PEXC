import { operationsStatus } from '@inrp2p/desk';
import { getRuntime } from '../../../../server/runtime.ts';
import { healthAccessRefusal } from '../../../../server/health-auth.ts';

export const dynamic = 'force-dynamic';

/**
 * The full picture: every signal, its group, threshold and runbook; whether new business is open; and each worker's
 * heartbeat with what it runs (names and states, never a secret).
 *
 * Unlike liveness and readiness, this carries business figures — capacity left today, how many trades are on hold, how
 * far behind the scanner is — so it is **not** open: the monitoring token, or an operator with `economics:view`.
 *
 * The status code carries the state of money and infrastructure: 200 when fine, 200 with `state: "warn"` when something
 * is worth a look, 503 when a signal is in alarm. Liquidity (`liquidity`) is reported apart and never turns it 503: a
 * trader-funded exchange with no trader online is quiet, not broken (D-16).
 */
export async function GET() {
  const refusal = await healthAccessRefusal();
  if (refusal) return refusal;
  const status = await operationsStatus(getRuntime().appDb);
  return new Response(JSON.stringify(status), {
    status: status.state === 'alarm' ? 503 : 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
