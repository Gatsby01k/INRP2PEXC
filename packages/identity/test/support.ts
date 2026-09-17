import { randomBytes } from 'node:crypto';
import { base32 } from '@better-auth/utils/base32';
import { createOTP } from '@better-auth/utils/otp';
import type { TestDatabase } from '@inrp2p/db/testing';
import { createClientAuth, createOperatorAuth } from '../src/index.ts';

export const DESK = 'https://desk.inrp2p.test';
export const APP = 'https://app.inrp2p.test';

export class CookieJar {
  private cookies = new Map<string, string>();
  readonly raw: string[] = [];
  absorb(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      this.raw.push(c);
      const [pair] = c.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      if (/max-age=0/i.test(c) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get(name: string): string | undefined {
    return this.cookies.get(name);
  }
  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }
  headers(origin: string): Headers {
    const h = new Headers({ origin });
    const cookie = this.header();
    if (cookie) h.set('cookie', cookie);
    return h;
  }
}

export async function call(auth: { handler: (r: Request) => Promise<Response> }, base: string, jar: CookieJar, path: string, body?: unknown, method = 'POST') {
  const headers = jar.headers(base);
  headers.set('content-type', 'application/json');
  headers.set('x-forwarded-for', '203.0.113.10');
  const res = await auth.handler(new Request(`${base}/api/auth${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  jar.absorb(res);
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json: json as Record<string, unknown> | null };
}

export function totpFromUri(uri: string): string {
  const secretB32 = new URL(uri).searchParams.get('secret')!;
  const raw = new TextDecoder().decode(base32.decode(secretB32));
  return raw;
}

export async function currentTotp(rawSecret: string): Promise<string> {
  return createOTP(rawSecret).totp();
}

export function buildAuths(t: TestDatabase, sent: { email: string; otp: string; type: string }[], opts: { rateLimit?: boolean } = {}) {
  const rateLimit = { enabled: opts.rateLimit ?? false };
  const operator = createOperatorAuth({ authDb: t.auth, appDb: t.app, secret: randomBytes(32).toString('hex'), baseURL: DESK, rateLimit });
  const client = createClientAuth({
    authDb: t.auth, appDb: t.app, secret: randomBytes(32).toString('hex'), baseURL: APP, rateLimit,
    otpSender: { send: async (m) => { sent.push(m); } },
  });
  return { operator, client };
}
