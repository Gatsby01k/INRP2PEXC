import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  NotificationDeliveryError, ResendEmailClient, ResendNotificationAdapter, UnconfiguredNotificationAdapter, deliveryFailureOf, notificationAdapterFromEnv,
} from '../src/index.ts';

/**
 * The Resend adapter against a local server that behaves the way the provider does where it matters: it remembers
 * idempotency keys (the same key is the same email), it can be slow, rate-limit, fail, refuse, or answer without an id.
 */
interface Received {
  readonly key: string | undefined;
  readonly auth: string | undefined;
  readonly body: { from: string; to: string[]; subject: string; text: string; html?: string };
}

let server: Server;
let base = '';
const received: Received[] = [];
const byKey = new Map<string, string>();
let script: ((req: IncomingMessage, res: ServerResponse, body: string) => boolean)[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const step = script.shift();
      if (step && step(req, res, raw)) return;
      const key = req.headers['idempotency-key'] as string | undefined;
      received.push({ key, auth: req.headers.authorization, body: JSON.parse(raw) as Received['body'] });
      const id = (key && byKey.get(key)) ?? `re_${byKey.size + 1}`;
      if (key) byKey.set(key, id);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  received.length = 0;
  byKey.clear();
  script = [];
});

const respond = (status: number, body: unknown) => (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  return true;
};
const hang = (ms: number) => (_req: IncomingMessage, res: ServerResponse) => {
  setTimeout(() => res.writeHead(200).end(JSON.stringify({ id: 'late' })), ms);
  return true;
};

const API_KEY = 're_test_secret_key_value'; // secret-scan:allow — a placeholder the local test server checks for
const client = (opts: { retries?: number; timeoutMs?: number } = {}) =>
  new ResendEmailClient({ apiKey: API_KEY, from: 'INRP2P <desk@inrp2p.test>', baseUrl: base, retryBaseDelayMs: 1, ...opts });
const adapter = () => new ResendNotificationAdapter({ apiKey: API_KEY, from: 'INRP2P <desk@inrp2p.test>', baseUrl: base, retryBaseDelayMs: 1, timeoutMs: 300 });

