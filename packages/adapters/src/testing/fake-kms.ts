import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * An in-memory AWS KMS for tests and rehearsals: one master key per key ARN (created on first use), and, like the real
 * one, every ciphertext names its key and is bound to its encryption context — `Decrypt` under another key or another
 * context is refused. It answers the JSON protocol `AwsKmsKeyEncryptionKey` speaks, as a `fetch` implementation.
 */
export interface FakeKmsOptions {
  /** Fail this many calls first, with `failWith` (default: 500 KMSInternalException). */
  readonly failFirst?: number;
  readonly failWith?: { readonly status: number; readonly type: string };
  /** Answer every call with AccessDeniedException. */
  readonly deny?: boolean;
  /** Only these ARNs exist; any other is NotFoundException. Default: any ARN exists. */
  readonly arns?: readonly string[];
}

export interface FakeKmsCall {
  readonly target: string;
  readonly signed: boolean;
  readonly body: Record<string, unknown>;
}

export function fakeKms(opts: FakeKmsOptions = {}): { readonly fetchImpl: typeof fetch; readonly calls: FakeKmsCall[] } {
  const masters = new Map<string, Buffer>((opts.arns ?? []).map((arn) => [arn, randomBytes(32)]));
  const master = (arn: string): Buffer | undefined => {
    if (!masters.has(arn) && !opts.arns) masters.set(arn, randomBytes(32));
    return masters.get(arn);
  };
  const calls: FakeKmsCall[] = [];
  let failures = opts.failFirst ?? 0;
  const ctxHash = (ctx: unknown) => createHash('sha256').update(JSON.stringify(ctx)).digest();
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const target = headers.get('x-amz-target') ?? '';
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ target, signed: (headers.get('authorization') ?? '').startsWith('AWS4-HMAC-SHA256 Credential='), body });
    const reply = (status: number, json: unknown) => new Response(JSON.stringify(json), { status });
    if (failures > 0) {
      failures--;
      return reply(opts.failWith?.status ?? 500, { __type: opts.failWith?.type ?? 'KMSInternalException' });
    }
    if (opts.deny) return reply(400, { __type: 'com.amazonaws.kms#AccessDeniedException' });
    const key = master(String(body.KeyId));
    if (!key) return reply(400, { __type: 'NotFoundException' });
    if (target === 'TrentService.Encrypt') {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(ctxHash(body.EncryptionContext));
      const ct = Buffer.concat([c.update(Buffer.from(String(body.Plaintext), 'base64')), c.final()]);
      const blob = Buffer.concat([Buffer.from(String(body.KeyId).padEnd(100)), iv, c.getAuthTag(), ct]);
      return reply(200, { CiphertextBlob: blob.toString('base64'), KeyId: body.KeyId });
    }
    const blob = Buffer.from(String(body.CiphertextBlob), 'base64');
    if (blob.subarray(0, 100).toString().trim() !== body.KeyId) return reply(400, { __type: 'IncorrectKeyException' });
    try {
      const d = createDecipheriv('aes-256-gcm', key, blob.subarray(100, 112));
      d.setAAD(ctxHash(body.EncryptionContext));
      d.setAuthTag(blob.subarray(112, 128));
      const pt = Buffer.concat([d.update(blob.subarray(128)), d.final()]);
      return reply(200, { Plaintext: pt.toString('base64'), KeyId: body.KeyId });
    } catch {
      return reply(400, { __type: 'InvalidCiphertextException' });
    }
  }) as typeof fetch;
  return { fetchImpl, calls };
}
