import { isTronAddress } from '@inrp2p/kernel';
import {
  type ChainVerifier,
  ChromiumPdfRenderer,
  QuorumChainVerifier,
  type FieldProtector,
  type ObjectStore,
  type PdfRenderer,
  type TronProvider,
  TronHttpProvider,
  UNCONFIGURED_FIELD_PROTECTOR,
  defaultChromiumPath,
  fieldProtectionFromEnv,
  isObjectStoreConfigured,
  objectStoreFromEnv,
} from '@inrp2p/adapters';

/**
 * The audit-seal archive (TD-17): `INRP2P_AUDIT_SEAL_BUCKET` with Object Lock retention `INRP2P_AUDIT_SEAL_RETENTION_DAYS`
 * (required in production by the configuration contract). Undefined when no bucket is configured.
 */
export function auditArchiveFromEnv(env: NodeJS.ProcessEnv = process.env): { archive: ObjectStore; retainDays: number } | undefined {
  const archive = objectStoreFromEnv('AUDIT_SEALS', env);
  if (!isObjectStoreConfigured(archive)) return undefined;
  const days = (env.INRP2P_AUDIT_SEAL_RETENTION_DAYS ?? '').trim();
  if (!/^[1-9][0-9]{0,4}$/.test(days)) throw new Error('INRP2P_AUDIT_SEAL_RETENTION_DAYS must be a whole number of days when INRP2P_AUDIT_SEAL_BUCKET is set');
  return { archive, retainDays: Number.parseInt(days, 10) };
}

/**
 * Receipt storage for the worker (TD-12): the receipts bucket, a PDF printer if this worker has a browser
 * (`INRP2P_PDF_RENDERER=chromium`), and the Object Lock retention in days (`INRP2P_RECEIPT_RETENTION_DAYS`) — a
 * period only the owner can set; unset, objects are written once into a versioned bucket without a lock. Undefined when
 * no bucket is configured: receipts are then proved by hash and regenerated, as before.
 */
export function receiptStorageFromEnv(env: NodeJS.ProcessEnv = process.env): { store: ObjectStore; pdf: PdfRenderer | null; retainDays: number | null } | undefined {
  const store = objectStoreFromEnv('RECEIPTS', env);
  if (!isObjectStoreConfigured(store)) return undefined;
  let pdf: PdfRenderer | null = null;
  if ((env.INRP2P_PDF_RENDERER ?? '').toLowerCase() === 'chromium') {
    const executablePath = defaultChromiumPath(env.INRP2P_CHROMIUM_PATH);
    if (!executablePath) throw new Error('INRP2P_PDF_RENDERER=chromium but no Chromium binary was found; set INRP2P_CHROMIUM_PATH');
    pdf = new ChromiumPdfRenderer({ executablePath });
  }
  const days = (env.INRP2P_RECEIPT_RETENTION_DAYS ?? '').trim();
  if (days && !/^[1-9][0-9]{0,4}$/.test(days)) throw new Error('INRP2P_RECEIPT_RETENTION_DAYS must be a whole number of days');
  return { store, pdf, retainDays: days ? Number.parseInt(days, 10) : null };
}

/**
 * Field protection for the worker (opening sealed acceptance codes for delivery), from the same environment and
 * with the same production rules as the web app (`fieldProtectionFromEnv`, TD-03): an AWS KMS key in production,
 * never a locally held one. Returns `null` when no keys are configured outside production, so the worker starts and
 * code deliveries fail loudly instead of silently disappearing.
 */
export function fieldProtectorFromEnv(env: NodeJS.ProcessEnv = process.env): FieldProtector | null {
  return fieldProtectionFromEnv(env)?.protector ?? null;
}

export interface ChainConfig {
  /** In priority order: the scanner reads through the first that answers and fails over to the next (A3). */
  readonly providers: readonly TronProvider[];
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
    const providers = secondary ? [primary, secondary] : [primary];
    config = { providers, chain: new QuorumChainVerifier({ providers, tokenContract: contract }) };
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
export const UNCONFIGURED_PROTECTOR: FieldProtector = UNCONFIGURED_FIELD_PROTECTOR;
