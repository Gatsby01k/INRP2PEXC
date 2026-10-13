import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DomainError } from '@inrp2p/kernel';
import type { KeyEncryptionKey } from './keys.ts';

/**
 * AWS KMS as the key-encryption key (TD-03, ARCHITECTURE §8). The application never holds the KEK: each field's data
 * key is wrapped and unwrapped by KMS (`Encrypt` / `Decrypt` on one symmetric KMS key), with an encryption context
 * that binds every wrapped key to this application and purpose — KMS refuses to unwrap it under any other context,
 * and the IAM policy can require that context (see RUNBOOKS `field-encryption-keys`).
 *
 * Spoken to over its HTTPS JSON API with Signature Version 4, so no SDK is needed; credentials come from the
 * environment, the container's task role or the instance role, never from configuration files. A KMS that cannot be
 * reached fails the operation — there is no plaintext fallback.
 */

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string | undefined;
  /** When temporary credentials stop working; refreshed before then. */
  readonly expiration?: Date | undefined;
}

export type CredentialSource = () => Promise<AwsCredentials>;

const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** The SigV4 signing key for one day, region and service. */
export function sigV4SigningKey(secretAccessKey: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), 'aws4_request');
}

const encode = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Signs one request with Signature Version 4 (AWS General Reference): canonical request → string to sign →
 * HMAC with the day's signing key. Returns every header to send, `authorization` included.
 */
export function signSigV4(req: {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array;
  readonly region: string;
  readonly service: string;
  readonly credentials: AwsCredentials;
  /** `YYYYMMDDTHHMMSSZ`. */
  readonly amzDate: string;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
  headers.host = req.url.host;
  headers['x-amz-date'] = req.amzDate;
  if (req.credentials.sessionToken) headers['x-amz-security-token'] = req.credentials.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...req.url.searchParams.entries()]
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [req.method.toUpperCase(), req.url.pathname || '/', query, canonicalHeaders, signedHeaders, sha256Hex(req.body)].join('\n');
  const scope = `${req.amzDate.slice(0, 8)}/${req.region}/${req.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', req.amzDate, scope, sha256Hex(canonical)].join('\n');
  const signature = createHmac('sha256', sigV4SigningKey(req.credentials.secretAccessKey, req.amzDate.slice(0, 8), req.region, req.service)).update(stringToSign, 'utf8').digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${req.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

/** `YYYYMMDDTHHMMSSZ`, the timestamp SigV4 signs. */
export const amzDateOf = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Where the Vercel runtime keeps the current request, as `@vercel/functions` reads it (`getContext()`). */
const VERCEL_REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

/**
 * The web identity token to exchange for a role's credentials, when there is one: the file the platform names
 * (`AWS_WEB_IDENTITY_TOKEN_FILE`, as on EKS), or — on Vercel with OIDC federation turned on — the token Vercel hands
 * every request in `x-vercel-oidc-token` (read from the request context exactly as `@vercel/functions`'
 * `getVercelOidcToken()` does), else `VERCEL_OIDC_TOKEN` (builds and local development).
 */
export function webIdentityToken(env: NodeJS.ProcessEnv = process.env, readFile: (path: string) => string = (p) => readFileSync(p, 'utf8')): string | null {
  const file = (env.AWS_WEB_IDENTITY_TOKEN_FILE ?? '').trim();
  if (file) return readFile(file).trim() || null;
  const context = (globalThis as { [VERCEL_REQUEST_CONTEXT]?: { get?: () => { headers?: Record<string, string | undefined> } | undefined } })[VERCEL_REQUEST_CONTEXT]?.get?.();
  const fromRequest = context?.headers?.['x-vercel-oidc-token'];
  if (fromRequest) return fromRequest;
  return (env.VERCEL_OIDC_TOKEN ?? '').trim() || null;
}

const xmlValue = (xml: string, tag: string): string | undefined => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];

/**
 * STS `AssumeRoleWithWebIdentity`: the role named by `AWS_ROLE_ARN`, for the identity the token proves. The call is not
 * signed — the token is the proof — and the answer is temporary credentials, never a long-term key.
 */
async function assumeRoleWithWebIdentity(env: NodeJS.ProcessEnv, token: string, fetchImpl: typeof fetch): Promise<AwsCredentials> {
  const region = (env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? '').trim() || 'us-east-1';
  const session = (env.AWS_ROLE_SESSION_NAME ?? '').trim().replace(/[^\w+=,.@-]/g, '').slice(0, 64) || `inrp2p-${Date.now()}`;
  const body = new URLSearchParams({
    Action: 'AssumeRoleWithWebIdentity', Version: '2011-06-15', RoleArn: env.AWS_ROLE_ARN!.trim(), RoleSessionName: session,
    WebIdentityToken: token, DurationSeconds: '3600',
  });
  let res: Response;
  try {
    res = await fetchImpl(`https://sts.${region}.amazonaws.com/`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, body: body.toString(), signal: AbortSignal.timeout(5_000),
    });
  } catch (e) {
    throw new DomainError('KMS_UNAVAILABLE', `STS did not answer AssumeRoleWithWebIdentity: ${(e as Error).message}`);
  }
  const xml = await res.text();
  if (!res.ok) {
    const code = xmlValue(xml, 'Code') ?? String(res.status);
    // A refused identity or role is configuration, not an outage: asking again will not help.
    if (res.status >= 400 && res.status < 500 && code !== 'Throttling' && code !== 'IDPCommunicationError') throw new DomainError('KMS_REFUSED', `STS refused the web identity: ${code}`);
    throw new DomainError('KMS_UNAVAILABLE', `STS answered ${res.status} ${code}`);
  }
  const accessKeyId = xmlValue(xml, 'AccessKeyId');
  const secretAccessKey = xmlValue(xml, 'SecretAccessKey');
  const expiration = xmlValue(xml, 'Expiration');
  if (!accessKeyId || !secretAccessKey) throw new DomainError('KMS_UNAVAILABLE', 'STS returned no credentials');
  return { accessKeyId, secretAccessKey, sessionToken: xmlValue(xml, 'SessionToken'), expiration: expiration ? new Date(expiration) : undefined };
}

