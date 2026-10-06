import { sql } from 'kysely';
import { isProduction, productionConfigReport } from '@inrp2p/adapters';
import { databaseDeploymentProblems } from '@inrp2p/db';
import { getRuntime } from '../../../../server/runtime.ts';

export const dynamic = 'force-dynamic';

/**
 * Readiness: should this process be sent traffic?
 *
 * Yes when the database answers through this process's pool and — in production — the schema is exactly the version
 * this release was built for, the login is the application's own, and the production configuration is complete (the
 * same checks the server ran at start, asked again, because a database can be restored or migrated under a running
 * process). It deliberately reports **nothing** about the business or the reason: a readiness probe is reachable
 * without a session on every host, so the only thing it may say is yes or no. The worker's freshness, the scanner and
 * every money signal are on `/api/health/status`, which is not anonymous.
 */
export async function GET() {
  try {
    const db = getRuntime().appDb;
    if (isProduction(process.env)) {
      const problems = [...productionConfigReport('web', process.env).problems, ...(await databaseDeploymentProblems(db))];
      if (problems.length > 0) {
        console.error(`not ready: ${problems.join('; ')}`);
        return notReady();
      }
    } else {
      await sql`select inrp2p_now()`.execute(db);
    }
    return new Response(JSON.stringify({ status: 'ready' }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  } catch {
    // The reason is logged where the process logs; it is not returned, because whoever can reach this endpoint
    // without a session is not owed the shape of our infrastructure.
    return notReady();
  }
}

function notReady(): Response {
  return new Response(JSON.stringify({ status: 'not_ready' }), {
    status: 503,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
