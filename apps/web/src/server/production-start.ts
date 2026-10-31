import type pg from 'pg';
import { isProduction, productionConfigReport } from '@inrp2p/adapters';

/**
 * The web app's production start-up check (production task E3). In production the server serves only on a complete
 * production configuration and against the database it was built for, through the application's own login: anything
 * missing is printed by name — never a value — and the process exits, so an orchestrator sees a failed start rather
 * than a server that half works. Outside production nothing here runs, and no setting can switch it off inside
 * production.
 *
 * It has two halves, because they belong in different places:
 *
 * - **The configuration** is read from the environment, here, by `instrumentation.ts` on the Node.js runtime, before
 *   the process takes a request.
 * - **The database** is checked by `databaseStartCheck`, before the first statement this process sends: `getRuntime`
 *   gates both of its pools on it, so nothing reaches the database until it has passed — not a read, not a session
 *   check, not a command.
 *
 * Both used to run here. On Vercel the proxy is a process of its own, in the region nearest the visitor, and Next
 * registers instrumentation there too: every cold proxy opened a connection to the database across an ocean — TCP,
 * TLS, the login, a statement — before it could classify a host, and a database the proxy never reads could take every
 * surface down with it, the public site included (ADR 0021 §4). Only a process that uses the database checks it now.
 */
export async function checkProductionStart(): Promise<void> {
  if (!isProduction(process.env)) return;
  const report = productionConfigReport('web', process.env);
  for (const w of report.warnings) console.warn(`warning: ${w}`);
  if (report.problems.length > 0) refuse(report.problems);
}

/**
 * The database half, for the pool a process is about to use: a function to await before its first statement, which
 * checks once and then answers at once. Outside production there is nothing to check, and no gate.
 *
 * The check runs on its own handle over the same pool, so it is not held behind itself. `@inrp2p/db` is imported when
 * the check runs, not with this module, so the proxy — which loads this module for the configuration half — never loads
 * a database client at all.
 */
export function databaseStartCheck(pool: pg.Pool, exit: (code: number) => never = (code) => process.exit(code)): (() => Promise<void>) | undefined {
  if (!isProduction(process.env)) return undefined;
  let checked: Promise<void> | undefined;
  const check = async (): Promise<void> => {
    let problems: string[];
    try {
      const { createDb, databaseDeploymentProblems } = await import('@inrp2p/db');
      problems = await databaseDeploymentProblems(createDb(pool));
    } catch (e) {
      problems = [`the database could not be checked (${(e as { code?: string }).code ?? 'unreachable'})`];
    }
    if (problems.length > 0) refuse(problems, exit);
  };
  return () => (checked ??= check());
}

function refuse(problems: readonly string[], exit: (code: number) => never = (code) => process.exit(code)): never {
  console.error(`refusing to start: the production configuration is incomplete:\n- ${problems.join('\n- ')}`);
  return exit(1);
}