/**
 * Where the process's AWS credentials come from, in the order the AWS SDKs use: environment variables, a web identity
 * (`AWS_ROLE_ARN` with a token — Vercel's OIDC federation, or a token file), the container's task role (ECS/EKS), the
 * instance role (IMDSv2). Temporary credentials are cached and refreshed five minutes before they expire. Nothing is
 * read from a file in the repository.
 */
export function awsCredentialsFromEnvironment(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): CredentialSource {
  let cached: AwsCredentials | null = null;
  const fresh = (c: AwsCredentials | null): c is AwsCredentials => c !== null && (!c.expiration || c.expiration.getTime() - Date.now() > 5 * 60_000);
  const parse = (j: { AccessKeyId?: string; SecretAccessKey?: string; Token?: string; Expiration?: string }): AwsCredentials => {
    if (!j.AccessKeyId || !j.SecretAccessKey) throw new DomainError('KMS_UNAVAILABLE', 'the credential endpoint returned no credentials');
    return { accessKeyId: j.AccessKeyId, secretAccessKey: j.SecretAccessKey, sessionToken: j.Token, expiration: j.Expiration ? new Date(j.Expiration) : undefined };
  };
  return async () => {
    if (fresh(cached)) return cached;
    if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
      cached = { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN || undefined };
      return cached;
    }
    if ((env.AWS_ROLE_ARN ?? '').trim()) {
      const token = webIdentityToken(env);
      // A role was named: falling through to the instance role would only hide that the identity is missing.
      if (!token) throw new DomainError('KMS_UNAVAILABLE', 'AWS_ROLE_ARN is set but there is no web identity token (on Vercel: turn on OIDC federation)');
      cached = await assumeRoleWithWebIdentity(env, token, fetchImpl);
      return cached;
    }
    const relative = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    const full = env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
    if (relative || full) {
      const headers: Record<string, string> = {};
      if (env.AWS_CONTAINER_AUTHORIZATION_TOKEN) headers.authorization = env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
      const res = await fetchImpl(relative ? `http://169.254.170.2${relative}` : full!, { headers, signal: AbortSignal.timeout(2_000) });
      if (!res.ok) throw new DomainError('KMS_UNAVAILABLE', `the container credential endpoint answered ${res.status}`);
      cached = parse((await res.json()) as never);
      return cached;
    }
    // IMDSv2: a session token first, then the role's credentials.
    const imds = 'http://169.254.169.254';
    const token = await fetchImpl(`${imds}/latest/api/token`, { method: 'PUT', headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '21600' }, signal: AbortSignal.timeout(1_000) }).catch(() => null);
    if (!token?.ok) throw new DomainError('KMS_UNAVAILABLE', 'no AWS credentials: none in the environment, no task role, no instance role');
    const t = await token.text();
    const role = await fetchImpl(`${imds}/latest/meta-data/iam/security-credentials/`, { headers: { 'x-aws-ec2-metadata-token': t }, signal: AbortSignal.timeout(1_000) });
    const name = (await role.text()).split('\n')[0]?.trim();
    if (!role.ok || !name) throw new DomainError('KMS_UNAVAILABLE', 'the instance has no role');
    const creds = await fetchImpl(`${imds}/latest/meta-data/iam/security-credentials/${name}`, { headers: { 'x-aws-ec2-metadata-token': t }, signal: AbortSignal.timeout(1_000) });
    if (!creds.ok) throw new DomainError('KMS_UNAVAILABLE', `the instance role answered ${creds.status}`);
    cached = parse((await creds.json()) as never);
    return cached;
  };
}

/** KMS errors that will not get better by asking again. */
const PERMANENT = new Set([
  'AccessDeniedException', 'DisabledException', 'IncorrectKeyException', 'InvalidCiphertextException', 'InvalidKeyUsageException',
  'KMSInvalidStateException', 'NotFoundException', 'ValidationException', 'UnrecognizedClientException', 'InvalidSignatureException',
]);

