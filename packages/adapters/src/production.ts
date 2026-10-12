import { isTronAddress } from '@inrp2p/kernel';
import { fieldProtectionFromEnv } from './field-config.ts';

/**
 * The production configuration contract (production task E3).
 *
 * `INRP2P_ENV=production` is the one switch, and it only ever takes things away: no test sink, no insecure cookie,
 * no locally held key, no unconfigured provider quietly standing in for a real one. Each process checks its own part
 * before it serves or works, and refuses to start with the list of what is wrong — names of settings only, never a
 * value. Nothing outside production is changed by this, and no other variable can switch it off.
 */
export type ProcessRole = 'web' | 'worker';

export interface ConfigReport {
  /** Settings that make the process refuse to start. */
  readonly problems: readonly string[];
  /** Settings that let it start, at reduced service, said out loud. */
  readonly warnings: readonly string[];
}

export const isProduction = (env: NodeJS.ProcessEnv = process.env): boolean => (env.INRP2P_ENV ?? '').trim().toLowerCase() === 'production';

const set = (env: NodeJS.ProcessEnv, name: string): boolean => (env[name] ?? '').trim() !== '';
const https = (value: string | undefined): boolean => {
  try {
    return new URL(value ?? '').protocol === 'https:';
  } catch {
    return false;
  }
};
const localHost = (host: string): boolean => /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?)/i.test(host.trim());

