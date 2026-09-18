import { DomainError, isTronAddress } from '@inrp2p/kernel';
import {
  type ChainVerifier,
  DualProviderChainVerifier,
  type FieldProtector,
  LocalKeyEncryptionKey,
  type TronProvider,
  TronHttpProvider,
  createFieldProtector,
} from '@inrp2p/adapters';

/**
 * Field protection for the worker (opening sealed acceptance codes for delivery). The only key implementation
 * available today is the locally held KEK — TD-03: a KMS-backed KeyEncryptionKey is required before any real
 * client data reaches staging or production. Returns `null` when no keys are configured, so the worker starts and
 * code deliveries fail loudly instead of silently disappearing.
 */
export function fieldProtectorFromEnv(env: NodeJS.ProcessEnv = process.env): FieldProtector | null {
  const keyId = env.INRP2P_KEK_ID;
  const kek = env.INRP2P_KEK_BASE64;
  const hmac = env.INRP2P_FIELD_HMAC_BASE64;
  if (!keyId || !kek || !hmac) return null;
  const hmacKey = Buffer.from(hmac, 'base64');
  if (hmacKey.length !== 32) throw new DomainError('INVALID_ARGUMENT', 'INRP2P_FIELD_HMAC_BASE64 must decode to 32 bytes');
  return createFieldProtector({ kek: LocalKeyEncryptionKey.fromBase64(keyId, kek), hmacKey });
}

export interface ChainConfig {
  readonly provider: TronProvider;
  readonly chain: ChainVerifier;
}

/**
 * Chain monitoring is always in one of four states, and the worker says which one out loud:
 *
 * - `DISABLED` — deliberately off (`INRP2P_TRON_MONITORING=disabled`, or no TRON settings at all). Development
 *   and tests run here. The jobs do nothing and that is healthy.
 * - `READY` — enabled, configured, two independent providers: everything up to the D-05 threshold works.
 * - `DEGRADED` — enabled and configured, but only one independent source. Small amounts still settle; anything
 *   at or above the threshold cannot confirm (D-05), so this is a warning, not a silent partial service.
 * - `UNCONFIGURED` — enabled but the settings are missing or invalid. Nothing scans and readiness fails; the
 *   worker never pretends to be monitoring a chain it cannot reach.
 */
export type ChainMonitoringState = 'DISABLED' | 'READY' | 'DEGRADED' | 'UNCONFIGURED';

export interface ChainMonitoring {
  readonly state: ChainMonitoringState;
  /** Plain sentences for the log line and the readiness output. Empty when READY. */
  readonly reasons: readonly string[];
  /** Present only for READY and DEGRADED. */
  readonly config?: ChainConfig;
}

const SETTINGS = [
  'INRP2P_TRON_PRIMARY_URL', 'INRP2P_TRON_PRIMARY_GROUP', 'INRP2P_TRON_PRIMARY_NAME', 'INRP2P_TRON_PRIMARY_KEY',
  'INRP2P_TRON_SECONDARY_URL', 'INRP2P_TRON_SECONDARY_GROUP', 'INRP2P_TRON_SECONDARY_NAME', 'INRP2P_TRON_SECONDARY_KEY',
  'INRP2P_USDT_CONTRACT',
] as const;

const url = (value: string | undefined, name: string, reasons: string[]): string | undefined => {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocol');
    return value;
  } catch {
    reasons.push(`${name} is not a usable http(s) URL`);
    return undefined;
  }
};

/**
 * Reads the chain-monitoring settings and says what state they put the worker in. It never throws: a bad
 * configuration is an `UNCONFIGURED` answer with reasons, which the worker reports, rather than an exception
 * that a caller might swallow into a silent no-op.
 *
 * Enabling is explicit, but so is forgetting: `INRP2P_TRON_MONITORING` may say `enabled` or `disabled`, and when
 * it says nothing the presence of any other TRON setting means enabled. A deployment that sets the endpoints and
 * forgets the flag is therefore UNCONFIGURED or READY — never quietly off.
 */
