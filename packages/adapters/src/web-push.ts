import { createECDH, createPrivateKey, hkdfSync, randomBytes, sign, createCipheriv } from 'node:crypto';
import { NotificationDeliveryError } from './notifications.ts';

/**
 * Web Push (ADR 0033 §2.6): the client's instant channel in its own browser, beside Telegram. One VAPID key pair for the
 * deployment; each subscription's payload is encrypted for that browser alone (RFC 8291, `aes128gcm`) and signed for
 * the push service (RFC 8292). No dependency: P-256, HKDF and AES-GCM are node's own. Like Telegram it only tells — a
 * push opens a page of the product, where the person acts signed in.
 */
export interface PushTarget {
  readonly endpoint: string;
  /** The browser's P-256 public key, uncompressed, base64url (`keys.p256dh`). */
  readonly p256dh: string;
  /** The browser's 16-byte auth secret, base64url (`keys.auth`). */
  readonly auth: string;
}

export interface PushMessage {
  readonly title: string;
  readonly body: string;
  /** A path of the product the notification opens. */
  readonly url: string | null;
  /** Notifications with one tag replace each other on the device. */
  readonly tag?: string;
}

export interface WebPushAdapter {
  /** The VAPID public key the browser subscribes with (base64url, uncompressed P-256). */
  readonly publicKey: string;
  send(target: PushTarget, message: PushMessage): Promise<void>;
}

const b64u = (b: Buffer): string => b.toString('base64url');
const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url');

/** RFC 8291 §3–4: the encrypted body for one browser — salt, record size, the sender's key, then one AES-128-GCM record. */
export function encryptPushPayload(target: Pick<PushTarget, 'p256dh' | 'auth'>, plaintext: Buffer, fixed?: { salt: Buffer; privateKey: Buffer }): Buffer {
  const uaPublic = fromB64u(target.p256dh);
  const authSecret = fromB64u(target.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new NotificationDeliveryError('PUSH_BAD_KEY', false);
  if (authSecret.length !== 16) throw new NotificationDeliveryError('PUSH_BAD_AUTH', false);
  const ecdh = createECDH('prime256v1');
  if (fixed) ecdh.setPrivateKey(fixed.privateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = fixed?.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // One record, the last: the content, then the padding delimiter 0x02.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** RFC 8292: the VAPID token for one push service's origin, signed ES256 (raw r‖s). */
export function vapidToken(input: { audience: string; subject: string; publicKey: string; privateKey: string; expiresAt: number }): string {
  const pub = fromB64u(input.publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', d: input.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) };
  const key = createPrivateKey({ key: jwk, format: 'jwk' });
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: input.audience, exp: input.expiresAt, sub: input.subject })));
  const signature = sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${claims}.${b64u(signature)}`;
}

/**
 * The push services browsers subscribe to (Google's, Mozilla's, Apple's): one POST per message. Gone (404, 410) is
 * permanent — the subscription is over; a malformed request (400, 413) too; throttling and server errors are not.
 */
export class VapidWebPush implements WebPushAdapter {
  readonly publicKey: string;
  readonly #privateKey: string;
  readonly #subject: string;
  readonly #fetch: typeof fetch;

  constructor(opts: { publicKey: string; privateKey: string; subject: string; fetchImpl?: typeof fetch }) {
    if (fromB64u(opts.publicKey).length !== 65) throw new Error('WEB_PUSH_PUBLIC_KEY must be an uncompressed P-256 key, base64url');
    if (fromB64u(opts.privateKey).length !== 32) throw new Error('WEB_PUSH_PRIVATE_KEY must be a 32-byte P-256 key, base64url');
    if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(opts.subject)) throw new Error('WEB_PUSH_SUBJECT must be a mailto: or https: URL');
    this.publicKey = opts.publicKey;
    this.#privateKey = opts.privateKey;
    this.#subject = opts.subject;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async send(target: PushTarget, message: PushMessage): Promise<void> {
    let url: URL;
    try {
      url = new URL(target.endpoint);
    } catch {
      throw new NotificationDeliveryError('PUSH_BAD_ENDPOINT', false);
    }
    if (url.protocol !== 'https:') throw new NotificationDeliveryError('PUSH_BAD_ENDPOINT', false);
    const payload = Buffer.from(JSON.stringify({ title: message.title, body: message.body, url: message.url, tag: message.tag ?? null }));
    const body = encryptPushPayload(target, payload);
    const token = vapidToken({ audience: url.origin, subject: this.#subject, publicKey: this.publicKey, privateKey: this.#privateKey, expiresAt: Math.floor(Date.now() / 1000) + 12 * 3600 });
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method: 'POST',
        headers: { 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '3600', urgency: 'high', authorization: `vapid t=${token}, k=${this.publicKey}` },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new NotificationDeliveryError('PUSH_UNREACHABLE', true);
    }
    if (res.status >= 200 && res.status < 300) return;
    if (res.status === 404 || res.status === 410) throw new NotificationDeliveryError('PUSH_GONE', false);
    if (res.status === 400 || res.status === 413 || res.status === 403) throw new NotificationDeliveryError(`PUSH_${res.status}`, false);
    throw new NotificationDeliveryError(`PUSH_${res.status}`, res.status === 429 || res.status >= 500);
  }
}

/** Remembers what it would have pushed — for tests and local runs. */
export class FakeWebPush implements WebPushAdapter {
  readonly publicKey: string;
  readonly sent: { target: PushTarget; message: PushMessage }[] = [];
  constructor(publicKey = b64u(createECDH('prime256v1').generateKeys())) {
    this.publicKey = publicKey;
  }
  async send(target: PushTarget, message: PushMessage): Promise<void> {
    this.sent.push({ target, message });
  }
}

/** The Web Push channel the environment configures (`WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`, `WEB_PUSH_SUBJECT`), or none. */
export function webPushFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): WebPushAdapter | null {
  const publicKey = env.WEB_PUSH_PUBLIC_KEY?.trim();
  const privateKey = env.WEB_PUSH_PRIVATE_KEY?.trim();
  const subject = env.WEB_PUSH_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  return new VapidWebPush({ publicKey, privateKey, subject, ...(fetchImpl ? { fetchImpl } : {}) });
}

/** The public half alone, for the browser to subscribe with — the web app never holds the private key. */
export function webPushPublicKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const k = env.WEB_PUSH_PUBLIC_KEY?.trim();
  return k && fromB64u(k).length === 65 ? k : null;
}
