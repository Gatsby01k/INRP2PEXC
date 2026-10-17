import { sql } from 'kysely';
import { Money, isTronAddress } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';
import { istToday } from '@inrp2p/inr-accounts';
import { DEFAULT_SETTLEMENT_POLICY, type StatementImportSummary, listStatementImports, physicalAvailability } from '@inrp2p/settlement';
import { getDepositPoolStatus } from '@inrp2p/treasury';
import { providerStatus } from '@inrp2p/scanner';

export interface InrAccountView {
  readonly accountId: string;
  readonly entityId: string;
  readonly entityName: string;
  readonly label: string;
  readonly bankName: string;
  readonly ifsc: string;
  readonly last4: string;
  readonly rails: readonly string[];
  readonly direction: 'PAYOUT' | 'COLLECTION' | 'BOTH';
  readonly status: 'ACTIVE' | 'PAUSED' | 'UNAVAILABLE';
  readonly version: number;
  readonly capacityToday: string;
  readonly usedToday: string;
  readonly reservedToday: string;
  readonly availableToday: string;
  /** True when no `inr_account_day` row exists yet: today runs on the account's default capacity. */
  readonly dayOpened: boolean;
  readonly defaultDailyCapacity: string;
  /** ADR 0018: what a paying client sees — the payee name and the account's UPI ID, when it collects. */
  readonly upiVpa: string | null;
  readonly beneficiaryName: string | null;
}

export interface InrView {
  readonly istDay: string;
  readonly accounts: readonly InrAccountView[];
  readonly totals: { readonly capacity: string; readonly used: string; readonly reserved: string; readonly available: string };
  /** The bank statements reconciled against these accounts, newest first (SECURITY §5 S7). */
  readonly statements: readonly StatementImportSummary[];
  /** The legal entities accounts belong to: a new account is opened under one of them. */
  readonly entities: readonly { readonly entityId: string; readonly legalName: string; readonly shortName: string }[];
}

/** The INR screen: every settlement account and what today's capacity has left in it (FI-30, STATE_MACHINES §6). */
export async function inrView(ex: Executor): Promise<InrView> {
  const day = await istToday(ex);
  const rows = await sql<{
    id: string; entity_id: string; entity_name: string; label: string; bank_name: string; ifsc: string;
    account_last4: string; rails: string[]; direction: InrAccountView['direction']; status: InrAccountView['status'];
    version: number; default_daily_capacity_minor: bigint;
    capacity_minor: bigint | null; used_minor: bigint | null; reserved_minor: bigint | null; upi_vpa: string | null; beneficiary_name: string | null;
  }>`
    select a.id, a.entity_id, e.legal_name as entity_name, a.label, a.bank_name, a.ifsc, a.account_last4,
           a.rails, a.direction, a.status, a.version, a.default_daily_capacity_minor, a.upi_vpa, a.beneficiary_name,
           d.capacity_minor, d.used_minor, d.reserved_minor
    from inr_settlement_account a
    join settlement_entity e on e.id = a.entity_id
    left join inr_account_day d on d.account_id = a.id and d.day = ${day}::date
    order by e.legal_name, a.label`.execute(ex);

  let capacity = 0n;
  let used = 0n;
  let reserved = 0n;
  const accounts = rows.rows.map((r) => {
    const cap = r.capacity_minor ?? r.default_daily_capacity_minor;
    const u = r.used_minor ?? 0n;
    const res = r.reserved_minor ?? 0n;
    const avail = cap - u - res;
    if (r.status === 'ACTIVE') {
      capacity += cap;
      used += u;
      reserved += res;
    }
    return {
      accountId: r.id,
      entityId: r.entity_id,
      entityName: r.entity_name,
      label: r.label,
      bankName: r.bank_name,
      ifsc: r.ifsc,
      last4: r.account_last4,
      rails: r.rails,
      direction: r.direction,
      status: r.status,
      version: r.version,
      capacityToday: Money.ofMinor(cap, 'INR').toDecimalString(),
      usedToday: Money.ofMinor(u, 'INR').toDecimalString(),
      reservedToday: Money.ofMinor(res, 'INR').toDecimalString(),
      availableToday: Money.ofMinor(avail > 0n ? avail : 0n, 'INR').toDecimalString(),
      dayOpened: r.capacity_minor !== null,
      defaultDailyCapacity: Money.ofMinor(r.default_daily_capacity_minor, 'INR').toDecimalString(),
      upiVpa: r.upi_vpa,
      beneficiaryName: r.beneficiary_name,
    };
  });
  const available = capacity - used - reserved;
  const statements = await listStatementImports(ex, { limit: 10 });
  const entities = await ex.selectFrom('settlement_entity').select(['id', 'legal_name', 'short_name']).where('status', '=', 'ACTIVE').orderBy('legal_name').execute();
  return {
    istDay: day,
    accounts,
    statements,
    entities: entities.map((e) => ({ entityId: e.id, legalName: e.legal_name, shortName: e.short_name })),
    totals: {
      capacity: Money.ofMinor(capacity, 'INR').toDecimalString(),
      used: Money.ofMinor(used, 'INR').toDecimalString(),
      reserved: Money.ofMinor(reserved, 'INR').toDecimalString(),
      available: Money.ofMinor(available > 0n ? available : 0n, 'INR').toDecimalString(),
    },
  };
}

