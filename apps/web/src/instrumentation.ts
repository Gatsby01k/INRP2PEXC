/**
 * Start-up checks for the web app (production task E3), run once by Next.js before the server takes a request.
 *
 * In production the server starts only on a complete production configuration: anything missing is printed by name —
 * never a value — and the process exits, so an orchestrator sees a failed start rather than a server that half works.
 * The database it was built for, through the application's own login, is checked before the process's first statement
 * instead (`server/production-start.ts`): Next registers this in the proxy's process too, and the proxy reads no
 * database. Outside production nothing here runs, and no setting can switch it off inside production.
 */
export async function register(): Promise<void> {
  // The Node.js-only check is imported only on that runtime (the pattern Next.js documents), so the Edge build never
  // compiles process.exit.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { checkProductionStart } = await import('./server/production-start.ts');
    await checkProductionStart();
  }
}