export interface AwsKmsOptions {
  /** The id recorded in every sealed value (url-safe, ≤ 64) — names this KMS key in the application's key ring. */
  readonly keyId: string;
  /** The KMS key's full ARN: `arn:aws:kms:<region>:<account>:key/<id>`. Aliases are refused, so a sealed value always names one key. */
  readonly keyArn: string;
  readonly credentials: CredentialSource;
  /** A VPC endpoint, or a test server; defaults to the regional public endpoint. */
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly retryBaseDelayMs?: number;
  /**
   * Bound to every wrapped key — KMS unwraps it under this context only, and the key policy can require it. Defaults to
   * the field-data-key context; the custody seed uses its own (`purpose: custody-seed`), so a role allowed to open
   * client fields cannot open the seed with the same key.
   */
  readonly encryptionContext?: Readonly<Record<string, string>>;
}

const ARN = /^arn:aws[a-z-]*:kms:([a-z0-9-]+):(\d{12}):key\/([0-9a-f-]{36}|mrk-[0-9a-f]{32})$/;

export class AwsKmsKeyEncryptionKey implements KeyEncryptionKey {
  readonly keyId: string;
  readonly keyArn: string;
  readonly region: string;
  /** Bound to every wrapped key; KMS will not unwrap it under any other. */
  static readonly ENCRYPTION_CONTEXT = Object.freeze({ app: 'inrp2p', purpose: 'field-data-key' });
  readonly #endpoint: URL;
  readonly #opts: AwsKmsOptions;

  constructor(opts: AwsKmsOptions) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(opts.keyId)) throw new DomainError('INVALID_ARGUMENT', 'key id must be url-safe, 1..64 chars');
    const m = ARN.exec(opts.keyArn);
    if (!m) throw new DomainError('INVALID_ARGUMENT', 'INRP2P_KMS_KEY_ARN must be a KMS key ARN (not an alias)');
    this.keyId = opts.keyId;
    this.keyArn = opts.keyArn;
    this.region = m[1]!;
    this.#endpoint = new URL(opts.endpoint ?? `https://kms.${this.region}.amazonaws.com/`);
    this.#opts = opts;
  }

  async wrap(dataKey: Buffer): Promise<Buffer> {
    const out = await this.#call<{ CiphertextBlob?: string; KeyId?: string }>('TrentService.Encrypt', {
      KeyId: this.keyArn, Plaintext: dataKey.toString('base64'), EncryptionContext: this.#opts.encryptionContext ?? AwsKmsKeyEncryptionKey.ENCRYPTION_CONTEXT,
    });
    if (out.KeyId !== this.keyArn || !out.CiphertextBlob) throw new DomainError('KMS_REFUSED', 'KMS answered for another key, or with nothing');
    return Buffer.from(out.CiphertextBlob, 'base64');
  }

  async unwrap(wrapped: Buffer): Promise<Buffer> {
    const out = await this.#call<{ Plaintext?: string; KeyId?: string }>('TrentService.Decrypt', {
      KeyId: this.keyArn, CiphertextBlob: wrapped.toString('base64'), EncryptionContext: this.#opts.encryptionContext ?? AwsKmsKeyEncryptionKey.ENCRYPTION_CONTEXT,
    });
    if (out.KeyId !== this.keyArn || !out.Plaintext) throw new DomainError('KMS_REFUSED', 'KMS answered for another key, or with nothing');
    const key = Buffer.from(out.Plaintext, 'base64');
    if (key.length !== 32) throw new DomainError('KMS_REFUSED', 'the unwrapped data key is not 32 bytes');
    return key;
  }

  async #call<T>(target: string, payload: unknown): Promise<T> {
    const fetchImpl = this.#opts.fetchImpl ?? fetch;
    const retries = this.#opts.retries ?? 3;
    const body = JSON.stringify(payload);
    let last = 'no attempt made';
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, (this.#opts.retryBaseDelayMs ?? 200) * 2 ** (attempt - 1)));
      try {
        const headers = signSigV4({
          method: 'POST', url: this.#endpoint, body, region: this.region, service: 'kms', credentials: await this.#opts.credentials(), amzDate: amzDateOf(new Date()),
          headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target },
        });
        delete headers.host; // set by fetch from the URL
        const res = await fetchImpl(this.#endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.#opts.timeoutMs ?? 5_000) });
        const text = await res.text();
        if (res.ok) return JSON.parse(text) as T;
        const type = String((JSON.parse(text || '{}') as { __type?: string }).__type ?? '').split('#').pop() ?? '';
        if (PERMANENT.has(type)) throw new DomainError('KMS_REFUSED', `KMS refused ${target}: ${type}`);
        last = `${res.status} ${type || 'error'}`;
      } catch (e) {
        if (e instanceof DomainError && e.code === 'KMS_REFUSED') throw e;
        last = (e as Error).message;
      }
    }
    throw new DomainError('KMS_UNAVAILABLE', `KMS did not answer ${target}: ${last}`);
  }

  toJSON(): { keyId: string; keyArn: string } {
    return { keyId: this.keyId, keyArn: this.keyArn };
  }
}