/** What `role` needs in production, checked against `env`. Outside production the report is empty. */
export function productionConfigReport(role: ProcessRole, env: NodeJS.ProcessEnv = process.env): ConfigReport {
  if (!isProduction(env)) return { problems: [], warnings: [] };
  const problems: string[] = [];
  const warnings: string[] = [];
  const need = (name: string, why: string) => {
    if (!set(env, name)) problems.push(`${name} is required (${why})`);
  };

  if (env.NODE_ENV !== 'production') problems.push('NODE_ENV must be production');
  // Test-only switches are refused outright, not ignored: their presence means the wrong configuration was deployed.
  for (const name of ['INRP2P_CLIENT_OTP_SINK_FILE', 'INRP2P_ALLOW_INSECURE_COOKIES', 'TEST_DATABASE_URL']) {
    if (set(env, name)) problems.push(`${name} must not be set in production`);
  }

  // Field protection: an AWS KMS key and the HMAC key (TD-03); `fieldProtectionFromEnv` refuses local and test keys.
  try {
    if (!fieldProtectionFromEnv(env)) problems.push('field protection is not configured (INRP2P_KEK_PROVIDER=aws-kms, INRP2P_KMS_KEY_ARN, INRP2P_FIELD_HMAC_BASE64)');
  } catch (e) {
    problems.push(`field protection: ${(e as Error).message}`);
  }
  // AWS credentials come from a role — the task role, or a web identity — never from a long-term access key in the
  // configuration (RUNBOOKS `field-encryption-keys`). Temporary keys (`ASIA…` with a session token) are a role's.
  if (/^AKIA/.test((env.AWS_ACCESS_KEY_ID ?? '').trim())) {
    problems.push('AWS_ACCESS_KEY_ID is a long-term access key: give the process a role (the task role, or AWS_ROLE_ARN with OIDC)');
  }
  // On Vercel there is no task or instance role: KMS is reached through Vercel's OIDC federation and a role to assume.
  if (set(env, 'VERCEL') && (env.INRP2P_KEK_PROVIDER ?? '').trim().toLowerCase() === 'aws-kms' && !set(env, 'AWS_ROLE_ARN') && !set(env, 'AWS_ACCESS_KEY_ID')) {
    problems.push('AWS_ROLE_ARN is required on Vercel (the role KMS is reached through, with OIDC federation turned on)');
  }

  // Email: sign-in codes (web), acceptance codes and notifications (worker) — TD-04.
  need('RESEND_API_KEY', 'email provider');
  need('RESEND_FROM', 'email sender on a verified domain');
  if (set(env, 'RESEND_BASE_URL') && !https(env.RESEND_BASE_URL)) problems.push('RESEND_BASE_URL must be https');

  // The chain: both processes verify USDT movements (FI-24); two independent providers for large amounts (D-05).
  need('INRP2P_TRON_PRIMARY_URL', 'TRON provider');
  need('INRP2P_TRON_PRIMARY_GROUP', 'TRON provider independence group');
  if (!isTronAddress((env.INRP2P_USDT_CONTRACT ?? '').trim())) problems.push('INRP2P_USDT_CONTRACT must be the USDT TRC-20 contract address');
  for (const name of ['INRP2P_TRON_PRIMARY_URL', 'INRP2P_TRON_SECONDARY_URL']) {
    if (set(env, name) && !https(env[name])) problems.push(`${name} must be https`);
  }
  if (!set(env, 'INRP2P_TRON_SECONDARY_URL') || !set(env, 'INRP2P_TRON_SECONDARY_GROUP')) {
    warnings.push('one TRON provider only: amounts at or above the D-05 threshold cannot confirm until a second independent provider is configured');
  } else if (env.INRP2P_TRON_SECONDARY_GROUP === env.INRP2P_TRON_PRIMARY_GROUP) {
    problems.push('INRP2P_TRON_SECONDARY_GROUP must differ from the primary group (D-05: independent providers)');
  }

  if (role === 'web') {
    need('DATABASE_URL', 'the application login');
    for (const name of ['DESK_HOST', 'APP_HOST', 'PUBLIC_HOST']) {
      need(name, 'surface host');
      if (set(env, name) && localHost(env[name]!)) problems.push(`${name} must be a public host name`);
    }
    const hosts = ['DESK_HOST', 'APP_HOST', 'PUBLIC_HOST'].map((n) => (env[n] ?? '').trim().toLowerCase());
    if (new Set(hosts).size !== 3) problems.push('DESK_HOST, APP_HOST and PUBLIC_HOST must be three different hosts');
    for (const name of ['OPERATOR_AUTH_SECRET', 'CLIENT_AUTH_SECRET', 'INRP2P_HEALTH_TOKEN']) {
      need(name, name === 'INRP2P_HEALTH_TOKEN' ? 'monitoring access to the full health status' : 'session signing');
      if (set(env, name) && env[name]!.trim().length < 32) problems.push(`${name} must be at least 32 characters`);
    }
    if (set(env, 'OPERATOR_AUTH_SECRET') && env.OPERATOR_AUTH_SECRET === env.CLIENT_AUTH_SECRET) problems.push('OPERATOR_AUTH_SECRET and CLIENT_AUTH_SECRET must differ');
    for (const name of ['OPERATOR_BASE_URL', 'CLIENT_BASE_URL', 'CLIENT_LINK_BASE']) {
      if (set(env, name) && !https(env[name])) problems.push(`${name} must be https`);
    }
    need('INRP2P_CUSTODY_PROVIDER', 'the custody provider SELL acceptance attributes deposits through (D-02)');
  } else {
    need('WORKER_DATABASE_URL', 'the worker login');
    need('CLIENT_BASE_URL', 'links in client emails');
    if (set(env, 'CLIENT_BASE_URL') && !https(env.CLIENT_BASE_URL)) problems.push('CLIENT_BASE_URL must be https');
    const flag = (env.INRP2P_TRON_MONITORING ?? '').trim().toLowerCase();
    if (flag === 'disabled' || flag === 'off' || flag === 'false') problems.push('INRP2P_TRON_MONITORING must not be disabled in production: deposits would never be seen');
    // TD-17: the audit seals leave the database for storage nobody can rewrite.
    need('INRP2P_AUDIT_SEAL_BUCKET', 'independent export of audit seals (TD-17)');
    need('INRP2P_AUDIT_SEAL_RETENTION_DAYS', 'Object Lock retention of exported seals');
    if (set(env, 'INRP2P_AUDIT_SEAL_RETENTION_DAYS') && !/^[1-9][0-9]{0,4}$/.test(env.INRP2P_AUDIT_SEAL_RETENTION_DAYS!.trim())) problems.push('INRP2P_AUDIT_SEAL_RETENTION_DAYS must be a whole number of days');
  }
  if ((set(env, 'INRP2P_RECEIPTS_BUCKET') || set(env, 'INRP2P_AUDIT_SEAL_BUCKET')) && set(env, 'INRP2P_OBJECT_STORE_ENDPOINT') && !https(env.INRP2P_OBJECT_STORE_ENDPOINT)) {
    problems.push('INRP2P_OBJECT_STORE_ENDPOINT must be https');
  }
  if (!set(env, 'INRP2P_RECEIPTS_BUCKET')) warnings.push('receipts are not stored: they are regenerated from their snapshot and checked by hash (TD-12)');
  return { problems, warnings };
}
