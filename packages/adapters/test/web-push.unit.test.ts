import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeWebPush, VapidWebPush, encryptPushPayload, vapidToken, webPushFromEnv } from '../src/web-push.ts';

/** The browser's side of RFC 8291: what it holds, and how it reads a push. */
function browser() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: auth.toString('base64url'),
    read(body: Buffer): string {
      const salt = body.subarray(0, 16);
      const idLen = body.readUInt8(20);
      const asPublic = body.subarray(21, 21 + idLen);
      const record = body.subarray(21 + idLen);
      const shared = ecdh.computeSecret(asPublic);
      const info = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), ecdh.getPublicKey(), asPublic]);
      const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32));
      const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16));
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));
      const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
      decipher.setAuthTag(record.subarray(record.length - 16));
      const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
      expect(plain.at(-1)).toBe(2);
      return plain.subarray(0, plain.length - 1).toString('utf8');
    },
  };
}

function vapidKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url') };
}

describe('Web Push (ADR 0033)', () => {
  it('encrypts a message only the subscribing browser can read (RFC 8291, aes128gcm)', () => {
    const b = browser();
    const body = encryptPushPayload(b, Buffer.from(JSON.stringify({ title: 'A seller is ready at ₹102.26', url: '/exchange' })));
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(JSON.parse(b.read(body))).toEqual({ title: 'A seller is ready at ₹102.26', url: '/exchange' });
    // Another browser reads nothing.
    expect(() => browser().read(body)).toThrow();
  });

  it('signs a VAPID token the push service can check against the public key (RFC 8292)', () => {
    const k = vapidKeys();
    const token = vapidToken({ audience: 'https://fcm.googleapis.com', subject: 'mailto:ops@example.test', ...k, expiresAt: 2_000_000_000 });
    const [head, claims, sig] = token.split('.');
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: 2_000_000_000, sub: 'mailto:ops@example.test' });
    const pub = Buffer.from(k.publicKey, 'base64url');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url'))).toBe(true);
  });

  it('posts to the endpoint with the VAPID header; a gone subscription is permanent, throttling is not', async () => {
    const k = vapidKeys();
    const b = browser();
    const calls: { url: string; init: RequestInit }[] = [];
    let status = 201;
    const push = new VapidWebPush({ ...k, subject: 'mailto:ops@example.test', fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(null, { status });
    }) as typeof fetch });
    await push.send({ endpoint: 'https://push.example.test/abc', ...b }, { title: 'T', body: 'B', url: '/exchange' });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['content-encoding']).toBe('aes128gcm');
    expect(headers.authorization).toMatch(new RegExp(`^vapid t=[^,]+, k=${k.publicKey}$`));
    status = 410;
    await expect(push.send({ endpoint: 'https://push.example.test/abc', ...b }, { title: 'T', body: 'B', url: null })).rejects.toMatchObject({ code: 'PUSH_GONE', retryable: false });
    status = 429;
    await expect(push.send({ endpoint: 'https://push.example.test/abc', ...b }, { title: 'T', body: 'B', url: null })).rejects.toMatchObject({ retryable: true });
    await expect(push.send({ endpoint: 'http://push.example.test/abc', ...b }, { title: 'T', body: 'B', url: null })).rejects.toMatchObject({ code: 'PUSH_BAD_ENDPOINT' });
  });

  it('is configured only with all three settings', () => {
    const k = vapidKeys();
    expect(webPushFromEnv({})).toBeNull();
    expect(webPushFromEnv({ WEB_PUSH_PUBLIC_KEY: k.publicKey, WEB_PUSH_PRIVATE_KEY: k.privateKey })).toBeNull();
    expect(webPushFromEnv({ WEB_PUSH_PUBLIC_KEY: k.publicKey, WEB_PUSH_PRIVATE_KEY: k.privateKey, WEB_PUSH_SUBJECT: 'mailto:ops@example.test' })?.publicKey).toBe(k.publicKey);
    expect(new FakeWebPush().publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
  });
});