describe('Resend email (E1)', () => {
  it('sends an acceptance code with only the code, the quote and the expiry, under the delivery’s idempotency key', async () => {
    const out = await adapter().sendAcceptanceCode({ deliveryId: '0192f0c1-aaaa-7bbb-8ccc-000000000001', to: 'ops@client.test', code: '483921', quoteRef: 'QT-261005-0042', expiresAt: new Date('2026-10-05T10:15:00Z') });
    expect(out.providerMessageId).toBe('re_1');
    const [r] = received;
    expect(r!.auth).toBe(`Bearer ${API_KEY}`);
    expect(r!.key).toBe('otp-delivery/0192f0c1-aaaa-7bbb-8ccc-000000000001');
    expect(r!.body).toMatchObject({ from: 'INRP2P <desk@inrp2p.test>', to: ['ops@client.test'], subject: 'Your code for quote QT-261005-0042' });
    expect(r!.body.text).toContain('483921');
    expect(r!.body.text).toContain('15:45 IST');
    // Nothing about money, accounts or wallets travels with a code (SECURITY §2.3).
    expect(r!.body.text).not.toMatch(/₹|\bINR\b|USDT|IFSC|account|wallet/i);
  });

  it('is one email for one delivery: a repeated send, or a retry after a timeout, gets the original id', async () => {
    const a = adapter();
    const message = { deliveryId: '0192f0c1-aaaa-7bbb-8ccc-000000000002', to: 'ops@client.test', subject: 'Quote ready', body: 'QT-1 is ready.', link: 'https://app.inrp2p.test/exchange' };
    const first = await a.sendClientNotification(message);
    // The provider was slow on the second try; the client timed out and retried under the same key.
    script = [hang(500)];
    const second = await a.sendClientNotification(message);
    expect(second.providerMessageId).toBe(first.providerMessageId);
    expect(new Set(received.map((r) => r.key))).toEqual(new Set(['client-notification-email/0192f0c1-aaaa-7bbb-8ccc-000000000002']));
    expect(received[0]!.body.text).toBe('QT-1 is ready.\n\nOpen it: https://app.inrp2p.test/exchange\n\n— INRP2P Exchange');
  });

  it('retries an outage, a rate limit and a busy key a bounded number of times, then hands the failure back', async () => {
    script = [respond(503, { name: 'internal_server_error' }), respond(429, { name: 'rate_limit_exceeded' })];
    expect((await client().send({ to: 'a@b.test', subject: 's', text: 't' }, 'test-key-retry-1')).id).toBe('re_1');
    script = [respond(409, { name: 'concurrent_idempotent_requests' })];
    expect((await client().send({ to: 'a@b.test', subject: 's', text: 't' }, 'test-key-retry-2')).id).toBe('re_2');
    script = [respond(503, {}), respond(503, {}), respond(503, {})];
    const down = await client({ retries: 2 }).send({ to: 'a@b.test', subject: 's', text: 't' }, 'test-key-retry-3').catch((e: unknown) => e);
    expect(down).toBeInstanceOf(NotificationDeliveryError);
    expect(deliveryFailureOf(down)).toEqual({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    script = [hang(400), hang(400)];
    const slow = await client({ retries: 1, timeoutMs: 100 }).send({ to: 'a@b.test', subject: 's', text: 't' }, 'test-key-retry-4').catch((e: unknown) => e);
    expect(deliveryFailureOf(slow)).toEqual({ code: 'PROVIDER_TIMEOUT', retryable: true });
  });

  it('never calls an answer without a message id a delivery, and does not retry a refusal', async () => {
    script = [respond(200, {}), respond(200, {}), respond(200, {})];
    const ambiguous = await client().send({ to: 'a@b.test', subject: 's', text: 't' }, 'test-key-ambiguous').catch((e: unknown) => e);
    expect(deliveryFailureOf(ambiguous)).toEqual({ code: 'PROVIDER_AMBIGUOUS', retryable: true });
    for (const [status, name] of [[422, 'validation_error'], [401, 'missing_api_key'], [403, 'invalid_from_address'], [409, 'invalid_idempotent_request']] as const) {
      script = [respond(status, { name, message: `the provider echoes ops@client.test and 483921 and ${API_KEY}` })];
      const refused = await client().send({ to: 'ops@client.test', subject: 's', text: '483921' }, `test-key-refused-${status}-${name}`).catch((e: unknown) => e);
      expect(deliveryFailureOf(refused)).toEqual({ code: `PROVIDER_REJECTED_${status}`, retryable: false });
      expect(script).toHaveLength(0); // answered once, not retried
      // What is stored and logged is a code: never the provider's message, the address, the code or the key.
      expect(String((refused as Error).message)).not.toMatch(/ops@client|483921|re_test_secret/);
    }
  });

  it('comes from the environment: Resend when configured, otherwise a channel that refuses loudly; production needs https', () => {
    expect(notificationAdapterFromEnv({})).toBeInstanceOf(UnconfiguredNotificationAdapter);
    expect(notificationAdapterFromEnv({ RESEND_API_KEY: 'k' })).toBeInstanceOf(UnconfiguredNotificationAdapter);
    expect(notificationAdapterFromEnv({ RESEND_API_KEY: 'k', RESEND_FROM: 'INRP2P <desk@inrp2p.test>' }).provider).toBe('resend');
    expect(() => notificationAdapterFromEnv({ RESEND_API_KEY: 'k', RESEND_FROM: 'x <a@b.test>', RESEND_BASE_URL: 'http://mail.internal', INRP2P_ENV: 'production' })).toThrow(/https/);
  });
});
