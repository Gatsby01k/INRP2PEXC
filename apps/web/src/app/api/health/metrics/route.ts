import { operationsStatus, prometheusText } from '@inrp2p/desk';
import { getRuntime } from '../../../../server/runtime.ts';
import { healthAccessRefusal } from '../../../../server/health-auth.ts';

export const dynamic = 'force-dynamic';

/** The status picture in the Prometheus text format, behind the same access as `/api/health/status`. */
export async function GET() {
  const refusal = await healthAccessRefusal();
  if (refusal) return refusal;
  const status = await operationsStatus(getRuntime().appDb);
  return new Response(prometheusText(status), {
    headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' },
  });
}
