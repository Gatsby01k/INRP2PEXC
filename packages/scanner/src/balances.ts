import { sql } from 'kysely';
import { DomainError, Money, normalizeTronAddress } from '@inrp2p/kernel';
import type { BalanceReading, BalanceSource, ChainVerifier } from '@inrp2p/adapters';
import type { Db, Executor } from '@inrp2p/db';
import { type OperatorActor, operatorCommand } from '@inrp2p/identity';
import { type BalanceObservationInput, recordBalanceObservation } from '@inrp2p/treasury';
import { systemStep } from './system.ts';
import { ProviderTracker } from './providers.ts';

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });

/**
 * Reads one address from every source in parallel. Agreement is on the balance: sources at different solidified
 * blocks that report the same balance agree, and the reading is as of the lowest of those blocks (the most
 * conservative point for deciding which outflows it already reflects). Different balances are DISAGREED — the
 * reading is recorded and refused, never averaged or majority-voted.
 */
export async function readBalance(sources: readonly BalanceSource[], address: string, contract: string, timeoutMs = 15_000, tracker?: ProviderTracker): Promise<BalanceObservationInput> {
  const answers = await Promise.all(sources.map(async (s) => {
    try {
      const reading = await withTimeout(s.getSolidifiedBalance(address, contract), timeoutMs);
      tracker?.ok(s);
      return { source: s, reading, error: null as string | null };
    } catch (e) {
      tracker?.failed(s, e);
      return { source: s, reading: null, error: (e as Error).message };
    }
  }));
  const ok = answers.filter((a): a is typeof a & { reading: BalanceReading } => a.reading !== null);
  const failed = answers.filter((a) => a.reading === null).map((a) => `${a.source.name}: ${a.error}`);
  const base = { address, tokenContract: contract, providers: ok.map((a) => a.source.name) };
  if (ok.length === 0) {
    return { ...base, quality: 'ERROR', balanceMinor: null, solidifiedBlock: null, trxSun: null, independentSources: 0, detail: failed.join('; ') || 'no source configured' };
  }
  const balances = new Set(ok.map((a) => a.reading.balanceMinor));
  const groups = new Set(ok.map((a) => a.source.independenceGroup.toLowerCase()));
  if (balances.size > 1) {
    return {
      ...base, quality: 'DISAGREED', balanceMinor: null, solidifiedBlock: null, trxSun: null, independentSources: groups.size,
      detail: ok.map((a) => `${a.source.name}=${a.reading.balanceMinor}@${a.reading.solidifiedBlock}`).join('; '),
    };
  }
  const block = ok.reduce((m, a) => (a.reading.solidifiedBlock < m ? a.reading.solidifiedBlock : m), ok[0]!.reading.solidifiedBlock);
  const trx = ok.map((a) => a.reading.trxSun).find((t) => t !== null) ?? null;
  return {
    ...base,
    quality: groups.size >= 2 ? 'AGREED' : 'SINGLE_SOURCE',
    balanceMinor: ok[0]!.reading.balanceMinor,
    solidifiedBlock: block,
    trxSun: trx,
    independentSources: groups.size >= 2 ? groups.size : 1,
    detail: failed.length ? `unavailable: ${failed.join('; ')}` : null,
  };
}

/**
 * The addresses whose balance decides something: every ACTIVE treasury wallet, and every deposit address that
 * holds a counterparty-funded trade's earmarked money or has an outflow earmarked at it.
 */
export async function addressesToObserve(db: Db): Promise<string[]> {
  const r = await sql<{ address: string }>`
    select address from treasury_wallet where network = 'TRON' and status = 'ACTIVE'
    union
    ${dealAddresses()}`.execute(db);
  return r.rows.map((x) => x.address).sort();
}

