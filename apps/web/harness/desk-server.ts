import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const NEXT_BIN = fileURLToPath(new URL('../node_modules/next/dist/bin/next', import.meta.url));

/**
 * The loopback address every test harness binds, browses and checks.
 *
 * A literal IPv4 address, never the name `localhost`. A name has to be resolved, and in a container it can
 * resolve to `::1`, to `127.0.0.1`, or to both in an order that differs between the server's `listen` and the
 * client's `connect` — so the desk can be listening and still be unreachable at what looks like the same URL.
 * (That is exactly how the canonical visual job failed: the server reported ready, the readiness check never
 * reached it.) Using one literal address on both sides takes resolution out of the question.
 *
 * This is a **test** address. Production hosts come from the deployment's own `DESK_HOST` / `APP_HOST` /
 * `PUBLIC_HOST` and are not affected by anything here.
 */
export const LOOPBACK_HOST = '127.0.0.1';

/** Hosts the desk must be able to tell apart; only the desk host is ever connected to by a suite. */
export const HARNESS_APP_HOST = 'app.localhost';
export const HARNESS_PUBLIC_HOST = 'public.localhost';

export const deskBaseUrl = (port: number): string => `http://${LOOPBACK_HOST}:${port}`;

export interface DeskServerOptions {
  readonly port: number;
  readonly databaseUrl: string;
  readonly operatorAuthSecret: string;
  readonly clientAuthSecret: string;
  /** Prefix for the server's own output, so two suites' logs stay apart. */
  readonly label?: string;
}

/**
 * The environment the harness gives the built desk.
 *
 * Exported and pure so it can be asserted: the host the server is told it is (`DESK_HOST`), the origin its auth
 * will trust (`OPERATOR_BASE_URL`) and the address the suite browses must all be the same, or the desk is right
 * to refuse the request. Making them agree is the fix; loosening the origin or host check would not be.
 */
export function deskServerEnv(opts: Omit<DeskServerOptions, 'label'>): Record<string, string> {
  const base = deskBaseUrl(opts.port);
  return {
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    DATABASE_URL: opts.databaseUrl,
    DESK_HOST: LOOPBACK_HOST,
    APP_HOST: HARNESS_APP_HOST,
    PUBLIC_HOST: HARNESS_PUBLIC_HOST,
    OPERATOR_AUTH_SECRET: opts.operatorAuthSecret,
    CLIENT_AUTH_SECRET: opts.clientAuthSecret,
    OPERATOR_BASE_URL: base,
    CLIENT_BASE_URL: base,
    CLIENT_LINK_BASE: base,
    // Cookies over plain http, through the explicitly named switch the runtime refuses in production.
    INRP2P_ALLOW_INSECURE_COOKIES: 'true',
    INRP2P_ENV: 'e2e',
  };
}

/**
 * Starts the **built** desk for a test suite, and hands back the way to stop it.
 *
 * Playwright's own `webServer` starts before `globalSetup`, which would put the app's first connections into a
 * database the seed is about to drop. Owning the process here makes the order deliberate: the world exists, then
 * the server starts against it.
 *
 * The auth secrets are the seed's own, so the authenticators it enrolled can be decrypted.
 */
export async function startDesk(opts: DeskServerOptions): Promise<() => Promise<void>> {
  const label = opts.label ?? 'desk';
  const server = spawn(process.execPath, [NEXT_BIN, 'start', '-p', String(opts.port), '-H', LOOPBACK_HOST], {
    cwd: APP_DIR,
    env: { ...process.env, ...deskServerEnv(opts) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Kept so a readiness failure can show what the server itself said, which is usually where the reason is.
  const recent: string[] = [];
  const log = (d: Buffer) => {
    const text = d.toString();
    process.stdout.write(`[${label}] ${text}`);
    for (const line of text.split('\n')) if (line.trim()) recent.push(line.trim());
    if (recent.length > 12) recent.splice(0, recent.length - 12);
  };
  server.stdout.on('data', log);
  server.stderr.on('data', log);
  let stopping = false;
  server.on('exit', (code, signal) => {
    if (!stopping) console.error(`[${label}] exited unexpectedly (code ${code}, signal ${signal})`);
  });

  await waitForSignIn(`${deskBaseUrl(opts.port)}/sign-in`, server, label, recent);
  return async () => {
    stopping = true;
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  };
}

const READY_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Builds the message a readiness failure deserves. Pure, so what it says can be asserted: "did not become
 * ready" on its own tells whoever reads a CI log nothing, and this is read exactly when nobody can reproduce it.
 */
export function formatReadinessFailure(input: {
  label: string;
  url: string;
  elapsedMs: number;
  attempts: number;
  last: string;
  recent: readonly string[];
}): string {
  return (
    `[${input.label}] did not become ready at ${input.url}\n` +
    `  after ${Math.round(input.elapsedMs / 1000)}s and ${input.attempts} attempts\n` +
    `  last attempt: ${input.last}\n${tail(input.recent)}`
  );
}

/**
 * What a failed attempt actually was. Node's fetch reports every transport failure as "fetch failed" and puts
 * the reason — `ECONNREFUSED`, `EAI_AGAIN`, a timeout — in `cause`, which is the difference between a log that
 * names the problem and one that does not.
 */
export function describeFetchFailure(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = e?.cause?.code ?? e?.name;
  const message = e?.cause?.message ?? e?.message ?? String(err);
  return code && code !== 'Error' ? `${code}: ${message}` : message;
}

/**
 * The desk is ready when its one unauthenticated page renders. That is a liveness check on the server, not on
 * its database: the sign-in page needs no rows, and a suite's first real request is what finds a bad connection.
 *
 * Every attempt is bounded, and its outcome is kept: a hung connection must not swallow the whole budget in one
 * request. A redirect counts as not ready and is reported with its target, because being sent somewhere else is
 * a configuration answer.
 */
async function waitForSignIn(url: string, server: ChildProcess, label: string, recent: readonly string[]): Promise<void> {
  const started = Date.now();
  const deadline = started + READY_TIMEOUT_MS;
  let attempts = 0;
  // Assigned by every path through the loop below, and read only after one has run.
  let last: string;

  for (;;) {
    if (server.exitCode !== null) throw new Error(`[${label}] exited with ${server.exitCode} before becoming ready\n${tail(recent)}`);
    attempts += 1;
    try {
      const res = await fetch(url, { headers: { accept: 'text/html' }, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) return;
      const location = res.headers.get('location');
      last = `HTTP ${res.status}${location ? ` → ${location}` : ''}`;
    } catch (err) {
      last = describeFetchFailure(err);
    }
    if (Date.now() > deadline) {
      throw new Error(formatReadinessFailure({ label, url, elapsedMs: Date.now() - started, attempts, last, recent }));
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const tail = (recent: readonly string[]): string =>
  recent.length ? `  server output:\n${recent.map((l) => `    ${l}`).join('\n')}` : '  server output: (nothing)';