export function chainMonitoringFromEnv(env: NodeJS.ProcessEnv = process.env): ChainMonitoring {
  const flag = (env.INRP2P_TRON_MONITORING ?? '').trim().toLowerCase();
  const anySetting = SETTINGS.some((k) => (env[k] ?? '').trim() !== '');
  if (flag === 'disabled' || flag === 'off' || flag === 'false') {
    return { state: 'DISABLED', reasons: ['chain monitoring is switched off by INRP2P_TRON_MONITORING'] };
  }
  if (flag !== 'enabled' && flag !== 'on' && flag !== 'true' && !anySetting) {
    return { state: 'DISABLED', reasons: ['no TRON settings are present and chain monitoring was not requested'] };
  }

  const reasons: string[] = [];
  const contract = (env.INRP2P_USDT_CONTRACT ?? '').trim();
  if (!contract) reasons.push('INRP2P_USDT_CONTRACT is required');
  else if (!isTronAddress(contract)) reasons.push('INRP2P_USDT_CONTRACT is not a TRON address');

  const primaryUrl = url(env.INRP2P_TRON_PRIMARY_URL, 'INRP2P_TRON_PRIMARY_URL', reasons);
  if (!env.INRP2P_TRON_PRIMARY_URL) reasons.push('INRP2P_TRON_PRIMARY_URL is required');
  const primaryGroup = (env.INRP2P_TRON_PRIMARY_GROUP ?? '').trim();
  if (!primaryGroup) reasons.push('INRP2P_TRON_PRIMARY_GROUP is required: D-05 counts independent sources, which cannot be guessed from a URL');

  const secondaryUrlRaw = env.INRP2P_TRON_SECONDARY_URL;
  const secondaryUrl = url(secondaryUrlRaw, 'INRP2P_TRON_SECONDARY_URL', reasons);
  const secondaryGroup = (env.INRP2P_TRON_SECONDARY_GROUP ?? '').trim();
  if (secondaryUrlRaw && !secondaryGroup) reasons.push('INRP2P_TRON_SECONDARY_GROUP is required when a second provider is configured');

  if (reasons.length || !primaryUrl || !primaryGroup || !contract) {
    return { state: 'UNCONFIGURED', reasons: reasons.length ? reasons : ['the TRON settings are incomplete'] };
  }

  let config: ChainConfig;
  try {
    const primary = new TronHttpProvider({
      name: env.INRP2P_TRON_PRIMARY_NAME ?? 'tron-primary',
      independenceGroup: primaryGroup,
      baseUrl: primaryUrl,
      ...(env.INRP2P_TRON_PRIMARY_KEY ? { apiKey: env.INRP2P_TRON_PRIMARY_KEY } : {}),
    });
    const secondary = secondaryUrl
      ? new TronHttpProvider({
          name: env.INRP2P_TRON_SECONDARY_NAME ?? 'tron-secondary',
          independenceGroup: secondaryGroup,
          baseUrl: secondaryUrl,
          ...(env.INRP2P_TRON_SECONDARY_KEY ? { apiKey: env.INRP2P_TRON_SECONDARY_KEY } : {}),
        })
      : undefined;
    config = { provider: primary, chain: new DualProviderChainVerifier({ primary, ...(secondary ? { secondary } : {}), tokenContract: contract }) };
  } catch (e) {
    return { state: 'UNCONFIGURED', reasons: [(e as Error).message] };
  }

  const groups = config.chain.independenceGroups;
  if (groups.length < 2) {
    return {
      state: 'DEGRADED',
      reasons: [
        groups.length === 1 && config.chain.providers.length > 1
          ? `both providers declare the independence group "${groups[0]}", so they count as one source: transfers at or above the D-05 threshold cannot confirm`
          : 'only one independent provider is configured: transfers at or above the D-05 threshold cannot confirm (D-05)',
      ],
      config,
    };
  }
  return { state: 'READY', reasons: [], config };
}

/** One line for the worker log and for a readiness probe. */
export function describeChainMonitoring(monitoring: ChainMonitoring): string {
  const detail = monitoring.reasons.length ? ` — ${monitoring.reasons.join('; ')}` : '';
  const providers = monitoring.config ? ` providers=[${monitoring.config.chain.providers.join(', ')}] groups=[${monitoring.config.chain.independenceGroups.join(', ')}]` : '';
  return `chain monitoring: ${monitoring.state}${providers}${detail}`;
}

/** Readiness: an enabled but unconfigured deployment is not ready, and must not be reported as healthy. */
export function chainMonitoringReady(monitoring: ChainMonitoring): boolean {
  return monitoring.state !== 'UNCONFIGURED';
}

/** A protector that refuses every operation, so an unconfigured deployment cannot open or seal anything. */
export const UNCONFIGURED_PROTECTOR: FieldProtector = {
  async seal(): Promise<never> {
    throw new Error('FIELD_PROTECTION_NOT_CONFIGURED: INRP2P_KEK_ID, INRP2P_KEK_BASE64 and INRP2P_FIELD_HMAC_BASE64 are required');
  },
  async open(): Promise<never> {
    throw new Error('FIELD_PROTECTION_NOT_CONFIGURED: INRP2P_KEK_ID, INRP2P_KEK_BASE64 and INRP2P_FIELD_HMAC_BASE64 are required');
  },
  lookupHash(): never {
    throw new Error('FIELD_PROTECTION_NOT_CONFIGURED: INRP2P_KEK_ID, INRP2P_KEK_BASE64 and INRP2P_FIELD_HMAC_BASE64 are required');
  },
};
