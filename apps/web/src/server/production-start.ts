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

/** Pauses before the check's second, third and fourth attempts, when the database did not answer. */
export const START_CHECK_RETRY_MS: readonly number[] = [150, 450, 1_000];

/**
 * An answer from the database that will not change by asking again: the login was refused (class 28), the database does
 * not exist (3D), or it is not this application's schema at all (42, e.g. no `inrp2p_schema_version()`). Anything else —
 * a connection refused, reset or timed out, the pooler's `08P01`, a database starting or over its connections — says
 * nothing about the deployment, only about this moment.
 */
function isDefinitive(e: unknown): boolean {
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && /^(28|3D|42)[0-9A-Z]{3}$/.test(code);
}

/**
 * The database half, for the pool a process is about to use: a function to await before its first statement, which
 * checks once and then answers at once. Outside production there is nothing to check, and no gate.
 *
 * A database that answers wrongly — another schema version, the migrator's login, a superuser, a test permit, a refused
 * login — stops the process, as before. A database that does not answer is not a wrong configuration: it is asked again
 * (`START_CHECK_RETRY_MS`), and if it still does not answer, the statement waiting on the check fails, the process stays
 * up, and the next statement checks again. On Vercel one process serves many requests at once, the public pages among
 * them: exiting on a moment's network error (Neon's pooler answered `08P01` to a quarter of cold starts on 2026-11-23)
 * turned every request in flight into a 500 — `inrp2p.com/traders` and the home page included, which read the database
 * for nothing but a rate they can draw without.
 *
 * The check runs on its own handle over the same pool, so it is not held behind itself. `@inrp2p/db` is imported when
 * the check runs, not with this module, so the proxy — which loads this module for the configuration half — never loads
 * a database client at all.
 */
export function databaseStartCheck(
  pool: pg.Pool,
  exit: (code: number) => never = (code) => process.exit(code),
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): (() => Promise<void>) | undefined {
  if (!isProduction(process.env)) return undefined;
  let checked: Promise<void> | undefined;
  const check = async (): Promise<void> => {
    const { createDb, databaseDeploymentProblems } = await import('@inrp2p/db');
    const db = createDb(pool);
    let failure: unknown;
    for (const wait of [0, ...START_CHECK_RETRY_MS]) {
      if (wait > 0) await pause(wait);
      let problems: string[];
      try {
        problems = await databaseDeploymentProblems(db);
      } catch (e) {
        if (isDefinitive(e)) refuse([`the database refused the check (${(e as { code: string }).code})`], exit);
        failure = e;
        continue;
      }
      if (problems.length > 0) refuse(problems, exit);
      return;
    }
    const code = (failure as { code?: unknown }).code;
    const reason = `${typeof code === 'string' ? code : 'unreachable'}: ${(failure instanceof Error ? failure.message : String(failure)).slice(0, 160)}`;
    console.error(`the database start-up check could not reach the database (${reason}); this statement fails, the next one checks again`);
    throw new Error(`the database could not be reached (${reason})`, { cause: failure });
  };
  return () =>
    (checked ??= check().catch((e: unknown) => {
      checked = undefined;
      throw e;
    }));
}

function refuse(problems: readonly string[], exit: (code: number) => never = (code) => process.exit(code)): never {
  console.error(`refusing to start: the production configuration is incomplete:\n- ${problems.join('\n- ')}`);
  return exit(1);
}
