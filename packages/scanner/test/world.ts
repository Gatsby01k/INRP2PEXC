import { DualProviderChainVerifier } from '@inrp2p/adapters';
import { FAKE_USDT_CONTRACT, FakeTronChain, FakeTronProvider } from '@inrp2p/adapters/testing';
import type { ScannerPolicy } from '../src/index.ts';
import type { ScannerDeps } from '../src/index.ts';
import { type World, createWorld } from '../../settlement/test/world.ts';

export * from '../../settlement/test/world.ts';

export interface ChainWorld extends World {
  readonly tron: FakeTronChain;
  readonly primary: FakeTronProvider;
  readonly secondary: FakeTronProvider;
  /** Scanner + settlement dependencies backed by the two fake TRON nodes. */
  readonly scanDeps: ScannerDeps;
}

/**
 * A Phase 4 world whose chain is two fake TRON nodes reading one fake chain, wired through the real
 * `DualProviderChainVerifier`. Tests move the chain (mine, lag, orphan, disagree) and run the real jobs.
 */
export async function createChainWorld(label: string, opts: { scanner?: Partial<ScannerPolicy>; depositPoolSize?: number } = {}): Promise<ChainWorld> {
  const w = await createWorld(label, opts.depositPoolSize ? { depositPoolSize: opts.depositPoolSize } : {});
  const tron = new FakeTronChain({ tokenContract: FAKE_USDT_CONTRACT });
  const primary = new FakeTronProvider('fake-node-a', tron);
  const secondary = new FakeTronProvider('fake-node-b', tron);
  const chain = new DualProviderChainVerifier({ primary, secondary, tokenContract: FAKE_USDT_CONTRACT });
  return {
    ...w,
    tron,
    primary,
    secondary,
    scanDeps: { chain, provider: primary, ...(opts.scanner ? { scanner: opts.scanner } : {}) },
  };
}

/** The deposit address a SELL trade's client was told to send to. */
export async function depositAddressOf(w: World, tradeId: string): Promise<{ address: string; addressId: string; expectedMinor: bigint | null }> {
  const row = await w.app
    .selectFrom('deposit_assignment as a')
    .innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
    .select(['d.address', 'd.id as address_id', 'a.expected_amount_minor'])
    .where('a.trade_id', '=', tradeId)
    .executeTakeFirstOrThrow();
  return { address: row.address, addressId: row.address_id, expectedMinor: row.expected_amount_minor };
}

/** Legs of a trade, oldest first. */
export async function legsOf(w: World, tradeId: string) {
  return w.app.selectFrom('settlement_leg').select(['id', 'side', 'status', 'amount_minor']).where('trade_id', '=', tradeId).orderBy('seq').execute();
}

export async function stateOf(w: World, tradeId: string): Promise<string> {
  const t = await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', tradeId).executeTakeFirstOrThrow();
  return t.lifecycle_state;
}

export async function transferByHash(w: World, txHash: string, logIndex = 0) {
  return w.app
    .selectFrom('crypto_transfer')
    .select(['id', 'state', 'amount_minor', 'payee_type', 'payee_id', 'verified_by'])
    .where('tx_hash', '=', txHash.toLowerCase())
    .where('log_index', '=', logIndex)
    .executeTakeFirst();
}

/** The ledger lines of one journal, as `ACCOUNT_CODE DR/CR amount` strings. */
export async function entriesOf(w: World, postingKey: string): Promise<string[]> {
  const rows = await w.app
    .selectFrom('ledger_entry as e')
    .innerJoin('ledger_journal as j', 'j.id', 'e.journal_id')
    .innerJoin('ledger_account as a', 'a.id', 'e.account_id')
    .select(['a.code', 'e.direction', 'e.amount_minor'])
    .where('j.posting_key', '=', postingKey)
    .orderBy('a.code')
    .execute();
  return rows.map((r) => `${r.code} ${r.direction} ${r.amount_minor}`);
}

export async function openCases(w: World, subjectId: string): Promise<string[]> {
  const rows = await w.app.selectFrom('exception_case').select('type').where('subject_id', '=', subjectId).where('status', 'in', ['OPEN', 'IN_PROGRESS']).execute();
  return rows.map((r) => r.type).sort();
}
