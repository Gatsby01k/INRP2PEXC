import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { productionConfigReport } from '../src/index.ts';

/**
 * E3: production starts only on a complete production configuration, names what is missing without printing a value,
 * and no test switch survives into it.
 */
const COMPLETE: NodeJS.ProcessEnv = {
  INRP2P_ENV: 'production',
  NODE_ENV: 'production',
  INRP2P_KEK_PROVIDER: 'aws-kms',
  INRP2P_KEK_ID: 'prod-kek-1',
  INRP2P_KMS_KEY_ARN: 'arn:aws:kms:ap-south-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab',
  INRP2P_FIELD_HMAC_BASE64: randomBytes(32).toString('base64'),
  RESEND_API_KEY: 're_live_key_from_the_secret_manager', // secret-scan:allow — a placeholder, not a key
  RESEND_FROM: 'INRP2P Exchange <no-reply@inrp2p.com>',
  INRP2P_TRON_PRIMARY_URL: 'https://api.trongrid.io',
  INRP2P_TRON_PRIMARY_GROUP: 'trongrid',
  INRP2P_TRON_SECONDARY_URL: 'https://tron.example-provider.com',
  INRP2P_TRON_SECONDARY_GROUP: 'second-provider',
  INRP2P_USDT_CONTRACT: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  DATABASE_URL: 'postgres://inrp2p_app_login@db/inrp2p',
  DESK_HOST: 'desk.inrp2p.com',
  APP_HOST: 'app.inrp2p.com',
  PUBLIC_HOST: 'inrp2p.com',
  OPERATOR_AUTH_SECRET: 'o'.repeat(48),
  CLIENT_AUTH_SECRET: 'c'.repeat(48),
  INRP2P_HEALTH_TOKEN: 'h'.repeat(48),
  INRP2P_CUSTODY_PROVIDER: 'custody-provider',
  WORKER_DATABASE_URL: 'postgres://inrp2p_worker_login@db/inrp2p',
  CLIENT_BASE_URL: 'https://app.inrp2p.com',
  INRP2P_AUDIT_SEAL_BUCKET: 'inrp2p-audit-seals',
  INRP2P_AUDIT_SEAL_RETENTION_DAYS: '3650',
  INRP2P_OBJECT_STORE_REGION: 'ap-south-1',
  INRP2P_RECEIPTS_BUCKET: 'inrp2p-receipts',
};

