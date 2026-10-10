import { createHash } from 'node:crypto';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { S3ObjectStore, amzDateOf, signSigV4 } from '@inrp2p/adapters';

/**
 * A local MinIO — a real S3 implementation — for the tests of what object storage must guarantee (TD-12, TD-17).
 * Gate-1 evidence only: the production bucket, its account and its retention are owner inputs.
 */

/**
 * The MinIO server, pinned by digest, and named only here (the tests, `scripts/image-checks.ts`, the PITR drill;
 * `deploy/reference/compose.yaml` is held to it by `versions:check`).
 *
 * MinIO's own images can no longer be pulled anonymously: Docker Hub's `minio/minio` no longer exists and quay.io
 * grants no pull without an account (checked 2026-10-09, when CI's pull of `minio/minio:RELEASE.2025-07-23T15-54-02Z`
 * failed). This is Chainguard's image of the same server, built from MinIO's source — package
 * `minio 0.20260922.192518-r2`, MinIO `RELEASE.2026-09-22T19-25-18Z`, for linux/amd64 and linux/arm64. The digest
 * means a run never moves to another build unseen; CI pulls it and prints the server's version before the tests.
 * It runs as an unprivileged user and its `/data` is writable by it.
 */
export const MINIO_IMAGE = 'cgr.dev/chainguard/minio@sha256:6476f81b9739912fa9f50ceae2bb049a30336527cccd24beccfbeb4145f8f696'; // secret-scan:allow — an image digest, not a key
const USER = 'inrp2ptest';
const PASSWORD = 'inrp2ptest-password-not-a-secret'; // secret-scan:allow — a throwaway container's root password
const credentials = async () => ({ accessKeyId: USER, secretAccessKey: PASSWORD });

export interface LocalS3 {
  readonly endpoint: string;
  /** A versioned bucket with Object Lock, created fresh. */
  bucket(name: string, opts?: { readonly objectLock?: boolean }): Promise<S3ObjectStore>;
  /** A signed raw request, for what the application deliberately cannot do (delete versions, overwrite). */
  raw(method: string, path: string, headers?: Record<string, string>, body?: Uint8Array): Promise<Response>;
  stop(): Promise<void>;
}

export async function startLocalS3(): Promise<LocalS3> {
  const container: StartedTestContainer = await new GenericContainer(MINIO_IMAGE)
    .withEnvironment({ MINIO_ROOT_USER: USER, MINIO_ROOT_PASSWORD: PASSWORD })
    .withCommand(['server', '/data'])
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000).forStatusCode(200))
    .start();
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
  const raw = async (method: string, path: string, headers: Record<string, string> = {}, body: Uint8Array = new Uint8Array(0)) => {
    const url = new URL(`${endpoint}${path}`);
    const signed = signSigV4({ method, url, body, region: 'us-east-1', service: 's3', credentials: await credentials(), amzDate: amzDateOf(new Date()), headers: { ...headers, 'x-amz-content-sha256': createHash('sha256').update(body).digest('hex') } });
    delete signed.host;
    return fetch(url, { method, headers: signed, ...(body.length ? { body: Buffer.from(body) } : {}) });
  };
  return {
    endpoint,
    raw,
    bucket: async (name, opts = {}) => {
      const res = await raw('PUT', `/${name}`, opts.objectLock === false ? {} : { 'x-amz-bucket-object-lock-enabled': 'true' });
      if (res.status !== 200) throw new Error(`could not create bucket ${name}: ${res.status}`);
      if (opts.objectLock === false) {
        const v = await raw('PUT', `/${name}?versioning`, { 'content-type': 'application/xml' }, Buffer.from('<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>'));
        if (v.status !== 200) throw new Error(`could not version bucket ${name}: ${v.status}`);
      }
      return new S3ObjectStore({ endpoint, region: 'us-east-1', bucket: name, credentials, retryBaseDelayMs: 1 });
    },
    stop: async () => {
      await container.stop();
    },
  };
}
