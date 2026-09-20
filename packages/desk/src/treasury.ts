import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';
import { istToday } from '@inrp2p/inr-accounts';
import { type StatementImportSummary, listStatementImports } from '@inrp2p/settlement';
import { getDepositPoolStatus } from '@inrp2p/treasury';

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
}

export interface InrView {
  readonly istDay: string;
  readonly accounts: readonly InrAccountView[];
  readonly totals: { readonly capacity: string; readonly used: string; readonly reserved: string; readonly available: string };
  /** The bank statements reconciled against these accounts, newest first (SECURITY §5 S7). */
  readonly statements: readonly StatementImportSummary[];
}

/** The INR screen: every settlement account and what today's capacity has left in it (FI-30, STATE_MACHINES §6). */
export async function inrView(ex: Executor): Promise<InrView> {
  const day = await istToday(ex);
  const rows = await sql<{
    id: string; entity_id: string; entity_name: string; label: string; bank_name: string; ifsc: string;
    account_last4: string; rails: string[]; direction: InrAccountView['direction']; status: InrAccountView['status'];
    version: number; default_daily_capacity_minor: bigint;
    capacity_minor: bigint | null; used_minor: bigint | null; reserved_minor: bigint | null;
  }>`
    select a.id, a.entity_id, e.legal_name as entity_name, a.label, a.bank_name, a.ifsc, a.account_last4,
           a.rails, a.direction, a.status, a.version, a.default_daily_capacity_minor,
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
    };
  });
  const available = capacity - used - reserved;
  const statements = await listStatementImports(ex, { limit: 10 });
  return {
    istDay: day,
    accounts,
    statements,
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
  readonly role: 'HOT' | 'COLD' | 'DEPOSIT_POOL';
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
  readonly source: 'SCANNER' | 'OPERATOR_SUBMITTED';
  readonly detectedAt: string;
  readonly confirmedAt: string | null;
  readonly verifiedBy: string | null;
  readonly tradeRef: string | null;
}

export interface UsdtView {
  readonly wallets: readonly TreasuryWalletView[];
  readonly pool: Awaited<ReturnType<typeof getDepositPoolStatus>>;
  readonly transfers: readonly TransferView[];
  /** Where the scanner has read to, so an operator can see it is alive and how far behind it is (Phase 5). */
  readonly scanner: { readonly scanner: string; readonly lastScannedBlock: string; readonly lastSolidifiedBlock: string; readonly lastRunAt: string | null } | null;
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
  }>`
    select c.id, c.tx_hash, c.log_index, c.amount_minor, c.state, c.from_address, c.to_address, c.source,
           c.detected_at, c.confirmed_at, c.verified_by,
           (select t.ref from transfer_allocation a
              join settlement_leg l on l.id = a.settlement_leg_id
              join trade t on t.id = l.trade_id
             where a.crypto_transfer_id = c.id and a.voided_at is null limit 1) as trade_ref
    from crypto_transfer c
    order by c.detected_at desc
    limit ${opts.transferLimit ?? 50}`.execute(ex);
  const cursor = await ex
    .selectFrom('chain_cursor')
    .select(['scanner', 'last_scanned_block', 'last_solidified_block', 'last_run_at'])
    .where('network', '=', 'TRON')
    .orderBy('scanner')
    .executeTakeFirst();

  return {
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
    })),
    scanner: cursor
      ? {
          scanner: cursor.scanner,
          lastScannedBlock: cursor.last_scanned_block.toString(),
          lastSolidifiedBlock: cursor.last_solidified_block.toString(),
          lastRunAt: cursor.last_run_at ? cursor.last_run_at.toISOString() : null,
        }
      : null,
  };
}
