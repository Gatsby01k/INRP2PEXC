export const dynamic = 'force-dynamic';

/**
 * Liveness: is this process able to answer at all?
 *
 * It touches nothing — no database, no session, no configuration. That is the whole point of separating it from
 * readiness: an orchestrator uses liveness to decide whether to **restart** the process, and restarting a
 * healthy app because the database is briefly unreachable turns a short outage into a long one.
 */
export function GET() {
  return new Response(JSON.stringify({ status: 'live' }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
