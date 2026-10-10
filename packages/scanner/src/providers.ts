import { sql } from 'kysely';
import type { TronProvider } from '@inrp2p/adapters';
import type { Db, Executor } from '@inrp2p/db';

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
  readonly #providers: readonly TronProvider[];
  readonly #outcomes = new Map<string, Outcome>();

  constructor(providers: readonly TronProvider[]) {
    this.#providers = providers;
    for (const p of providers) this.#outcomes.set(p.name, { ok: 0, failed: 0, lastError: null, head: null, solidified: null });
  }

  ok(p: TronProvider, heads?: { head?: bigint; solidified?: bigint }): void {
    const o = this.#outcomes.get(p.name)!;
    o.ok += 1;
    if (heads?.head !== undefined) o.head = heads.head;
    if (heads?.solidified !== undefined) o.solidified = heads.solidified;
  }

  failed(p: TronProvider, error: unknown): void {
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
