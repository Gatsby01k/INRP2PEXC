import { sql } from 'kysely';
import { DomainError, Money, normalizeTronAddress } from '@inrp2p/kernel';
import type { Executor, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';

/**
 * What the chain says an exchange address holds (production task B2). One reading per address per run, append-only,
 * with the solidified block it is as of and how many independent sources agreed:
 *
 * - `AGREED` — two or more independence groups read the same balance;
 * - `SINGLE_SOURCE` — one group answered;
 * - `DISAGREED` / `ERROR` — the sources contradict each other, or nobody answered. Recorded, never usable.
 *
 * A treasury wallet's `observed_balance_minor` / `observed_at` follow its latest usable reading — the database
 * accepts no other value there (IX089) — so the legacy reservation rule (FI-33) finally compares against something
 * that was observed.
 */
export type ObservationQuality = 'AGREED' | 'SINGLE_SOURCE' | 'DISAGREED' | 'ERROR';

export interface BalanceObservationInput {
  readonly address: string;
  readonly tokenContract: string;
  readonly quality: ObservationQuality;
  readonly balanceMinor: bigint | null;
  readonly solidifiedBlock: bigint | null;
  readonly trxSun: bigint | null;
  readonly providers: readonly string[];
  readonly independentSources: number;
  readonly detail?: string | null;
}

export const isUsableQuality = (q: ObservationQuality): boolean => q === 'AGREED' || q === 'SINGLE_SOURCE';

export async function recordBalanceObservation(ctx: TxContext, input: BalanceObservationInput): Promise<{ observationId: string; observedAt: Date }> {
  const address = normalizeTronAddress(input.address);
  const usable = isUsableQuality(input.quality);
  if (usable && (input.balanceMinor === null || input.solidifiedBlock === null)) throw new DomainError('INVALID_ARGUMENT', 'a usable observation has a balance and a block');
  const row = await ctx.tx
    .insertInto('custody_balance_observation')
    .values({
      network: 'TRON',
      address,
      token_contract: normalizeTronAddress(input.tokenContract),
      quality: input.quality,
      balance_minor: usable ? input.balanceMinor : null,
      solidified_block: usable ? input.solidifiedBlock : null,
      trx_sun: input.trxSun,
      providers: input.providers.join(',').slice(0, 300),
      independent_sources: input.independentSources,
      detail: input.detail ? input.detail.slice(0, 500) : null,
      observed_by: ctx.actor.id ?? `SYSTEM:${ctx.commandName}`,
    })
    .returning(['id', 'observed_at'])
    .executeTakeFirstOrThrow();
  const wallet = await ctx.tx.selectFrom('treasury_wallet').select(['id', 'observed_balance_minor', 'reserved_minor']).where('network', '=', 'TRON').where('address', '=', address).executeTakeFirst();
  if (wallet && usable) {
    // Copied from the row in SQL: the timestamp keeps its microseconds, which the guard (IX089) compares exactly.
    await sql`
      update treasury_wallet w
         set observed_balance_minor = o.balance_minor, observed_at = o.observed_at, updated_at = statement_timestamp()
        from custody_balance_observation o
       where o.id = ${row.id} and w.id = ${wallet.id}`.execute(ctx.tx);
  }
  await appendAudit(ctx, {
    action: 'custody.balance_observed',
    entityType: wallet ? 'treasury_wallet' : 'custody_balance_observation',
    entityId: wallet?.id ?? row.id,
    after: {
      address, quality: input.quality, providers: input.providers, independent_sources: input.independentSources,
      ...(usable ? { balance: Money.ofMinor(input.balanceMinor!, 'USDT'), solidified_block: input.solidifiedBlock!.toString() } : { detail: input.detail ?? null }),
      ...(wallet && usable && input.balanceMinor! < wallet.reserved_minor ? { below_reserved: Money.ofMinor(wallet.reserved_minor, 'USDT') } : {}),
    },
  });
  return { observationId: row.id, observedAt: row.observed_at };
}

export interface LatestObservation {
  readonly id: string;
  readonly quality: ObservationQuality;
  readonly balanceMinor: bigint | null;
  readonly solidifiedBlock: bigint | null;
  readonly trxSun: bigint | null;
  readonly independentSources: number;
  readonly providers: string;
  readonly observedAt: Date;
  /** Seconds since the reading, by the business clock. */
  readonly ageSeconds: number;
}

/** The latest reading of an address — usable or not: a failed reading after a good one makes the good one stale. */
export async function latestObservation(ex: Executor, address: string): Promise<LatestObservation | null> {
  const r = await sql<{ id: string; quality: ObservationQuality; balance_minor: bigint | null; solidified_block: bigint | null; trx_sun: bigint | null; independent_sources: number; providers: string; observed_at: Date; age: string }>`
    select id, quality, balance_minor, solidified_block, trx_sun, independent_sources, providers, observed_at,
           floor(extract(epoch from (inrp2p_now() - observed_at)))::bigint::text as age
      from custody_balance_observation
     where network = 'TRON' and address = ${normalizeTronAddress(address)}
     order by observed_at desc, id desc
     limit 1`.execute(ex);
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id, quality: row.quality, balanceMinor: row.balance_minor, solidifiedBlock: row.solidified_block, trxSun: row.trx_sun,
    independentSources: row.independent_sources, providers: row.providers, observedAt: row.observed_at, ageSeconds: Number.parseInt(row.age, 10),
  };
}
