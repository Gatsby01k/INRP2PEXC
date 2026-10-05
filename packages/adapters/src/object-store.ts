import { createHash } from 'node:crypto';
import { DomainError } from '@inrp2p/kernel';
import { type CredentialSource, amzDateOf, awsCredentialsFromEnvironment, signSigV4 } from './aws-kms.ts';

/**
 * Private object storage (production task E2 for receipts, TD-12; E4 for audit-seal exports, TD-17).
 *
 * An S3-compatible bucket spoken to over HTTPS with Signature Version 4 — AWS S3, or any store that implements the same
 * API (MinIO, Cloudflare R2, …) — chosen by configuration, never by code. What this port promises:
 *
 * - **Write once.** `putOnce` sends `If-None-Match: *`: an object that exists is never overwritten. When it exists, its
 *   bytes are read back and must equal what was asked to be written; a key with other bytes is a conflict, raised.
 * - **Integrity.** Every write carries `Content-MD5` and `x-amz-checksum-sha256`; the store rejects bytes that do not
 *   match, and the caller records the sha256 it can verify on every read.
 * - **Immutability.** With `retainUntil`, the object is written under Object Lock in COMPLIANCE mode: nobody — not the
 *   application, not an administrator of the account — can delete or overwrite it before then. The bucket must have
 *   versioning and Object Lock enabled; `describeBucket` says whether it does, and production refuses one that does not.
 * - **Private.** Nothing here makes an object public or presigns a URL; reads go through the application, which
 *   authorizes the reader first.
 */
export interface ObjectStore {
  readonly provider: string;
  readonly bucket: string;
  /** Writes `body` at `key` unless an object is already there; then the existing bytes must be the same. */
  putOnce(key: string, body: Uint8Array, opts: { readonly contentType: string; readonly retainUntil?: Date | null }): Promise<{ readonly created: boolean; readonly versionId: string | null }>;
  /** The object's bytes — of one recorded version, when given — or null when there is none. */
  get(key: string, versionId?: string | null): Promise<{ readonly body: Buffer; readonly versionId: string | null } | null>;
  /** Keys under a prefix, in key order (one page of at most `max`). */
  list(prefix: string, max?: number): Promise<readonly string[]>;
  /** Versioning and Object Lock as the bucket reports them. */
  describeBucket(): Promise<{ readonly versioning: 'Enabled' | 'Suspended' | 'Off'; readonly objectLock: boolean }>;
}

export interface S3ObjectStoreOptions {
  /** `https://s3.<region>.amazonaws.com`, or another S3-compatible endpoint. */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly credentials: CredentialSource;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly retryBaseDelayMs?: number;
}

const KEY = /^[a-z0-9][a-z0-9/._-]{0,900}$/;
const RETRYABLE = new Set([500, 502, 503, 504]);

export class S3ObjectStore implements ObjectStore {
  readonly provider = 's3';
  readonly bucket: string;
  readonly #opts: S3ObjectStoreOptions;