/** Deposit addresses holding a counterparty-funded trade's earmarked money, or with an outflow earmarked at them. */
const dealAddresses = () => sql`
    select substr(location, 6) from funding_source s
     where s.location like 'TRON:%' and inrp2p_trade_is_counterparty_funded(s.trade_id)
       and s.amount_minor > coalesce((select sum(f.amount_minor) from funding_allocation f
                                       where (f.source_leg_id = s.source_id or f.source_route_settlement_id = s.source_id) and f.status = 'CONSUMED'), 0)
    union
    select substr(location, 6) from funding_allocation where status = 'ACTIVE' and location like 'TRON:%'`;

/**
 * How old a quiet treasury wallet's reading may grow before the scheduled observation reads it again. Half the age past
 * which no outflow may rely on a reading (`DEFAULT_SETTLEMENT_POLICY.maxObservationAgeSeconds`, 300 s), so a quiet
 * wallet's latest reading is never stale: it is at most this plus one cron minute old.
 */
export const QUIET_WALLET_REFRESH_SECONDS = 150;

/**
 * The addresses the scheduled observation reads this run. Every deal address, every run: their money is in motion.
 * A treasury wallet every run while money is about to leave it (a live send from it, or an exchange-paid USDT leg
 * pending on it) or while its latest reading is missing or unusable; otherwise — quiet — once its latest reading is
 * `refreshSeconds` old. A quiet wallet read every minute only wrote the same reading again: one observation, one
 * audit event and one wallet update a minute per wallet, the bulk of those tables, and four provider calls per source.
 *
 * Nothing that decides on a balance waits for this schedule: the signer reads the paying address itself right before
 * it plans or signs (`onchain` autopay and sender), and the desk can refresh any address on request.
 */
export async function addressesDueForObservation(db: Db, opts: { refreshSeconds?: number } = {}): Promise<{ readonly due: string[]; readonly notDue: number }> {
  const refresh = opts.refreshSeconds ?? QUIET_WALLET_REFRESH_SECONDS;
  const r = await sql<{ address: string; due: boolean }>`
    select w.address,
           (o.observed_at is null
            or o.quality not in ('AGREED', 'SINGLE_SOURCE')
            or o.observed_at <= inrp2p_now() - make_interval(secs => ${refresh})
            or exists (select 1 from chain_send x where x.from_address = w.address and x.status not in ('CONFIRMED', 'CANCELLED'))
            or exists (select 1 from settlement_leg l where l.treasury_wallet_id = w.id and l.payer = 'EXCHANGE_ACCOUNT' and l.asset = 'USDT'
                                                       and l.status in ('PENDING', 'PROCESSING'))) as due
      from treasury_wallet w
      left join lateral (select o.quality, o.observed_at from custody_balance_observation o
                          where o.network = 'TRON' and o.address = w.address
                          order by o.observed_at desc, o.id desc limit 1) o on true
     where w.network = 'TRON' and w.status = 'ACTIVE'
    union all
    select d.address, true from (${dealAddresses()}) d(address)`.execute(db);
  const due = new Set(r.rows.filter((x) => x.due).map((x) => x.address));
  const quiet = new Set(r.rows.filter((x) => !due.has(x.address)).map((x) => x.address));
  return { due: [...due].sort(), notDue: quiet.size };
}

export interface ObservationReport {
  readonly observed: number;
  /** Quiet treasury wallets the scheduled run left until their reading is due (`addressesDueForObservation`). */
  readonly notDue: number;
  readonly usable: number;
  readonly unusable: readonly { address: string; quality: string; detail: string | null }[];
}

/**
 * `custody_observe` (worker cron) and the signer's reading before a send: reads each address and records the reading
 * through the command pipeline (audited). `actor` is the operator who asked for a refresh, or the system.
 *
 * Given no addresses — the scheduled run — it reads what is due (`addressesDueForObservation`) and records how every
 * source answered in `chain_provider_status`, so a second provider that stopped answering balance reads shows on the
 * desk and in health (`chain_providers_degraded`) instead of only as SINGLE_SOURCE readings nobody looks at.
 */