export interface TreasuryWalletView {
  readonly walletId: string;
  readonly label: string;
  readonly address: string;
  readonly role: 'HOT' | 'COLD' | 'DEPOSIT_POOL' | 'TRADER_RESERVE' | 'NETWORK_BUDGET';
  readonly status: 'ACTIVE' | 'PAUSED' | 'RETIRED';
  readonly observed: string;
  readonly reserved: string;
  readonly available: string;
  readonly observedAt: string | null;
}

export interface TransferView {
  readonly id: string;
  readonly txHash: string;
  readonly logIndex: number;
  readonly amount: string;
  readonly state: 'DETECTED' | 'CONFIRMED' | 'FAILED' | 'ORPHANED';
  readonly from: string;
  readonly to: string;
  readonly source: 'SCANNER' | 'OPERATOR_SUBMITTED' | 'CLIENT_SUBMITTED';
  readonly detectedAt: string;
  readonly confirmedAt: string | null;
  readonly verifiedBy: string | null;
  readonly tradeRef: string | null;
  /**
   * A trader's Security Reserve the transfer pays in (deposit) or out (withdrawal) — attributed, though to no trade.
   * At the shared reserve address (D-17) this is the only place the desk sees whose deposit it was.
   */
  readonly reserve: { readonly traderId: string; readonly traderRef: string; readonly direction: 'IN' | 'OUT' } | null;
}

/**
 * One exchange address, two questions (B2, ADR 0016 §2.6). *Physically*: what the latest reading of the chain shows
 * there, what is already leaving that the reading does not reflect, and so what could leave now. *Economically*:
 * how much of the trades' money (client and counterparty funds confirmed there, not yet paid on) the address holds,
 * and how much of that is already planned to go out. A payout needs both; neither stands in for the other.
 */
export interface CustodyPositionView {
  readonly address: string;
  readonly kind: 'TREASURY' | 'DEPOSIT';
  /** The wallet's label, or the trades whose money is at a deposit address. */
  readonly label: string;
  readonly reading: {
    readonly quality: 'AGREED' | 'SINGLE_SOURCE' | 'DISAGREED' | 'ERROR';
    readonly balance: string | null;
    readonly block: string | null;
    readonly providers: string;
    readonly observedAt: string;
    readonly ageSeconds: number;
  } | null;
  /** Why a payout from here would be refused on the reading alone; null when the reading is usable. */
  readonly unusable: string | null;
  /** Unknown when the stored address is invalid; never represented as a zero outflow. */
  readonly leaving: string | null;
  readonly freeOnChain: string;
  readonly tradesMoney: string;
  readonly plannedOut: string;
  /** Trades' money not planned to leave that the reading does not show here; null when none, or no usable reading. */
  readonly notSeenOnChain: string | null;
}

export interface UsdtView {
  readonly wallets: readonly TreasuryWalletView[];
  readonly custody: readonly CustodyPositionView[];
  /** A reading older than this stops USDT payouts from its address (B2). */
  readonly maxObservationAgeSeconds: number;
  readonly pool: Awaited<ReturnType<typeof getDepositPoolStatus>>;
  readonly transfers: readonly TransferView[];
  /** Where the scanner has read to, so an operator can see it is alive and how far behind it is (Phase 5). */
  readonly scanner: {
    readonly scanner: string;
    readonly lastScannedBlock: string;
    readonly lastSolidifiedBlock: string;
    readonly lastRunAt: string | null;
    /** Whether the last run proved its whole window read, and if not, why (A2). */
    readonly lastComplete: boolean | null;
    readonly lastIncompleteReason: string | null;
    readonly lastServedBy: string | null;
  } | null;
  /** Each configured chain provider's last answer (A3): degradation is shown, not inferred. */
  readonly providers: readonly ProviderView[];
  /** Historical backfills (TD-06), newest first. */
  readonly backfills: readonly BackfillView[];
}

export interface ProviderView {
  readonly provider: string;
  readonly independenceGroup: string;
  readonly health: 'OK' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';
  readonly lastOkAt: string | null;
  readonly lastErrorAt: string | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  readonly lastHead: string | null;
  readonly lastSolidified: string | null;
}

