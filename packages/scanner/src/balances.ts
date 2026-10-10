import { sql } from 'kysely';
import { DomainError, Money, normalizeTronAddress } from '@inrp2p/kernel';
import type { BalanceReading, BalanceSource, ChainVerifier } from '@inrp2p/adapters';
import type { Db, Executor } from '@inrp2p/db';
import { type OperatorActor, operatorCommand } from '@inrp2p/identity';
import { type BalanceObservationInput, recordBalanceObservation } from '@inrp2p/treasury';
import { systemStep } from './system.ts';

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
export async function readBalance(sources: readonly BalanceSource[], address: string, contract: string, timeoutMs = 15_000): Promise<BalanceObservationInput> {
  const answers = await Promise.all(sources.map(async (s) => {
    try {
      return { source: s, reading: await withTimeout(s.getSolidifiedBalance(address, contract), timeoutMs), error: null as string | null };
    } catch (e) {
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
    select substr(location, 6) from funding_source s
     where s.location like 'TRON:%' and inrp2p_trade_is_counterparty_funded(s.trade_id)
       and s.amount_minor > coalesce((select sum(f.amount_minor) from funding_allocation f
                                       where (f.source_leg_id = s.source_id or f.source_route_settlement_id = s.source_id) and f.status = 'CONSUMED'), 0)
    union
    select substr(location, 6) from funding_allocation where status = 'ACTIVE' and location like 'TRON:%'`.execute(db);
  return r.rows.map((x) => x.address).sort();
}

export interface ObservationReport {
  readonly observed: number;
  readonly usable: number;
  readonly unusable: readonly { address: string; quality: string; detail: string | null }[];
}

/**
 * `custody_observe` (worker cron) and the desk's refresh: reads each address and records the reading through the
 * command pipeline (audited). `actor` is the operator who asked for a refresh, or the system.
 */
export async function observeBalances(
  db: Db,
  deps: { sources: readonly BalanceSource[]; contract: string },
  opts: { addresses?: readonly string[]; actor?: { type: 'USER'; id: string; surface: 'OPERATOR'; sessionId?: string } } = {},
): Promise<ObservationReport> {
  const addresses = opts.addresses ?? (await addressesToObserve(db));
  let usable = 0;
  const unusable: { address: string; quality: string; detail: string | null }[] = [];
  for (const address of addresses) {
    const reading = await readBalance(deps.sources, address, deps.contract);
    await systemStep(db, 'custody.observe_balance', { address, quality: reading.quality }, (ctx) => recordBalanceObservation(ctx, reading), opts.actor ? { actor: opts.actor } : {});
    if (reading.quality === 'AGREED' || reading.quality === 'SINGLE_SOURCE') usable += 1;
    else unusable.push({ address, quality: reading.quality, detail: reading.detail ?? null });
  }
  return { observed: addresses.length, usable, unusable };
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
