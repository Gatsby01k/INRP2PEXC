import { sql } from 'kysely';
import { getRuntime } from '../../../../server/runtime.ts';

export const dynamic = 'force-dynamic';

/**
 * Readiness: should this process be sent traffic?
 *
 * One question, asked of the database, with the business clock as the answer — it proves the pool, the
 * connection, the credentials and migration 0012 in a single round trip. It deliberately reports **nothing**
 * about the business: a readiness probe is reachable without a session on every host, so the only thing it may
 * say is yes or no.
 */
export async function GET() {
  try {
    await sql`select inrp2p_now()`.execute(getRuntime().appDb);
    return new Response(JSON.stringify({ status: 'ready' }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  } catch {
    // The reason is logged where the process logs; it is not returned, because whoever can reach this endpoint
    // without a session is not owed the shape of our infrastructure.
    return new Response(JSON.stringify({ status: 'not_ready' }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}