export interface BackfillView {
  readonly ref: string;
  readonly status: 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
  readonly fromBlock: string;
  readonly toBlock: string;
  readonly nextBlock: string;
  readonly addresses: number;
  readonly detected: number;
  readonly lastError: string | null;
  readonly requestedAt: string;
}

/** The USDT screen: treasury, the deposit pool (D-02) and what the chain has been doing lately. */
export async function usdtView(ex: Executor, opts: { transferLimit?: number } = {}): Promise<UsdtView> {
  const wallets = await ex
    .selectFrom('treasury_wallet')
    .select(['id', 'label', 'address', 'role', 'status', 'observed_balance_minor', 'reserved_minor', 'observed_at'])
    .where('status', '<>', 'RETIRED')
    .orderBy('role')
    .orderBy('label')
    .execute();
  const pool = await getDepositPoolStatus(ex, 'TRON');
  const transfers = await sql<{
    id: string; tx_hash: string; log_index: number; amount_minor: bigint; state: TransferView['state'];
    from_address: string; to_address: string; source: TransferView['source'];
    detected_at: Date; confirmed_at: Date | null; verified_by: string | null; trade_ref: string | null;
    reserve_trader_id: string | null; reserve_trader_ref: string | null; reserve_direction: 'IN' | 'OUT' | null;
  }>`
    select c.id, c.tx_hash, c.log_index, c.amount_minor, c.state, c.from_address, c.to_address, c.source,
           c.detected_at, c.confirmed_at, c.verified_by,
           tp.id as reserve_trader_id, tp.ref as reserve_trader_ref,
           case when c.payer_type = 'TRADER' then 'IN' when c.payee_type = 'TRADER' then 'OUT' end as reserve_direction,
           (select t.ref from transfer_allocation a
              join settlement_leg l on l.id = a.settlement_leg_id
              join trade t on t.id = l.trade_id
             where a.crypto_transfer_id = c.id and a.voided_at is null limit 1) as trade_ref
    from crypto_transfer c
    left join trader_profile tp on tp.id = case when c.payer_type = 'TRADER' then c.payer_id when c.payee_type = 'TRADER' then c.payee_id end
    order by c.detected_at desc
    limit ${opts.transferLimit ?? 50}`.execute(ex);
  const cursor = await ex
    .selectFrom('chain_cursor')
    .select(['scanner', 'last_scanned_block', 'last_solidified_block', 'last_run_at', 'last_complete', 'last_incomplete_reason', 'last_served_by'])
    .where('network', '=', 'TRON')
    .orderBy('scanner')
    .executeTakeFirst();
  const providers = await providerStatus(ex);
  const backfills = await ex
    .selectFrom('chain_backfill')
    .select(['ref', 'status', 'from_block', 'to_block', 'next_block', 'addresses', 'detected', 'last_error', 'requested_at'])
    .orderBy('requested_at', 'desc')
    .limit(10)
    .execute();

  const custody = await custodyPositions(ex);

  return {
    custody,
    maxObservationAgeSeconds: DEFAULT_SETTLEMENT_POLICY.maxObservationAgeSeconds,
    wallets: wallets.map((w) => {
      const available = w.observed_balance_minor - w.reserved_minor;
      return {
        walletId: w.id,
        label: w.label,
        address: w.address,
        role: w.role,
        status: w.status,
        observed: Money.ofMinor(w.observed_balance_minor, 'USDT').toDecimalString(),
        reserved: Money.ofMinor(w.reserved_minor, 'USDT').toDecimalString(),
        available: Money.ofMinor(available > 0n ? available : 0n, 'USDT').toDecimalString(),
        observedAt: w.observed_at ? w.observed_at.toISOString() : null,
      };
    }),
    pool,
    transfers: transfers.rows.map((t) => ({
      id: t.id,
      txHash: t.tx_hash,
      logIndex: t.log_index,
      amount: Money.ofMinor(t.amount_minor, 'USDT').toDecimalString(),
      state: t.state,
      from: t.from_address,
      to: t.to_address,
      source: t.source,
      detectedAt: t.detected_at.toISOString(),
      confirmedAt: t.confirmed_at ? t.confirmed_at.toISOString() : null,
      verifiedBy: t.verified_by,
      tradeRef: t.trade_ref,
      reserve: t.reserve_trader_id && t.reserve_trader_ref && t.reserve_direction ? { traderId: t.reserve_trader_id, traderRef: t.reserve_trader_ref, direction: t.reserve_direction } : null,
    })),
    scanner: cursor
      ? {
          scanner: cursor.scanner,
          lastScannedBlock: cursor.last_scanned_block.toString(),
          lastSolidifiedBlock: cursor.last_solidified_block.toString(),
          lastRunAt: cursor.last_run_at ? cursor.last_run_at.toISOString() : null,
          lastComplete: cursor.last_complete,
          lastIncompleteReason: cursor.last_incomplete_reason,
          lastServedBy: cursor.last_served_by,
        }
      : null,
    providers: providers.map((p) => ({
      provider: p.provider,
      independenceGroup: p.independenceGroup,
      health: p.health,
      lastOkAt: p.lastOkAt ? p.lastOkAt.toISOString() : null,
      lastErrorAt: p.lastErrorAt ? p.lastErrorAt.toISOString() : null,
      lastError: p.lastError,
      consecutiveFailures: p.consecutiveFailures,
      lastHead: p.lastHead === null ? null : p.lastHead.toString(),
      lastSolidified: p.lastSolidified === null ? null : p.lastSolidified.toString(),
    })),
    backfills: backfills.map((b) => ({
      ref: b.ref,
      status: b.status,
      fromBlock: b.from_block.toString(),
      toBlock: b.to_block.toString(),
      nextBlock: b.next_block.toString(),
      addresses: b.addresses.length,
      detected: b.detected,
      lastError: b.last_error,
      requestedAt: b.requested_at.toISOString(),
    })),
  };
}

