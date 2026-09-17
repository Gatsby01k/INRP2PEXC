import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32 } from '@better-auth/utils/base32';
import { createOTP } from '@better-auth/utils/otp';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { createOperatorAuth, provisionOperator } from '@inrp2p/identity';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const DESK_HOST = 'desk.inrp2p.test';
const OPERATOR_SECRET = randomBytes(32).toString('hex');
const PASSWORD = 'correct horse battery staple';

let t: TestDatabase;
let server: ChildProcess;
let port: number;
const cookies = new Map<string, string>();

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

function request(path: string, opts: { method?: string; body?: unknown; host?: string } = {}): Promise<{ status: number; json: Record<string, unknown> | null }> {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request({
      host: '127.0.0.1', port, path, method: opts.method ?? 'GET',
      headers: {
        host: opts.host ?? DESK_HOST,
        origin: `https://${DESK_HOST}`,
        'x-forwarded-for': '203.0.113.7',
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
        ...(cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      },
    }, (res) => {
      for (const c of res.headers['set-cookie'] ?? []) {
        const [pair] = c.split(';');
        const i = pair!.indexOf('=');
        const name = pair!.slice(0, i);
        const value = pair!.slice(i + 1);
        if (!value || /max-age=0/i.test(c)) cookies.delete(name);
        else cookies.set(name, value);
      }
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        let json: Record<string, unknown> | null;
        try { json = data ? JSON.parse(data) : null; } catch { json = null; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const hasBuild = existsSync(new URL('../.next/BUILD_ID', import.meta.url));

describe.skipIf(!hasBuild && !process.env.CI)('Next.js proxy: MFA enforced on every operator route (built app)', () => {
  beforeAll(async () => {
    if (!hasBuild) throw new Error('apps/web must be built (pnpm --filter @inrp2p/web build) before integration tests in CI');
    t = await createTestDatabase('web');
    port = await freePort();
    const u = new URL(t.appPool.options.connectionString!);
    server = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/next/dist/bin/next', import.meta.url)), 'start', '-p', String(port), '-H', '127.0.0.1'], {
      cwd: APP_DIR,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NEXT_TELEMETRY_DISABLED: '1',
        DATABASE_URL: u.toString(),
        DESK_HOST, APP_HOST: 'app.inrp2p.test', PUBLIC_HOST: 'inrp2p.test',
        OPERATOR_AUTH_SECRET: OPERATOR_SECRET,
        CLIENT_AUTH_SECRET: randomBytes(32).toString('hex'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('next start timeout')), 60_000);
      const onData = (d: Buffer) => {
        if (/Ready|started server|Local:/i.test(d.toString())) {
          clearTimeout(timer);
          resolve();
        }
      };
      server.stdout!.on('data', onData);
      server.stderr!.on('data', onData);
      server.on('exit', (code) => reject(new Error(`next exited ${code}`)));
    });
  }, 120_000);

  afterAll(async () => {
    server?.kill('SIGTERM');
    await t?.close();
  });

  it('denies every operator path without a session, then without MFA, and allows only after TOTP verification', async () => {
    const paths = ['/api/operator/me', '/', '/orders', '/api/operator/anything'];
    for (const p of paths) expect((await request(p)).status).toBe(401);

    const operatorAuth = createOperatorAuth({ authDb: t.auth, appDb: t.app, secret: OPERATOR_SECRET, baseURL: `https://${DESK_HOST}`, rateLimit: { enabled: false } });
    const email = `op-${randomUUID()}@inrp2p.test`;
    await provisionOperator(operatorAuth, t.app, { email, name: 'Op', password: PASSWORD, roles: ['DEALER'] });

    expect((await request('/api/auth/sign-in/email', { method: 'POST', body: { email, password: PASSWORD } })).status).toBe(200);
    for (const p of paths) {
      const r = await request(p);
      expect(r.status).toBe(403);
      expect(r.json).toEqual({ error: 'MFA_ENROLLMENT_REQUIRED' });
    }

    const enable = await request('/api/auth/two-factor/enable', { method: 'POST', body: { password: PASSWORD } });
    expect(enable.status).toBe(200);
    const secret = new TextDecoder().decode(base32.decode(new URL(String(enable.json!.totpURI)).searchParams.get('secret')!));
    expect((await request('/api/auth/two-factor/verify-totp', { method: 'POST', body: { code: await createOTP(secret).totp() } })).status).toBe(200);

    const me = await request('/api/operator/me');
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ roles: ['DEALER'] });
    expect((await request('/orders')).status).toBe(404); // passes the gate; no page exists in Phase 1

    // A desk session is not valid on the client host.
    expect((await request('/api/client/me', { host: 'app.inrp2p.test' })).status).toBe(401);
  }, 60_000);
});
