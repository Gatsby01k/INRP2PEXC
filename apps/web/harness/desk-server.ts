import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const NEXT_BIN = fileURLToPath(new URL('../node_modules/next/dist/bin/next', import.meta.url));

export interface DeskServerOptions {
  readonly port: number;
  readonly databaseUrl: string;
  readonly operatorAuthSecret: string;
  readonly clientAuthSecret: string;
  /** Prefix for the server's own output, so two suites' logs stay apart. */
  readonly label?: string;
}

/**
 * Starts the **built** desk for a test suite, and hands back the way to stop it.
 *
 * Playwright's own `webServer` starts before `globalSetup`, which would put the app's first connections into a
 * database the seed is about to drop. Owning the process here makes the order deliberate: the world exists, then
 * the server starts against it.
 *
 * Cookies are allowed over plain http only through the explicitly named switch the runtime refuses in
 * production, and the auth secrets are the seed's own, so the authenticators it enrolled can be decrypted.
 */
export async function startDesk(opts: DeskServerOptions): Promise<() => Promise<void>> {
  const label = opts.label ?? 'desk';
  const server = spawn(process.execPath, [NEXT_BIN, 'start', '-p', String(opts.port), '-H', 'localhost'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      DATABASE_URL: opts.databaseUrl,
      DESK_HOST: 'localhost',
      APP_HOST: 'app.localhost',
      PUBLIC_HOST: 'public.localhost',
      OPERATOR_AUTH_SECRET: opts.operatorAuthSecret,
      CLIENT_AUTH_SECRET: opts.clientAuthSecret,
      OPERATOR_BASE_URL: `http://localhost:${opts.port}`,
      CLIENT_BASE_URL: `http://localhost:${opts.port}`,
      CLIENT_LINK_BASE: `http://localhost:${opts.port}`,
      INRP2P_ALLOW_INSECURE_COOKIES: 'true',
      INRP2P_ENV: 'e2e',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = (d: Buffer) => process.stdout.write(`[${label}] ${d.toString()}`);
  server.stdout.on('data', log);
  server.stderr.on('data', log);
  let stopping = false;
  server.on('exit', (code, signal) => {
    if (!stopping) console.error(`[${label}] exited unexpectedly (code ${code}, signal ${signal})`);
  });

  await waitForSignIn(`http://localhost:${opts.port}/sign-in`, server, label);
  return async () => {
    stopping = true;
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  };
}

/** The desk is ready when its one unauthenticated page renders, which also proves the database is reachable. */
async function waitForSignIn(url: string, server: ChildProcess, label: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`[${label}] exited with ${server.exitCode} before becoming ready`);
    try {
      const res = await fetch(url, { headers: { accept: 'text/html' } });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`[${label}] did not become ready at ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