describe('the production configuration contract (E3)', () => {
  it('is empty outside production, whatever is set', () => {
    expect(productionConfigReport('web', { INRP2P_ENV: 'development', INRP2P_CLIENT_OTP_SINK_FILE: '/tmp/x' })).toEqual({ problems: [], warnings: [] });
  });

  it('accepts a complete configuration for both processes', () => {
    expect(productionConfigReport('web', COMPLETE)).toEqual({ problems: [], warnings: [] });
    expect(productionConfigReport('worker', COMPLETE)).toEqual({ problems: [], warnings: [] });
  });

  it('names what is missing or wrong, never a value', () => {
    const broken: NodeJS.ProcessEnv = {
      ...COMPLETE,
      RESEND_API_KEY: '',
      INRP2P_KEK_PROVIDER: 'local',
      INRP2P_KEK_BASE64: randomBytes(32).toString('base64'),
      CLIENT_AUTH_SECRET: COMPLETE.OPERATOR_AUTH_SECRET,
      APP_HOST: 'desk.inrp2p.com',
      INRP2P_HEALTH_TOKEN: 'short',
      INRP2P_CLIENT_OTP_SINK_FILE: '/tmp/codes',
      INRP2P_ALLOW_INSECURE_COOKIES: 'true',
      INRP2P_TRON_SECONDARY_GROUP: 'trongrid',
      INRP2P_OBJECT_STORE_ENDPOINT: 'http://minio:9000',
    };
    const web = productionConfigReport('web', broken).problems.join('\n');
    for (const fragment of [
      'RESEND_API_KEY is required', 'field protection', 'must differ', 'three different hosts', 'INRP2P_HEALTH_TOKEN must be at least 32',
      'INRP2P_CLIENT_OTP_SINK_FILE must not be set', 'INRP2P_ALLOW_INSECURE_COOKIES must not be set', 'SECONDARY_GROUP must differ', 'INRP2P_OBJECT_STORE_ENDPOINT must be https',
    ]) expect(web).toContain(fragment);
    // The values themselves never appear.
    expect(web).not.toContain(COMPLETE.OPERATOR_AUTH_SECRET!);
    expect(web).not.toContain(broken.INRP2P_KEK_BASE64!);

    const worker = productionConfigReport('worker', { ...COMPLETE, INRP2P_TRON_MONITORING: 'disabled', INRP2P_AUDIT_SEAL_BUCKET: '', CLIENT_BASE_URL: 'http://app.inrp2p.com', NODE_ENV: 'development' }).problems.join('\n');
    for (const fragment of ['INRP2P_TRON_MONITORING must not be disabled', 'INRP2P_AUDIT_SEAL_BUCKET is required', 'CLIENT_BASE_URL must be https', 'NODE_ENV must be production']) {
      expect(worker).toContain(fragment);
    }
  });

  it('takes AWS credentials from a role, never from a long-term key, and on Vercel through OIDC', () => {
    const LONG_TERM = 'AKIAIOSFODNN7EXAMPLE'; // secret-scan:allow — AWS's documented example key id
    const longTerm = productionConfigReport('worker', { ...COMPLETE, AWS_ACCESS_KEY_ID: LONG_TERM, AWS_SECRET_ACCESS_KEY: 's' });
    expect(longTerm.problems.join('\n')).toContain('AWS_ACCESS_KEY_ID is a long-term access key');
    expect(longTerm.problems.join('\n')).not.toContain(LONG_TERM);
    // Temporary credentials from a role or a sign-in session are a role's.
    expect(productionConfigReport('worker', { ...COMPLETE, AWS_ACCESS_KEY_ID: 'ASIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 't' }).problems).toEqual([]);

    expect(productionConfigReport('web', { ...COMPLETE, VERCEL: '1' }).problems.join('\n')).toContain('AWS_ROLE_ARN is required on Vercel');
    expect(productionConfigReport('web', { ...COMPLETE, VERCEL: '1', AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/inrp2p-vercel-web' }).problems).toEqual([]);
  });

  it('keeps the custody seed on the worker and only the account key on the web app (ADR 0017)', () => {
    const XPUB = 'xpub6D1AabNHCupeiLM65ZR9UStMhJ1vCpyV4XbZdyhMZBiJXALQtmn9p42VTQckoHVn8WNqS7dqnJokZHAHcHGoaQgmv8D45oNUKx6DZMNZBCd';
    const derived = { ...COMPLETE, INRP2P_CUSTODY_CAPABILITY: 'DERIVED' };
    expect(productionConfigReport('web', derived).problems.join('\n')).toContain('INRP2P_CUSTODY_XPUB is required');
    expect(productionConfigReport('web', { ...derived, INRP2P_CUSTODY_XPUB: XPUB }).problems).toEqual([]);
    expect(productionConfigReport('web', { ...derived, INRP2P_CUSTODY_XPUB: XPUB, INRP2P_CUSTODY_SEED_SEALED: 'v1.x' }).problems.join('\n')).toContain('must not be set on the web app');

    // A DERIVED worker without a seed runs, and says it signs nothing.
    expect(productionConfigReport('worker', derived).warnings.join('\n')).toContain('never signed');
    // With a seed it needs its own KMS key, and never a local one.
    const sealed = { ...derived, INRP2P_CUSTODY_SEED_SEALED: 'v1.custody-v1.x' };
    const missing = productionConfigReport('worker', sealed).problems.join('\n');
    expect(missing).toContain('INRP2P_CUSTODY_KEK_ID is required');
    expect(missing).toContain('INRP2P_CUSTODY_KMS_KEY_ARN is required');
    const complete = { ...sealed, INRP2P_CUSTODY_KEK_ID: 'custody-v1', INRP2P_CUSTODY_KMS_KEY_ARN: 'arn:aws:kms:ap-south-1:123456789012:key/abc' };
    expect(productionConfigReport('worker', complete).problems).toEqual([]);
    expect(productionConfigReport('worker', { ...complete, INRP2P_CUSTODY_KEK_PROVIDER: 'local' }).problems.join('\n')).toContain('must be aws-kms');
  });

  it('says out loud what runs at reduced service', () => {
    const one = productionConfigReport('worker', { ...COMPLETE, INRP2P_TRON_SECONDARY_URL: '', INRP2P_TRON_SECONDARY_GROUP: '', INRP2P_RECEIPTS_BUCKET: '' });
    expect(one.problems).toEqual([]);
    expect(one.warnings.join('\n')).toMatch(/one TRON provider only[\s\S]*receipts are not stored/);
  });
});