export async function observeBalances(
  db: Db,
  deps: { sources: readonly BalanceSource[]; contract: string },
  opts: { addresses?: readonly string[]; actor?: { type: 'USER'; id: string; surface: 'OPERATOR'; sessionId?: string }; refreshSeconds?: number } = {},
): Promise<ObservationReport> {
  const scheduled = opts.addresses === undefined;
  const plan = scheduled ? await addressesDueForObservation(db, opts.refreshSeconds === undefined ? {} : { refreshSeconds: opts.refreshSeconds }) : null;
  const addresses = opts.addresses ?? plan!.due;
  const notDue = plan?.notDue ?? 0;
  const tracker = scheduled && addresses.length > 0 ? new ProviderTracker(deps.sources) : null;
  let usable = 0;
  const unusable: { address: string; quality: string; detail: string | null }[] = [];
  try {
    for (const address of addresses) {
      const reading = await readBalance(deps.sources, address, deps.contract, undefined, tracker ?? undefined);
      await systemStep(db, 'custody.observe_balance', { address, quality: reading.quality }, (ctx) => recordBalanceObservation(ctx, reading), opts.actor ? { actor: opts.actor } : {});
      if (reading.quality === 'AGREED' || reading.quality === 'SINGLE_SOURCE') usable += 1;
      else unusable.push({ address, quality: reading.quality, detail: reading.detail ?? null });
    }
  } finally {
    await tracker?.flush(db);
  }
  return { observed: addresses.length, notDue, usable, unusable };
}

/** A deposit address this exchange issued, or one of its treasury wallets — nobody else's address is read on request. */
export async function isExchangeAddress(ex: Executor, address: string): Promise<boolean> {
  const a = normalizeTronAddress(address);
  const ours = (await ex.selectFrom('deposit_address').select('id').where('address', '=', a).executeTakeFirst())
    ?? (await ex.selectFrom('treasury_wallet').select('id').where('network', '=', 'TRON').where('address', '=', a).executeTakeFirst());
  return ours !== undefined;
}

export interface RefreshedBalance {
  readonly observationId: string;
  readonly address: string;
  readonly quality: BalanceObservationInput['quality'];
  readonly balance: string | null;
  readonly solidifiedBlock: string | null;
  readonly detail: string | null;
}

/**
 * `custody.refresh_balance` — `custody:refresh_balance` (B2). Records a reading the desk asked for, of one address
 * of this exchange, as the operator who asked. The reading is taken *before* the command runs (no network call
 * inside a transaction) by the server from the configured providers — never from the request: the payload names
 * only the address, and a reading of any other address is refused. An unusable reading is recorded too; it is
 * what the chain said, and it makes the address unusable until the next good one (the same rule as the worker's).
 */
export function recordRequestedBalance(actor: OperatorActor, reading: BalanceObservationInput) {
  return operatorCommand(actor, 'custody:refresh_balance', async (ctx, p: { address: string }): Promise<RefreshedBalance> => {
    const address = normalizeTronAddress(p.address);
    if (address !== normalizeTronAddress(reading.address)) throw new DomainError('INVALID_ARGUMENT', 'that reading is of another address');
    if (!(await isExchangeAddress(ctx.tx, address))) throw new DomainError('INVALID_ARGUMENT', `${address} is not an address of this exchange`);
    const recorded = await recordBalanceObservation(ctx, reading);
    return {
      observationId: recorded.observationId,
      address,
      quality: reading.quality,
      balance: reading.balanceMinor === null ? null : Money.ofMinor(reading.balanceMinor, 'USDT').toDecimalString(),
      solidifiedBlock: reading.solidifiedBlock === null ? null : reading.solidifiedBlock.toString(),
      detail: reading.detail ?? null,
    };
  });
}

/** Reads one address through the verifier's providers for the desk's refresh; refuses when none is configured. */
export async function readRequestedBalance(chain: ChainVerifier, address: string): Promise<BalanceObservationInput> {
  const sources = chain.balanceSources();
  if (sources.length === 0) throw new DomainError('CHAIN_MONITORING_UNCONFIGURED', 'no TRON provider is configured here, so no balance can be read');
  return readBalance(sources, normalizeTronAddress(address), chain.tokenContract);
}
