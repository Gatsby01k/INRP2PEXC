/**
 * Start-up checks for the web app (production task E3), run once by Next.js before the server takes a request.
 *
 * In production the server starts only on a complete production configuration and against the database it was built
 * for, through the application's own login: anything missing is printed by name — never a value — and the process
 * exits, so an orchestrator sees a failed start rather than a server that half works. Outside production nothing here
 * runs, and no setting can switch it off inside production.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { isProduction, productionConfigReport } = await import('@inrp2p/adapters');
  if (!isProduction(process.env)) return;
  const report = productionConfigReport('web', process.env);
  for (const w of report.warnings) console.warn(`warning: ${w}`);
  const problems = [...report.problems];
  if (problems.length === 0) {
    const { databaseDeploymentProblems } = await import('@inrp2p/db');
    const { getRuntime } = await import('./server/runtime.ts');
    try {
      problems.push(...(await databaseDeploymentProblems(getRuntime().appDb)));
    } catch (e) {
      problems.push(`the database could not be checked (${(e as { code?: string }).code ?? 'unreachable'})`);
    }
  }
  if (problems.length > 0) {
    console.error(`refusing to start: the production configuration is incomplete:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
}
