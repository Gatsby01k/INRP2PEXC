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

export const deskBaseUrl = (port: number): string => `http://${LOOPBACK_HOST}:${port}`;

/**
 * The three surfaces the product serves, and how the harness serves them.
 *
 * In a deployment they are three host names. Here they are three ports on one address, because a harness has one
 * name to work with and a surface must still be a surface: the desk may not become reachable as the client app
 * by accident, and the public quote link may not be served on an origin that carries a client cookie. The proxy
 * compares a configured host **with its port** when one is given, which is what lets `127.0.0.1` be three
 * different surfaces at once without loosening anything about how a real deployment is told apart.
 */
export type HarnessSurface = 'desk' | 'app' | 'public';

export interface SurfacePorts {
  readonly desk: number;
  readonly app: number;
  readonly public: number;
}

/** One base port picks all three, so a suite only ever configures one number. */
export const surfacePorts = (base: number): SurfacePorts => ({ desk: base, app: base + 1, public: base + 2 });

export interface DeskServerOptions {
  /** Base port: the desk listens here, the client app on +1 and the public host on +2. */
  readonly port: number;
  readonly databaseUrl: string;
  readonly operatorAuthSecret: string;
  readonly clientAuthSecret: string;
  /** Which surfaces to actually start. The desk alone is enough for a suite that never leaves it. */
  readonly surfaces?: readonly HarnessSurface[];
  /** Prefix for the server's own output, so two suites' logs stay apart. */
  readonly label?: string;
  /** Field-protection keys, when the suite has to open something the server sealed (an acceptance code). */
  readonly fieldKeys?: { readonly keyId: string; readonly kekBase64: string; readonly hmacBase64: string };
  /** Custody provider slug, which must match the capability the world recorded (D-02). */
  readonly custodyProvider?: string;
  /** Where the client sign-in code is written, so a run can sign in through the real form. Test-only. */
  readonly clientOtpSinkFile?: string;
}

/**
 * The environment the harness gives the built product.
 *
 * Exported and pure so it can be asserted: the host each surface is told it is, the origin its auth will trust
 * and the address the suite browses must all agree, or the app is right to refuse the request. Making them agree
 * is the fix; loosening the origin or host check would not be.
 */
export function deskServerEnv(opts: Omit<DeskServerOptions, 'label' | 'surfaces'>): Record<string, string> {
  const ports = surfacePorts(opts.port);
  return {
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    DATABASE_URL: opts.databaseUrl,
    DESK_HOST: `${LOOPBACK_HOST}:${ports.desk}`,
    APP_HOST: `${LOOPBACK_HOST}:${ports.app}`,
    PUBLIC_HOST: `${LOOPBACK_HOST}:${ports.public}`,
    OPERATOR_AUTH_SECRET: opts.operatorAuthSecret,
    CLIENT_AUTH_SECRET: opts.clientAuthSecret,
    OPERATOR_BASE_URL: deskBaseUrl(ports.desk),
    CLIENT_BASE_URL: deskBaseUrl(ports.app),
    CLIENT_LINK_BASE: deskBaseUrl(ports.public),
    // Cookies over plain http, through the explicitly named switch the runtime refuses in production.
    INRP2P_ALLOW_INSECURE_COOKIES: 'true',
    INRP2P_ENV: 'e2e',
    ...(opts.custodyProvider ? { INRP2P_CUSTODY_PROVIDER: opts.custodyProvider, INRP2P_CUSTODY_CAPABILITY: 'POOL' } : {}),
    ...(opts.fieldKeys
      ? { INRP2P_KEK_ID: opts.fieldKeys.keyId, INRP2P_KEK_BASE64: opts.fieldKeys.kekBase64, INRP2P_FIELD_HMAC_BASE64: opts.fieldKeys.hmacBase64 }
      : {}),
    ...(opts.clientOtpSinkFile ? { INRP2P_CLIENT_OTP_SINK_FILE: opts.clientOtpSinkFile } : {}),
  };
}

/**
 * What "ready" means for each surface, stated rather than assumed.
 *
 * The desk and the client app each have exactly one page that renders without a session, and it rendering is the
 * liveness signal. The public host publishes only the quote link, so its signal is that an unknown token is
 * answered as not found — which proves routing, the proxy and a database round-trip in one request, and would
 * fail loudly if the host were quietly classified as something else.
 */
const READINESS: Record<HarnessSurface, { path: string; expected: number }> = {
  desk: { path: '/sign-in', expected: 200 },
  app: { path: '/sign-in', expected: 200 },
  public: { path: '/q/0000000000000000000000', expected: 404 },
};

/**
 * Starts the **built** product for a test suite, and hands back the way to stop it.
 *
 * Playwright's own `webServer` starts before `globalSetup`, which would put the app's first connections into a
 * database the seed is about to drop. Owning the process here makes the order deliberate: the world exists, then
 * the server starts against it.
 *
 * The auth secrets are the seed's own, so the authenticators it enrolled can be decrypted.
 */
export async function startDesk(opts: DeskServerOptions): Promise<() => Promise<void>> {
  const ports = surfacePorts(opts.port);
  const env = deskServerEnv(opts);
  const stops: (() => Promise<void>)[] = [];
  try {
    for (const surface of opts.surfaces ?? ['desk']) {
      stops.push(await startSurface(surface, ports[surface], env, opts.label ?? 'desk'));
    }
  } catch (e) {
    await Promise.all(stops.map((stop) => stop()));
    throw e;
  }
  return async () => {
    await Promise.all(stops.map((stop) => stop()));
  };
}

async function startSurface(surface: HarnessSurface, port: number, env: Record<string, string>, prefix: string): Promise<() => Promise<void>> {
  const label = `${prefix}:${surface}`;
  const server = spawn(process.execPath, [NEXT_BIN, 'start', '-p', String(port), '-H', LOOPBACK_HOST], {
    cwd: APP_DIR,
    env: { ...process.env, ...env },
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

  const ready = READINESS[surface];
  await waitForReady(`${deskBaseUrl(port)}${ready.path}`, ready.expected, server, label, recent);
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
 * A surface is ready when the one request that identifies it is answered as it should be.
 *
 * Every attempt is bounded, and its outcome is kept: a hung connection must not swallow the whole budget in one
 * request. A redirect, or any other status than the expected one, counts as not ready and is reported with its
 * target, because being answered differently is a configuration answer.
 */
async function waitForReady(url: string, expected: number, server: ChildProcess, label: string, recent: readonly string[]): Promise<void> {
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
      if (res.status === expected) return;
      const location = res.headers.get('location');
      last = `HTTP ${res.status} (expected ${expected})${location ? ` → ${location}` : ''}`;
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
