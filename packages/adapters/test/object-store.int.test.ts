import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { S3ObjectStore, UnconfiguredObjectStore, amzDateOf, isObjectStoreConfigured, objectStoreFromEnv, signSigV4 } from '../src/index.ts';
import { MINIO_IMAGE } from '../../../test/minio.ts';

/**
 * The object store against MinIO — a real S3 implementation, run locally — for what TD-12 and TD-17 rely on: a
 * write that never overwrites, bytes checked on the way in, Object Lock that nobody can lift, and a bucket that says
 * whether it is versioned and locked. Gate-1 evidence only: the production bucket and its account are owner inputs.
 */
const USER = 'inrp2ptest';
const PASSWORD = 'inrp2ptest-password-not-a-secret'; // secret-scan:allow — a throwaway container's root password
const credentials = async () => ({ accessKeyId: USER, secretAccessKey: PASSWORD });

let minio: StartedTestContainer;
let endpoint = '';

/** A signed raw request, for what the port deliberately cannot do (create buckets, delete versions). */
async function raw(method: string, path: string, headers: Record<string, string> = {}, body: Uint8Array = new Uint8Array(0)): Promise<Response> {
  const url = new URL(`${endpoint}${path}`);
  const signed = signSigV4({ method, url, body, region: 'us-east-1', service: 's3', credentials: await credentials(), amzDate: amzDateOf(new Date()), headers: { ...headers, 'x-amz-content-sha256': createHash('sha256').update(body).digest('hex') } });
  delete signed.host;
  return fetch(url, { method, headers: signed, ...(body.length ? { body: Buffer.from(body) } : {}) });
}

beforeAll(async () => {
  minio = await new GenericContainer(MINIO_IMAGE)
    .withEnvironment({ MINIO_ROOT_USER: USER, MINIO_ROOT_PASSWORD: PASSWORD })
    .withCommand(['server', '/data'])
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000).forStatusCode(200))
    .start();
  endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
  expect((await raw('PUT', '/locked', { 'x-amz-bucket-object-lock-enabled': 'true' })).status).toBe(200);
  expect((await raw('PUT', '/plain')).status).toBe(200);
}, 180_000);
afterAll(async () => minio?.stop());

const store = (bucket: string) => new S3ObjectStore({ endpoint, region: 'us-east-1', bucket, credentials, retryBaseDelayMs: 1 });

describe('object store (E2/E4)', () => {
  it('says whether a bucket is versioned and locked', async () => {
    expect(await store('locked').describeBucket()).toEqual({ versioning: 'Enabled', objectLock: true });
    expect(await store('plain').describeBucket()).toEqual({ versioning: 'Off', objectLock: false });
  });

  it('writes once: the same bytes again are the same object, other bytes under that key are refused', async () => {
    const s = store('locked');
    const body = Buffer.from('{"receipt":"TR-261005-0001"}');
    const first = await s.putOnce('receipts/test/v1/a.json', body, { contentType: 'application/json' });
    expect(first.created).toBe(true);
    expect(first.versionId).toBeTruthy();
    expect(await s.putOnce('receipts/test/v1/a.json', body, { contentType: 'application/json' })).toEqual({ created: false, versionId: first.versionId });
    await expect(s.putOnce('receipts/test/v1/a.json', Buffer.from('{"receipt":"tampered"}'), { contentType: 'application/json' })).rejects.toMatchObject({ code: 'OBJECT_STORE_CONFLICT' });
    expect((await s.get('receipts/test/v1/a.json'))!.body.equals(body)).toBe(true);
    expect(await s.get('receipts/test/v1/missing.json')).toBeNull();
    expect(await s.list('receipts/test/')).toEqual(['receipts/test/v1/a.json']);
  });

  it('checks the bytes on the way in: a body that does not match its checksum is rejected by the store', async () => {
    const body = randomBytes(64);
    const wrong = createHash('md5').update(Buffer.from('something else')).digest('base64');
    const res = await raw('PUT', '/locked/receipts/test/corrupt.bin', { 'content-md5': wrong }, body);
    expect(res.status).toBe(400);
    expect(await store('locked').get('receipts/test/corrupt.bin')).toBeNull();
  });

  it('under Object Lock in compliance mode nobody can delete or replace what was written', async () => {
    const s = store('locked');
    const body = Buffer.from('seal 0001: 3f…');
    const put = await s.putOnce('audit-seals/test/0001.json', body, { contentType: 'application/json', retainUntil: new Date(Date.now() + 24 * 3600_000) });
    // Not even the root credentials can remove the locked version.
    const del = await raw('DELETE', `/locked/audit-seals/test/0001.json?versionId=${encodeURIComponent(put.versionId!)}`);
    // AWS answers 403 AccessDenied, MinIO 400 "WORM protected": either way, refused.
    expect(del.status).toBeGreaterThanOrEqual(400);
    expect(await del.text()).toMatch(/WORM protected|AccessDenied/);
    const shorten = await raw('PUT', `/locked/audit-seals/test/0001.json?retention&versionId=${encodeURIComponent(put.versionId!)}`, { 'content-type': 'application/xml' },
      Buffer.from('<Retention><Mode>COMPLIANCE</Mode><RetainUntilDate>2020-01-01T00:00:00Z</RetainUntilDate></Retention>'));
    expect(shorten.status).toBeGreaterThanOrEqual(400);
    expect((await s.get('audit-seals/test/0001.json'))!.body.equals(body)).toBe(true);
  });

  it('comes from the environment, refuses plain http in production, and is loud when absent', () => {
    expect(isObjectStoreConfigured(objectStoreFromEnv('RECEIPTS', {}))).toBe(false);
    expect(objectStoreFromEnv('RECEIPTS', {})).toBeInstanceOf(UnconfiguredObjectStore);
    expect(objectStoreFromEnv('AUDIT_SEALS', { INRP2P_AUDIT_SEAL_BUCKET: 'inrp2p-audit', INRP2P_OBJECT_STORE_REGION: 'ap-south-1' }).bucket).toBe('inrp2p-audit');
    expect(() => objectStoreFromEnv('RECEIPTS', { INRP2P_RECEIPTS_BUCKET: 'inrp2p-receipts', INRP2P_OBJECT_STORE_REGION: 'us-east-1', INRP2P_OBJECT_STORE_ENDPOINT: 'http://minio:9000', INRP2P_ENV: 'production' }))
      .toThrow(/https/);
  });
});
