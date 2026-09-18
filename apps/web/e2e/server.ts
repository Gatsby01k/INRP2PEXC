import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLIENT_AUTH_SECRET, OPERATOR_AUTH_SECRET } from './world.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const NEXT_BIN = fileURLToPath(new URL('../node_modules/next/dist/bin/next', import.meta.url));

/**
 * Starts the **built** desk for the run.
 *
 * Playwright's own `webServer` starts before `globalSetup`, which would put the app's first connections into a
 * database the seed is about to drop. Owning the process here makes the order deliberate: the world exists, then
 * the server starts against it.
 *
 * Cookies are allowed over plain http only through the explicitly named switch the runtime refuses in
 * production, and the auth secrets are the seed's own, so the authenticators it enrolled can be decrypted.
 */
export async function startDesk(port: number, databaseUrl: string): Promise<() => Promise<void>> {
  const server = spawn(process.execPath, [NEXT_BIN, 'start', '-p', String(port), '-H', 'localhost'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      DATABASE_URL: databaseUrl,
      DESK_HOST: 'localhost',
      APP_HOST: 'app.localhost',
      PUBLIC_HOST: 'public.localhost',
      OPERATOR_AUTH_SECRET,
      CLIENT_AUTH_SECRET,
      OPERATOR_BASE_URL: `http://localhost:${port}`,
      CLIENT_BASE_URL: `http://localhost:${port}`,
      CLIENT_LINK_BASE: `http://localhost:${port}`,
      INRP2P_ALLOW_INSECURE_COOKIES: 'true',
      INRP2P_ENV: 'e2e',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = (d: Buffer) => process.stdout.write(`[desk] ${d.toString()}`);
  server.stdout.on('data', log);
  server.stderr.on('data', log);
  let stopping = false;
  server.on('exit', (code, signal) => {
    if (!stopping) console.error(`[desk] exited unexpectedly (code ${code}, signal ${signal})`);
  });

  await waitForSignIn(`http://localhost:${port}/sign-in`, server);
  return async () => {
    stopping = true;
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  };
}

/** The desk is ready when its one unauthenticated page renders, which also proves the database is reachable. */
async function waitForSignIn(url: string, server: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`desk exited with ${server.exitCode} before becoming ready`);
    try {
      const res = await fetch(url, { headers: { accept: 'text/html' } });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`desk did not become ready at ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