/** Every exchange address whose USDT decides something: live treasury wallets, and deposit addresses holding trades' money. */
export async function custodyPositions(ex: Executor): Promise<CustodyPositionView[]> {
  const rows = await sql<{ address: string; kind: 'TREASURY' | 'DEPOSIT'; label: string; held: string; planned: string }>`
    with addresses as (
      select address, 'TREASURY'::text as kind, label from treasury_wallet where network = 'TRON' and status <> 'RETIRED'
      union all
      select d.address, 'DEPOSIT', coalesce((select string_agg(distinct t.ref, ', ' order by t.ref) from funding_source s join trade t on t.id = s.trade_id
                                               where s.location = 'TRON:' || d.address), 'deposit address')
        from deposit_address d
       where d.network = 'TRON' and inrp2p_address_earmarked(d.address) > 0
    )
    select a.address, a.kind, a.label,
           inrp2p_address_earmarked(a.address)::text as held,
           coalesce((select sum(f.amount_minor) from funding_allocation f where f.status = 'ACTIVE' and f.location = 'TRON:' || a.address), 0)::text as planned
      from addresses a
     order by a.kind desc, a.label, a.address`.execute(ex);
  const out: CustodyPositionView[] = [];
  for (const r of rows.rows) {
    const held = BigInt(r.held);
    const planned = BigInt(r.planned);
    // Old/imported rows may satisfy the SQL address shape but fail the checksum. Keep them visible for repair,
    // without passing them to chain-reading code or inventing a balance; payment validation remains unchanged.
    if (!isTronAddress(r.address)) {
      out.push({
        address: r.address,
        kind: r.kind,
        label: r.label,
        reading: null,
        unusable: 'invalid TRON address',
        leaving: null,
        freeOnChain: Money.zero('USDT').toDecimalString(),
        tradesMoney: Money.ofMinor(held, 'USDT').toDecimalString(),
        plannedOut: Money.ofMinor(planned, 'USDT').toDecimalString(),
        notSeenOnChain: null,
      });
      continue;
    }
    const p = await physicalAvailability(ex, {}, { address: r.address });
    const usable = p.observation !== null && (p.observation.quality === 'AGREED' || p.observation.quality === 'SINGLE_SOURCE');
    const missing = held - planned - p.availableMinor;
    out.push({
      address: r.address,
      kind: r.kind,
      label: r.label,
      reading: p.observation
        ? {
            quality: p.observation.quality,
            balance: p.observation.balanceMinor === null ? null : Money.ofMinor(p.observation.balanceMinor, 'USDT').toDecimalString(),
            block: p.observation.solidifiedBlock === null ? null : p.observation.solidifiedBlock.toString(),
            providers: p.observation.providers,
            observedAt: p.observation.observedAt.toISOString(),
            ageSeconds: p.observation.ageSeconds,
          }
        : null,
      unusable: p.unusable,
      leaving: Money.ofMinor(p.pendingOutMinor, 'USDT').toDecimalString(),
      freeOnChain: Money.ofMinor(p.availableMinor > 0n ? p.availableMinor : 0n, 'USDT').toDecimalString(),
      tradesMoney: Money.ofMinor(held, 'USDT').toDecimalString(),
      plannedOut: Money.ofMinor(planned, 'USDT').toDecimalString(),
      notSeenOnChain: usable && missing > 0n ? Money.ofMinor(missing, 'USDT').toDecimalString() : null,
    });
  }
  return out;
}
