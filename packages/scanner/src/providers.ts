import { sql } from 'kysely';
import type { ChainVerification, ChainVerifier, TronProvider } from '@inrp2p/adapters';
import type { Db, Executor } from '@inrp2p/db';

/** What the tracker needs of a provider: its name and independence group (a `TronProvider` or a `BalanceSource`). */
export type TrackedProvider = Pick<TronProvider, 'name' | 'independenceGroup'>;

export type ProviderHealth = 'OK' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';

interface Outcome {
  ok: number;
  failed: number;
  lastError: string | null;
  head: bigint | null;
  solidified: bigint | null;
}

/**
 * Collects what each provider did during one job run and writes it once at the end (`chain_provider_status`). A
 * failure is recorded with its reason and counts towards `consecutive_failures`; any success in the run resets it.
 * The record is for people and alarms — the domain never reads it to decide anything about money.
 */
export class ProviderTracker {
  readonly #providers: readonly TrackedProvider[];
  readonly #outcomes = new Map<string, Outcome>();

  constructor(providers: readonly TrackedProvider[]) {
    this.#providers = providers;
    for (const p of providers) this.#outcomes.set(p.name, { ok: 0, failed: 0, lastError: null, head: null, solidified: null });
  }

  ok(p: TrackedProvider, heads?: { head?: bigint; solidified?: bigint }): void {
    const o = this.#outcomes.get(p.name)!;
    o.ok += 1;
    if (heads?.head !== undefined) o.head = heads.head;
    if (heads?.solidified !== undefined) o.solidified = heads.solidified;
  }

  failed(p: TrackedProvider, error: unknown): void {
    const o = this.#outcomes.get(p.name)!;
    o.failed += 1;
    // Provider messages carry the endpoint path and status, never the API key (a header); trimmed for the column.
    o.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  }

  /** Providers with at least one failure and no success this run. */
  get down(): readonly string[] {
    return [...this.#outcomes.entries()].filter(([, o]) => o.failed > 0 && o.ok === 0).map(([n]) => n);
  }

  async flush(db: Db): Promise<void> {
    for (const p of this.#providers) {
      const o = this.#outcomes.get(p.name)!;
      if (o.ok === 0 && o.failed === 0) continue;
      const success = o.ok > 0;
      await sql`
        insert into chain_provider_status as s (network, provider, independence_group, last_ok_at, last_error_at, last_error, consecutive_failures, last_head, last_solidified, updated_at)
        values ('TRON', ${p.name}, ${p.independenceGroup},
                ${success ? sql`inrp2p_now()` : null}, ${o.failed > 0 ? sql`inrp2p_now()` : null}, ${o.lastError},
                ${success ? 0 : 1}, ${o.head}, ${o.solidified}, inrp2p_now())
        on conflict (network, provider) do update set
          independence_group = excluded.independence_group,
          last_ok_at = coalesce(excluded.last_ok_at, s.last_ok_at),
          last_error_at = coalesce(excluded.last_error_at, s.last_error_at),
          last_error = coalesce(excluded.last_error, s.last_error),
          consecutive_failures = case when ${success} then 0 else s.consecutive_failures + 1 end,
          last_head = coalesce(excluded.last_head, s.last_head),
          last_solidified = coalesce(excluded.last_solidified, s.last_solidified),
          updated_at = inrp2p_now()`.execute(db);
    }
  }
}

export interface ProviderStatusRow {
  readonly provider: string;
  readonly independenceGroup: string;
  readonly health: ProviderHealth;
  readonly lastOkAt: Date | null;
  readonly lastErrorAt: Date | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  readonly lastHead: bigint | null;
  readonly lastSolidified: bigint | null;
}

/**
 * Each provider's state as the desk shows it: `OK` when its last answer was good, `DEGRADED` after one to two
 * failed runs in a row, `DOWN` after three or more, `UNKNOWN` before it has ever been used.
 */
export async function providerStatus(ex: Executor): Promise<readonly ProviderStatusRow[]> {
  const rows = await ex.selectFrom('chain_provider_status').selectAll().where('network', '=', 'TRON').orderBy('provider').execute();
  return rows.map((r) => ({
    provider: r.provider,
    independenceGroup: r.independence_group,
    health: r.last_ok_at === null && r.last_error_at === null ? 'UNKNOWN' : r.consecutive_failures === 0 ? 'OK' : r.consecutive_failures < 3 ? 'DEGRADED' : 'DOWN',
    lastOkAt: r.last_ok_at,
    lastErrorAt: r.last_error_at,
    lastError: r.last_error,
    consecutiveFailures: r.consecutive_failures,
    lastHead: r.last_head,
    lastSolidified: r.last_solidified,
  }));
}

/**
 * Asks providers in priority order until one answers. Every failure is recorded; the answer says who gave it.
 * Used only for reads that decide nothing about money (heads for the scan window, detection).
 */
export async function firstAnswer<T>(
  providers: readonly TronProvider[],
  tracker: ProviderTracker,
  ask: (p: TronProvider) => Promise<T>,
): Promise<{ readonly value: T; readonly provider: TronProvider } | { readonly value: null; readonly provider: null; readonly errors: readonly string[] }> {
  const errors: string[] = [];
  for (const p of providers) {
    try {
      const value = await ask(p);
      return { value, provider: p };
    } catch (e) {
      tracker.failed(p, e);
      errors.push(`${p.name}: ${(e as Error).message}`);
    }
  }
  return { value: null, provider: null, errors };
}

/**
 * The verifier, with every provider's part in each verification recorded on `tracker`: one that answered (found, not
 * found, failed, contradicted) did its job; one listed as unavailable failed this run. The answers and what the domain
 * decides from them are the verifier's own, untouched — this only lets `chain_provider_status` see the second source
 * work, or not, where it matters most (D-05 quorum), instead of only when the scanner fails over to it.
 */
export function trackedVerifier(chain: ChainVerifier, providers: readonly TrackedProvider[], tracker: ProviderTracker): ChainVerifier {
  const byName = new Map(providers.map((p) => [p.name, p]));
  const record = (v: ChainVerification) => {
    const unavailable = new Set(v.status === 'FOUND' ? v.receipt.unavailable : v.unavailable);
    for (const name of chain.providers) {
      const p = byName.get(name);
      if (!p) continue;
      if (unavailable.has(name)) tracker.failed(p, new Error(v.status === 'UNAVAILABLE' ? v.reason : 'no answer to a transfer verification'));
      else tracker.ok(p);
    }
  };
  return {
    providers: chain.providers,
    independenceGroups: chain.independenceGroups,
    tokenContract: chain.tokenContract,
    verifyTransfer: async (network, txHash, logIndex) => {
      const v = await chain.verifyTransfer(network, txHash, logIndex);
      record(v);
      return v;
    },
    transactionTransfers: (network, txHash) => chain.transactionTransfers(network, txHash),
    balanceSources: () => chain.balanceSources(),
  };
}