  constructor(opts: S3ObjectStoreOptions) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(opts.bucket)) throw new DomainError('INVALID_ARGUMENT', 'not an S3 bucket name');
    this.bucket = opts.bucket;
    this.#opts = opts;
  }

  #url(key: string, query = ''): URL {
    // Path-style addressing: it works for every S3-compatible store, and the key alphabet needs no escaping.
    return new URL(`${this.#opts.endpoint.replace(/\/$/, '')}/${this.bucket}${key ? `/${key}` : ''}${query}`);
  }

  async #request(method: string, url: URL, body: Uint8Array | null, headers: Record<string, string> = {}): Promise<Response> {
    const fetchImpl = this.#opts.fetchImpl ?? fetch;
    const payload = body ?? new Uint8Array(0);
    const retries = this.#opts.retries ?? 2;
    let last = 'no attempt made';
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, (this.#opts.retryBaseDelayMs ?? 200) * 2 ** (attempt - 1)));
      try {
        const signed = signSigV4({
          method, url, body: payload, region: this.#opts.region, service: 's3', credentials: await this.#opts.credentials(), amzDate: amzDateOf(new Date()),
          headers: { ...headers, 'x-amz-content-sha256': createHash('sha256').update(payload).digest('hex') },
        });
        delete signed.host;
        const res = await fetchImpl(url, { method, headers: signed, ...(body ? { body: Buffer.from(body) } : {}), signal: AbortSignal.timeout(this.#opts.timeoutMs ?? 10_000) });
        if (!RETRYABLE.has(res.status)) return res;
        last = `status ${res.status}`;
        await res.arrayBuffer().catch(() => undefined);
      } catch (e) {
        last = (e as Error).name === 'TimeoutError' ? 'timeout' : 'unreachable';
      }
    }
    throw new DomainError('OBJECT_STORE_UNAVAILABLE', `object store did not answer ${method}: ${last}`);
  }

  async putOnce(key: string, body: Uint8Array, opts: { readonly contentType: string; readonly retainUntil?: Date | null }) {
    if (!KEY.test(key)) throw new DomainError('INVALID_ARGUMENT', 'object keys are lower-case letters, digits and / . _ -');
    const headers: Record<string, string> = {
      'content-type': opts.contentType,
      'content-md5': createHash('md5').update(body).digest('base64'),
      'x-amz-checksum-sha256': createHash('sha256').update(body).digest('base64'),
      'if-none-match': '*',
    };
    if (opts.retainUntil) {
      headers['x-amz-object-lock-mode'] = 'COMPLIANCE';
      headers['x-amz-object-lock-retain-until-date'] = opts.retainUntil.toISOString();
    }
    const res = await this.#request('PUT', this.#url(key), body, headers);
    const text = await res.text();
    if (res.ok) return { created: true, versionId: res.headers.get('x-amz-version-id') };
    if (res.status === 412) {
      // Already there: it must be the same bytes, or someone wrote something else under a key that names its content.
      const existing = await this.get(key);
      if (existing && Buffer.compare(existing.body, Buffer.from(body)) === 0) return { created: false, versionId: existing.versionId };
      throw new DomainError('OBJECT_STORE_CONFLICT', `object ${key} exists with other bytes`);
    }
    throw new DomainError('OBJECT_STORE_REFUSED', `object store refused PUT ${key}: ${res.status} ${codeOf(text)}`);
  }

  async get(key: string, versionId?: string | null) {
    if (!KEY.test(key)) throw new DomainError('INVALID_ARGUMENT', 'object keys are lower-case letters, digits and / . _ -');
    const res = await this.#request('GET', this.#url(key, versionId ? `?versionId=${encodeURIComponent(versionId)}` : ''), null);
    if (res.status === 404) {
      await res.arrayBuffer().catch(() => undefined);
      return null;
    }
    if (!res.ok) throw new DomainError('OBJECT_STORE_REFUSED', `object store refused GET ${key}: ${res.status} ${codeOf(await res.text())}`);
    return { body: Buffer.from(await res.arrayBuffer()), versionId: res.headers.get('x-amz-version-id') };
  }

  async list(prefix: string, max = 1000): Promise<readonly string[]> {
    const res = await this.#request('GET', this.#url('', `?list-type=2&max-keys=${Math.min(Math.max(max, 1), 1000)}&prefix=${encodeURIComponent(prefix)}`), null);
    const text = await res.text();
    if (!res.ok) throw new DomainError('OBJECT_STORE_REFUSED', `object store refused LIST: ${res.status} ${codeOf(text)}`);
    return [...text.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!).sort();
  }

  async describeBucket() {
    const v = await this.#request('GET', this.#url('', '?versioning'), null);
    const versioningXml = await v.text();
    if (!v.ok) throw new DomainError('OBJECT_STORE_REFUSED', `object store refused versioning read: ${v.status} ${codeOf(versioningXml)}`);
    const status = /<Status>(Enabled|Suspended)<\/Status>/.exec(versioningXml)?.[1] as 'Enabled' | 'Suspended' | undefined;
    const l = await this.#request('GET', this.#url('', '?object-lock'), null);
    const lockXml = await l.text();
    return { versioning: status ?? ('Off' as const), objectLock: l.ok && /<ObjectLockEnabled>Enabled<\/ObjectLockEnabled>/.test(lockXml) };
  }
}

/** The error code an S3 answer carries — never its message, which may echo a key or a request. */
function codeOf(xml: string): string {
  return /<Code>([A-Za-z]{1,60})<\/Code>/.exec(xml)?.[1] ?? 'Error';
}

/** Where nothing is configured: every operation refuses loudly, so a missing store is never a silent no-op. */
export class UnconfiguredObjectStore implements ObjectStore {
  readonly provider = 'unconfigured';
  readonly bucket = '';
  async putOnce(): Promise<never> {
    throw new DomainError('OBJECT_STORE_NOT_CONFIGURED', 'no object store is configured');
  }
  async get(): Promise<never> {
    throw new DomainError('OBJECT_STORE_NOT_CONFIGURED', 'no object store is configured');
  }
  async list(): Promise<never> {
    throw new DomainError('OBJECT_STORE_NOT_CONFIGURED', 'no object store is configured');
  }
  async describeBucket(): Promise<never> {
    throw new DomainError('OBJECT_STORE_NOT_CONFIGURED', 'no object store is configured');
  }
}

export const isObjectStoreConfigured = (store: ObjectStore): boolean => !(store instanceof UnconfiguredObjectStore);

/**
 * The bucket for one purpose, from the environment: `INRP2P_RECEIPTS_BUCKET` or `INRP2P_AUDIT_SEAL_BUCKET`, with
 * `INRP2P_OBJECT_STORE_ENDPOINT` and `INRP2P_OBJECT_STORE_REGION`; credentials from the workload's role (or the AWS
 * environment variables), never from a file. Production refuses an endpoint that is not HTTPS.
 */
export function objectStoreFromEnv(purpose: 'RECEIPTS' | 'AUDIT_SEALS', env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): ObjectStore {
  const bucket = (env[purpose === 'RECEIPTS' ? 'INRP2P_RECEIPTS_BUCKET' : 'INRP2P_AUDIT_SEAL_BUCKET'] ?? '').trim();
  if (!bucket) return new UnconfiguredObjectStore();
  const region = (env.INRP2P_OBJECT_STORE_REGION ?? env.AWS_REGION ?? '').trim();
  const endpoint = (env.INRP2P_OBJECT_STORE_ENDPOINT ?? '').trim() || (region ? `https://s3.${region}.amazonaws.com` : '');
  if (!region || !endpoint) throw new DomainError('INVALID_ARGUMENT', 'object storage needs INRP2P_OBJECT_STORE_REGION (and an endpoint for a non-AWS store)');
  if ((env.INRP2P_ENV ?? '').toLowerCase() === 'production' && !endpoint.startsWith('https://')) {
    throw new DomainError('INVALID_ARGUMENT', 'INRP2P_OBJECT_STORE_ENDPOINT must be https in production');
  }
  return new S3ObjectStore({ endpoint, region, bucket, credentials: awsCredentialsFromEnvironment(env, fetchImpl ?? fetch), ...(fetchImpl ? { fetchImpl } : {}) });
}
