import { sql } from 'kysely';
import { DomainError, type Money, isTronAddress, optionalText, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import { type Executor, type TxContext, assertLockOrder, isUniqueViolation } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import type { CustodyAdapter, CustodyNetwork, DepositAddressCapability } from '@inrp2p/adapters';
import { type OperatorActor, actorLabel, operatorCommand } from '@inrp2p/identity';

/** Default cooldown before a pool address can be reused (STATE_MACHINES §11, D-02). */
export const DEFAULT_DEPOSIT_COOLDOWN_SECONDS = 7 * 24 * 3600;
const NETWORKS = ['TRON'] as const;

export interface CustodyCapability {
  readonly network: CustodyNetwork;
  readonly capability: DepositAddressCapability;
  readonly provider: string | null;
  readonly verifiedAt: Date | null;
  readonly configId: string | null;
}

/**
 * Recorded D-02 capability for a network — the latest `custody_provider_config` row. With nothing recorded the
 * capability is UNSUPPORTED. This is what quote acceptance reads (enforced from Phase 3).
 */
export async function getDepositAddressCapability(ex: Executor, network: CustodyNetwork): Promise<CustodyCapability> {
  const row = await ex
    .selectFrom('custody_provider_config')
    .select(['id', 'provider', 'deposit_address_capability', 'verified_at'])
    .where('network', '=', requireOneOf(network, 'network', NETWORKS))
    .orderBy('verified_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!row) return { network, capability: 'UNSUPPORTED', provider: null, verifiedAt: null, configId: null };
  return { network, capability: row.deposit_address_capability, provider: row.provider, verifiedAt: row.verified_at, configId: row.id };
}

/** Guard for SELL acceptance (Phase 3): no unique deposit address capability, no SELL trades — no fallback attribution. */
export async function assertSellAcceptanceSupported(ex: Executor, network: CustodyNetwork): Promise<CustodyCapability> {
  const cap = await getDepositAddressCapability(ex, network);
  if (cap.capability === 'UNSUPPORTED') {
    throw new DomainError('CUSTODY_CAPABILITY_UNSUPPORTED', 'SELL acceptance is disabled: no confirmed unique deposit address capability (D-02)', { network });
  }
  return cap;
}

export interface RecordCapabilityPayload {
  readonly provider: string;
  readonly network: CustodyNetwork;
  readonly capability: DepositAddressCapability;
  /** Required unless UNSUPPORTED: how funds on deposit addresses are consolidated and what that needs (e.g. TRX for energy). */
  readonly consolidationNotes?: string | null;
  readonly notes?: string | null;
}

/** `custody.record_capability` — `custody:configure` (⧗). Append-only; the gate evidence of D-02. */
export function recordCustodyCapability(actor: OperatorActor) {
  return operatorCommand(actor, 'custody:configure', async (ctx, p: RecordCapabilityPayload) => {
    const network = requireOneOf(p.network, 'network', NETWORKS);
    const capability = requireOneOf(p.capability, 'capability', ['DERIVED', 'POOL', 'UNSUPPORTED'] as const);
    const provider = requireText(p.provider, 'provider', 41).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,40}$/.test(provider)) throw new DomainError('INVALID_ARGUMENT', 'provider must be a lowercase slug');
    const consolidationNotes = optionalText(p.consolidationNotes, 'consolidationNotes', 4000);
    if (capability !== 'UNSUPPORTED' && !consolidationNotes) throw new DomainError('INVALID_ARGUMENT', 'consolidation notes are required for DERIVED or POOL capability (D-02 gate)');
    await sql`select pg_advisory_xact_lock(hashtext(${`inrp2p.custody:${network}`}))`.execute(ctx.tx);
    const before = await getDepositAddressCapability(ctx.tx, network);
    const row = await ctx.tx
      .insertInto('custody_provider_config')
      .values({ provider, network, deposit_address_capability: capability, consolidation_notes: consolidationNotes, notes: optionalText(p.notes, 'notes', 4000), verified_by: actorLabel(ctx) })
      .returning(['id', 'verified_at'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, {
      action: 'custody.capability_changed', entityType: 'custody_provider_config', entityId: row.id,
      before: { provider: before.provider, capability: before.capability },
      after: { provider, network, capability, consolidation_notes: consolidationNotes },
    });
    return { configId: row.id };
  });
}

async function requireAdapterMatchesRecord(ex: Executor, adapter: CustodyAdapter, network: CustodyNetwork, expected: DepositAddressCapability): Promise<CustodyCapability> {
  const cap = await getDepositAddressCapability(ex, network);
  if (cap.capability === 'UNSUPPORTED') throw new DomainError('CUSTODY_CAPABILITY_UNSUPPORTED', 'no unique deposit address capability recorded (D-02)');
  if (cap.capability !== expected) throw new DomainError('CUSTODY_CAPABILITY_MISMATCH', `recorded capability is ${cap.capability}, operation needs ${expected}`);
  if (cap.provider !== adapter.provider) throw new DomainError('CUSTODY_CAPABILITY_MISMATCH', `recorded provider ${cap.provider} does not match adapter ${adapter.provider}`);
  const live = await adapter.capabilities(network);
  if (live.depositAddress !== cap.capability) throw new DomainError('CUSTODY_CAPABILITY_MISMATCH', `provider now reports ${live.depositAddress}, recorded ${cap.capability}`);
  return cap;
}

async function requireDepositPoolWallet(ctx: TxContext, network: CustodyNetwork, walletId?: string): Promise<string> {
  let q = ctx.tx.selectFrom('treasury_wallet').select(['id']).where('network', '=', network).where('role', '=', 'DEPOSIT_POOL').where('status', '=', 'ACTIVE');
  if (walletId) q = q.where('id', '=', requireUuid(walletId, 'treasuryWalletId'));
  const rows = await q.orderBy('created_at').limit(2).execute();
  if (rows.length === 0) throw new DomainError('WALLET_NOT_ACTIVE', 'no ACTIVE DEPOSIT_POOL treasury wallet for this network');
  if (!walletId && rows.length > 1) throw new DomainError('INVALID_ARGUMENT', 'several DEPOSIT_POOL wallets are active; specify treasuryWalletId');
  return rows[0]!.id;
}

/**
 * `custody.import_pool_addresses` — `custody:configure` (⧗). POOL mode only: imports provider-provisioned addresses as
 * AVAILABLE. Addresses already known (any status) are skipped, never reset.
 */
export function importPoolAddresses(actor: OperatorActor, adapter: CustodyAdapter) {
  return operatorCommand(actor, 'custody:configure', async (ctx, p: { network: CustodyNetwork; treasuryWalletId?: string }) => {
    const network = requireOneOf(p.network, 'network', NETWORKS);
    await requireAdapterMatchesRecord(ctx.tx, adapter, network, 'POOL');
    const walletId = await requireDepositPoolWallet(ctx, network, p.treasuryWalletId);
    const provided = await adapter.listDepositAddresses(network);
    let imported = 0;
    for (const a of provided) {
      if (!isTronAddress(a.address)) throw new DomainError('INVALID_ADDRESS', 'provider returned an invalid TRON address');
      const r = await ctx.tx
        .insertInto('deposit_address')
        .values({ treasury_wallet_id: walletId, network, address: a.address, source: 'POOL', provider: adapter.provider, custody_reference: a.custodyReference, status: 'AVAILABLE', created_by: actorLabel(ctx) })
        .onConflict((oc) => oc.doNothing())
        .returning('id')
        .executeTakeFirst();
      if (r) imported++;
    }
    await appendAudit(ctx, { action: 'deposit_address.imported', entityType: 'treasury_wallet', entityId: walletId, after: { network, provider: adapter.provider, offered: provided.length, imported } });
    return { imported, skipped: provided.length - imported };
  });
}

export interface AllocateDepositAddressInput {
  readonly network: CustodyNetwork;
  readonly tradeId: string;
  /** Human trade reference passed to DERIVED providers (e.g. IX-260916-1842). */
  readonly tradeRef: string;
  readonly expectedAmount: Money<'USDT'>;
  readonly treasuryWalletId?: string;
}

export interface DepositAddressAllocation {
  readonly depositAddressId: string;
  readonly assignmentId: string;
  readonly address: string;
  readonly source: 'DERIVED' | 'POOL';
}

/**
 * Allocates the unique deposit address of a SELL trade (D-02, FI-26), inside the acceptance transaction (Phase 3).
 * POOL: locks one AVAILABLE address with `FOR UPDATE SKIP LOCKED`. DERIVED: records the provider's new address as
 * ASSIGNED. Uniqueness is enforced by the database (unique address, one open assignment per address, one
 * assignment per trade) — never trusted from the provider. No fallback: failures abort the caller's transaction.
 */
export async function allocateDepositAddress(ctx: TxContext, adapter: CustodyAdapter, input: AllocateDepositAddressInput): Promise<DepositAddressAllocation> {
  const network = requireOneOf(input.network, 'network', NETWORKS);
  const tradeId = requireUuid(input.tradeId, 'tradeId');
  if (input.expectedAmount.currency !== 'USDT' || !input.expectedAmount.isPositive()) throw new DomainError('INVALID_AMOUNT', 'expected amount must be positive USDT');
  const cap = await getDepositAddressCapability(ctx.tx, network);
  if (cap.capability === 'UNSUPPORTED') throw new DomainError('CUSTODY_CAPABILITY_UNSUPPORTED', 'no unique deposit address capability recorded (D-02)');
  await requireAdapterMatchesRecord(ctx.tx, adapter, network, cap.capability);
  assertLockOrder(ctx.tx, 'deposit_address');

  const existing = await ctx.tx.selectFrom('deposit_assignment').select('id').where('trade_id', '=', tradeId).executeTakeFirst();
  if (existing) throw new DomainError('DEPOSIT_ASSIGNMENT_EXISTS', 'trade already has a deposit assignment');

  let address: { id: string; address: string };
  if (cap.capability === 'POOL') {
    const candidate = await sql<{ id: string; address: string }>`
      select id, address from deposit_address
      where network = ${network} and status = 'AVAILABLE' and provider = ${adapter.provider}
      order by created_at, id
      limit 1
      for update skip locked`.execute(ctx.tx);
    const row = candidate.rows[0];
    if (!row) throw new DomainError('DEPOSIT_ADDRESS_UNAVAILABLE', 'deposit address pool is empty');
    await ctx.tx.updateTable('deposit_address').set({ status: 'ASSIGNED', updated_at: sql<Date>`statement_timestamp()` }).where('id', '=', row.id).where('status', '=', 'AVAILABLE').execute();
    address = row;
  } else {
    const walletId = await requireDepositPoolWallet(ctx, network, input.treasuryWalletId);
    const provided = await adapter.allocateDepositAddress(network, requireText(input.tradeRef, 'tradeRef', 40));
    if (!isTronAddress(provided.address)) throw new DomainError('INVALID_ADDRESS', 'provider returned an invalid TRON address');
    try {
      address = await ctx.tx
        .insertInto('deposit_address')
        .values({ treasury_wallet_id: walletId, network, address: provided.address, source: 'DERIVED', provider: adapter.provider, custody_reference: provided.custodyReference, status: 'ASSIGNED', created_by: actorLabel(ctx) })
        .returning(['id', 'address'])
        .executeTakeFirstOrThrow();
    } catch (e) {
      if (isUniqueViolation(e)) throw new DomainError('DEPOSIT_ADDRESS_UNAVAILABLE', 'provider returned an address that was already issued; refusing to reuse it (FI-26)');
      throw e;
    }
  }

  const assignment = await ctx.tx
    .insertInto('deposit_assignment')
    .values({ deposit_address_id: address.id, trade_id: tradeId, expected_amount_minor: input.expectedAmount.minor, created_by: actorLabel(ctx) })
    .returning('id')
    .executeTakeFirstOrThrow();
  await appendAudit(ctx, { action: 'deposit_address.assigned', entityType: 'deposit_address', entityId: address.id, after: { trade_id: tradeId, assignment_id: assignment.id, source: cap.capability, provider: adapter.provider, expected: input.expectedAmount } });
  return { depositAddressId: address.id, assignmentId: assignment.id, address: address.address, source: cap.capability };
}

/**
 * Releases a trade's deposit assignment when the trade reaches a terminal state (T7, T9); the address enters
 * COOLDOWN. State-idempotent. Funds arriving later are handled as FUNDS_AFTER_TRADE_CLOSED (Phase 5).
 */
export async function releaseDepositAssignment(ctx: TxContext, input: { tradeId: string; reason: 'TRADE_COMPLETED' | 'TRADE_CANCELLED'; cooldownSeconds?: number }): Promise<{ released: boolean }> {
  const reason = requireOneOf(input.reason, 'reason', ['TRADE_COMPLETED', 'TRADE_CANCELLED'] as const);
  const cooldown = input.cooldownSeconds ?? DEFAULT_DEPOSIT_COOLDOWN_SECONDS;
  if (!Number.isInteger(cooldown) || cooldown < 0) throw new DomainError('INVALID_ARGUMENT', 'cooldown must be a non-negative integer of seconds');
  const a = await ctx.tx.selectFrom('deposit_assignment').select(['id', 'deposit_address_id', 'released_at']).where('trade_id', '=', requireUuid(input.tradeId, 'tradeId')).executeTakeFirst();
  if (!a) throw new DomainError('NOT_FOUND', 'deposit assignment not found');
  assertLockOrder(ctx.tx, 'deposit_address');
  await ctx.tx.selectFrom('deposit_address').select('id').where('id', '=', a.deposit_address_id).forUpdate().executeTakeFirstOrThrow();
  const current = await ctx.tx.selectFrom('deposit_assignment').select(['released_at']).where('id', '=', a.id).executeTakeFirstOrThrow();
  if (current.released_at) return { released: false };
  await ctx.tx.updateTable('deposit_assignment').set({ released_at: sql<Date>`statement_timestamp()`, release_reason: reason }).where('id', '=', a.id).execute();
  await ctx.tx
    .updateTable('deposit_address')
    .set({ status: 'COOLDOWN', cooldown_until: sql<Date>`statement_timestamp() + make_interval(secs => ${cooldown})`, updated_at: sql<Date>`statement_timestamp()` })
    .where('id', '=', a.deposit_address_id)
    .execute();
  await appendAudit(ctx, { action: 'deposit_address.released', entityType: 'deposit_address', entityId: a.deposit_address_id, after: { trade_id: input.tradeId, reason, cooldown_seconds: cooldown } });
  return { released: true };
}

/**
 * Job `deposit_address.cooldown_release`: POOL addresses whose cooldown elapsed return to AVAILABLE; DERIVED
 * addresses are RETIRED (never reused by default). Retry-safe; skips rows locked by concurrent work.
 */
export async function releaseCooledDownAddresses(ctx: TxContext, limit = 500): Promise<{ available: number; retired: number }> {
  assertLockOrder(ctx.tx, 'deposit_address');
  const due = await sql<{ id: string; source: 'DERIVED' | 'POOL' }>`
    select id, source from deposit_address
    where status = 'COOLDOWN' and cooldown_until <= statement_timestamp()
    order by cooldown_until, id
    limit ${limit}
    for update skip locked`.execute(ctx.tx);
  let available = 0;
  let retired = 0;
  for (const row of due.rows) {
    const next = row.source === 'POOL' ? 'AVAILABLE' : 'RETIRED';
    await ctx.tx.updateTable('deposit_address').set({ status: next, cooldown_until: null, updated_at: sql<Date>`statement_timestamp()` }).where('id', '=', row.id).execute();
    await appendAudit(ctx, { action: next === 'AVAILABLE' ? 'deposit_address.cooldown_elapsed' : 'deposit_address.retired', entityType: 'deposit_address', entityId: row.id, after: { status: next, by: 'cooldown' } });
    if (next === 'AVAILABLE') available++;
    else retired++;
  }
  return { available, retired };
}

/** `custody.retire_deposit_address` — `custody:configure` (⧗). Only AVAILABLE or COOLDOWN addresses; assigned ones must be released first. */
export function retireDepositAddress(actor: OperatorActor) {
  return operatorCommand(actor, 'custody:configure', async (ctx, p: { depositAddressId: string; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    assertLockOrder(ctx.tx, 'deposit_address');
    const before = await ctx.tx.selectFrom('deposit_address').select(['id', 'status']).where('id', '=', requireUuid(p.depositAddressId, 'depositAddressId')).forUpdate().executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', 'deposit address not found');
    if (before.status === 'RETIRED') return { changed: false };
    if (before.status === 'ASSIGNED') throw new DomainError('INVALID_TRANSITION', 'an assigned deposit address cannot be retired');
    await ctx.tx.updateTable('deposit_address').set({ status: 'RETIRED', cooldown_until: null, updated_at: sql<Date>`statement_timestamp()` }).where('id', '=', before.id).execute();
    await appendAudit(ctx, { action: 'deposit_address.retired', entityType: 'deposit_address', entityId: before.id, before: { status: before.status }, after: { status: 'RETIRED', reason } });
    return { changed: true };
  });
}

export interface DepositPoolStatus {
  readonly network: CustodyNetwork;
  readonly capability: DepositAddressCapability;
  readonly provider: string | null;
  readonly available: number;
  readonly assigned: number;
  readonly cooldown: number;
  readonly retired: number;
}

/** Read model for the USDT screen's DepositPoolStatus component. */
export async function getDepositPoolStatus(ex: Executor, network: CustodyNetwork): Promise<DepositPoolStatus> {
  const cap = await getDepositAddressCapability(ex, network);
  const rows = await ex.selectFrom('deposit_address').select(['status', sql<string>`count(*)::text`.as('n')]).where('network', '=', network).groupBy('status').execute();
  const count = (s: string) => parseInt(rows.find((r) => r.status === s)?.n ?? '0', 10);
  return { network, capability: cap.capability, provider: cap.provider, available: count('AVAILABLE'), assigned: count('ASSIGNED'), cooldown: count('COOLDOWN'), retired: count('RETIRED') };
}
