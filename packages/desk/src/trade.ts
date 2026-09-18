import { sql } from 'kysely';
import { DomainError, Money, requireUuid } from '@inrp2p/kernel';
import type { DirectionValue, ExecutionMode, Executor } from '@inrp2p/db';
import { istToday } from '@inrp2p/inr-accounts';
import { effectiveObligations, legTotals } from '@inrp2p/trades';
import { obligationRemaining } from '@inrp2p/settlement';
import type { DeskAccess } from './access.ts';
import { microToDecimal } from './strip.ts';

export interface DeskLeg {
  readonly id: string;
  readonly ref: string;
  readonly side: 'CLIENT_TO_EXCHANGE' | 'EXCHANGE_TO_CLIENT';
  readonly asset: 'INR' | 'USDT';
  readonly amount: string;
  readonly status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  readonly payer: 'CLIENT' | 'EXCHANGE_ACCOUNT' | 'ROUTE';
  /** Where an exchange-paid INR leg draws from, for the panel's account line. */
  readonly accountLabel: string | null;
  readonly routeName: string | null;
  /** Bank reference or transaction hash, whichever this leg's evidence is. */
  readonly reference: string | null;
  readonly referenceKind: 'UTR' | 'TX' | null;
  readonly sentAt: string | null;
  readonly confirmedAt: string | null;
  readonly failureReason: string | null;
}

export interface DeskCase {
  readonly id: string;
  readonly ref: string;
  readonly type: string;
  readonly severity: 'BLOCKING' | 'WARNING';
  readonly status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'VOID';
  readonly details: Record<string, unknown>;
  readonly openedAt: string;
}

export interface PayoutAccountOption {
  readonly accountId: string;
  readonly label: string;
  readonly bankName: string;
  readonly last4: string;
  /** Today's capacity − used − reserved, in decimal INR (FI-30). */
  readonly availableToday: string;
  readonly capacityToday: string;
  readonly rails: readonly string[];
}

export interface TreasuryWalletOption {
  readonly walletId: string;
  readonly label: string;
  readonly address: string;
  readonly available: string;
}

export interface RouteSide {
  readonly obligationId: string;
  readonly ref: string;
  readonly routeId: string;
  readonly routeName: string;
  readonly executionMode: ExecutionMode;
  readonly status: string;
  readonly routeDelivers: { readonly amount: string; readonly currency: 'INR' | 'USDT' };
  readonly routeDeliversRemaining: { readonly amount: string; readonly currency: 'INR' | 'USDT' };
  readonly exchangeDelivers: { readonly amount: string; readonly currency: 'INR' | 'USDT' };
  readonly exchangeDeliversRemaining: { readonly amount: string; readonly currency: 'INR' | 'USDT' };
}

export interface DeskTrade {
  readonly tradeId: string;
  readonly ref: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly direction: DirectionValue;
  readonly lifecycle: string;
  readonly hold: boolean;
  readonly openedAt: string;
  readonly base: string;
  readonly quoteInr: string;
  /** Economics-gated: client rate, route rate, expected margin and the execution mode. */
  readonly clientRate?: string;
  readonly routeRate?: string;
  readonly expectedMargin?: string;
  readonly executionMode?: ExecutionMode;
  readonly payout: { readonly amount: string; readonly currency: 'INR' | 'USDT' };
  readonly paid: string;
  readonly committed: string;
  /** Obligation − committed: what a new leg may be created for (FI-20). */
  readonly unallocated: string;
  readonly receivable: { readonly amount: string; readonly currency: 'INR' | 'USDT' };
  readonly received: string;
  readonly legs: readonly DeskLeg[];
  readonly cases: readonly DeskCase[];
  /** SELL only: the address this client was told to send to, and the amount expected there (D-02). */
  readonly deposit?: { readonly address: string; readonly expected: string | null; readonly status: string };
  /** Route side, only with `route_positions:view`. */
  readonly route?: RouteSide;
  /** What a payout leg could be funded from right now. */
  readonly payoutOptions: {
    readonly asset: 'INR' | 'USDT';
    readonly accounts: readonly PayoutAccountOption[];
    readonly wallets: readonly TreasuryWalletOption[];
    /** True when this trade's route pays the client directly (D-14, FI-65). */
    readonly routeDirectAvailable: boolean;
    readonly routeName: string | null;
  };
}

/**
 * Everything the desk's context panels show about one trade. It is one read, not a fan-out of little queries
 * from the page, so what an operator sees is one consistent picture of the trade rather than several moments
 * of it stitched together.
 */
export async function deskTrade(ex: Executor, tradeId: string, access: DeskAccess): Promise<DeskTrade> {
  const id = requireUuid(tradeId, 'tradeId');
  const row = await ex
    .selectFrom('trade as t')
    .innerJoin('client as c', 'c.id', 't.client_id')
    .innerJoin('trade_economics as e', 'e.trade_id', 't.id')
    .select([
      't.id', 't.ref', 't.client_id', 'c.display_name as client_name', 't.direction', 't.lifecycle_state', 't.hold', 't.opened_at',
      'e.base_minor', 'e.quote_inr_minor', 'e.client_rate_micro', 'e.route_rate_micro', 'e.gross_margin_inr_minor',
      'e.route_id', 'e.route_execution_mode',
    ])
    .where('t.id', '=', id)
    .executeTakeFirst();
  if (!row) throw new DomainError('NOT_FOUND', 'trade not found');

  const { payout, receivable } = await effectiveObligations(ex, id);
  const totals = await legTotals(ex, id);
  const legs = await deskLegs(ex, id);
  const cases = await deskCases(ex, id);
  const payoutAsset = payout.currency;

  const base: DeskTrade = {
    tradeId: row.id,
    ref: row.ref,
    clientId: row.client_id,
    clientName: row.client_name,
    direction: row.direction,
    lifecycle: row.lifecycle_state,
    hold: row.hold,
    openedAt: row.opened_at.toISOString(),
    base: Money.ofMinor(row.base_minor, 'USDT').toDecimalString(),
    quoteInr: Money.ofMinor(row.quote_inr_minor, 'INR').toDecimalString(),
    payout: payout.toJSON(),
    paid: Money.ofMinor(totals.paid, payoutAsset).toDecimalString(),
    committed: Money.ofMinor(totals.committed, payoutAsset).toDecimalString(),
    unallocated: Money.ofMinor(payout.minor - totals.committed > 0n ? payout.minor - totals.committed : 0n, payoutAsset).toDecimalString(),
    receivable: receivable.toJSON(),
    received: Money.ofMinor(totals.received, receivable.currency).toDecimalString(),
    legs,
    cases,
    payoutOptions: {
      asset: payoutAsset,
      accounts: payoutAsset === 'INR' ? await payoutAccounts(ex) : [],
      wallets: payoutAsset === 'USDT' ? await treasuryWallets(ex) : [],
      routeDirectAvailable: row.route_execution_mode === 'DIRECT_TO_CLIENT',
      routeName: null,
    },
  };

  const deposit = await depositFor(ex, id);
  const routeName = await routeNameOf(ex, row.route_id);
  const withDeposit: DeskTrade = {
    ...base,
    ...(deposit ? { deposit } : {}),
    payoutOptions: { ...base.payoutOptions, routeName },
  };
  if (!access.economics && !access.routePositions) return withDeposit;

  const economics = access.economics
    ? {
        clientRate: microToDecimal(row.client_rate_micro),
        routeRate: microToDecimal(row.route_rate_micro),
        expectedMargin: Money.ofMinor(row.gross_margin_inr_minor, 'INR').toDecimalString(),
        executionMode: row.route_execution_mode,
      }
    : {};
  const route = access.routePositions ? await routeSideOf(ex, id) : undefined;
  return { ...withDeposit, ...economics, ...(route ? { route } : {}) };
}

async function deskLegs(ex: Executor, tradeId: string): Promise<DeskLeg[]> {
  const rows = await sql<{
    id: string; ref: string; side: DeskLeg['side']; asset: 'INR' | 'USDT'; amount_minor: bigint; status: DeskLeg['status'];
    payer: DeskLeg['payer']; account_label: string | null; route_name: string | null; utr: string | null; tx_hash: string | null;
    sent_at: Date | null; confirmed_at: Date | null; failure_reason: string | null;
  }>`
    select l.id, l.ref, l.side, l.asset, l.amount_minor, l.status, l.payer,
           a.label as account_label, r.name as route_name, f.utr, c.tx_hash,
           l.sent_at, l.confirmed_at, l.failure_reason
    from settlement_leg l
    left join inr_settlement_account a on a.id = l.inr_account_id
    left join liquidity_route r on r.id = l.route_id
    left join transfer_allocation al on al.settlement_leg_id = l.id and al.voided_at is null
    left join fiat_transfer f on f.id = al.fiat_transfer_id
    left join crypto_transfer c on c.id = al.crypto_transfer_id
    where l.trade_id = ${tradeId}
    order by l.seq`.execute(ex);
  return rows.rows.map((r) => ({
    id: r.id,
    ref: r.ref,
    side: r.side,
    asset: r.asset,
    amount: Money.ofMinor(r.amount_minor, r.asset).toDecimalString(),
    status: r.status,
    payer: r.payer,
    accountLabel: r.account_label,
    routeName: r.route_name,
    reference: r.utr ?? r.tx_hash ?? null,
    referenceKind: r.utr ? 'UTR' : r.tx_hash ? 'TX' : null,
    sentAt: r.sent_at ? r.sent_at.toISOString() : null,
    confirmedAt: r.confirmed_at ? r.confirmed_at.toISOString() : null,
    failureReason: r.failure_reason,
  }));
}

async function deskCases(ex: Executor, tradeId: string): Promise<DeskCase[]> {
  const rows = await ex
    .selectFrom('exception_case')
    .select(['id', 'ref', 'type', 'severity', 'status', 'details', 'opened_at'])
    .where('trade_id', '=', tradeId)
    .where('status', 'in', ['OPEN', 'IN_PROGRESS'])
    .orderBy('opened_at')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    ref: r.ref,
    type: r.type,
    severity: r.severity,
    status: r.status,
    details: (r.details ?? {}) as Record<string, unknown>,
    openedAt: r.opened_at.toISOString(),
  }));
}

async function depositFor(ex: Executor, tradeId: string): Promise<DeskTrade['deposit']> {
  const row = await ex
    .selectFrom('deposit_assignment as a')
    .innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
    .select(['d.address', 'd.status', 'a.expected_amount_minor'])
    .where('a.trade_id', '=', tradeId)
    .orderBy('a.assigned_at', 'desc')
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    address: row.address,
    expected: row.expected_amount_minor === null ? null : Money.ofMinor(row.expected_amount_minor, 'USDT').toDecimalString(),
    status: row.status,
  };
}

async function routeNameOf(ex: Executor, routeId: string): Promise<string | null> {
  const r = await ex.selectFrom('liquidity_route').select('name').where('id', '=', routeId).executeTakeFirst();
  return r?.name ?? null;
}

async function routeSideOf(ex: Executor, tradeId: string): Promise<RouteSide | undefined> {
  const o = await ex
    .selectFrom('route_obligation as o')
    .innerJoin('liquidity_route as r', 'r.id', 'o.route_id')
    .select([
      'o.id', 'o.ref', 'o.route_id', 'r.name as route_name', 'o.execution_mode', 'o.status',
      'o.route_delivers_asset', 'o.route_delivers_minor', 'o.exchange_delivers_asset', 'o.exchange_delivers_minor',
    ])
    .where('o.trade_id', '=', tradeId)
    .executeTakeFirst();
  if (!o) return undefined;
  const remaining = await obligationRemaining(ex, o.id);
  return {
    obligationId: o.id,
    ref: o.ref,
    routeId: o.route_id,
    routeName: o.route_name,
    executionMode: o.execution_mode,
    status: o.status,
    routeDelivers: Money.ofMinor(o.route_delivers_minor, o.route_delivers_asset).toJSON(),
    routeDeliversRemaining: remaining.routeDelivers.toJSON(),
    exchangeDelivers: Money.ofMinor(o.exchange_delivers_minor, o.exchange_delivers_asset).toJSON(),
    exchangeDeliversRemaining: remaining.exchangeDelivers.toJSON(),
  };
}

/** ACTIVE payout accounts with what is left of today's capacity — the panel's "Available today" column. */
export async function payoutAccounts(ex: Executor): Promise<PayoutAccountOption[]> {
  const day = await istToday(ex);
  const rows = await sql<{
    id: string; label: string; bank_name: string; account_last4: string; rails: string[];
    capacity_minor: bigint | null; used_minor: bigint | null; reserved_minor: bigint | null; default_daily_capacity_minor: bigint;
  }>`
    select a.id, a.label, a.bank_name, a.account_last4, a.rails,
           d.capacity_minor, d.used_minor, d.reserved_minor, a.default_daily_capacity_minor
    from inr_settlement_account a
    left join inr_account_day d on d.account_id = a.id and d.day = ${day}::date
    where a.status = 'ACTIVE' and a.direction in ('PAYOUT', 'BOTH')
    order by a.label`.execute(ex);
  return rows.rows.map((r) => {
    // No row for today yet means the day has not been opened: the default capacity is what it would start at.
    const capacity = r.capacity_minor ?? r.default_daily_capacity_minor;
    const available = capacity - (r.used_minor ?? 0n) - (r.reserved_minor ?? 0n);
    return {
      accountId: r.id,
      label: r.label,
      bankName: r.bank_name,
      last4: r.account_last4,
      availableToday: Money.ofMinor(available > 0n ? available : 0n, 'INR').toDecimalString(),
      capacityToday: Money.ofMinor(capacity, 'INR').toDecimalString(),
      rails: r.rails,
    };
  });
}

export async function treasuryWallets(ex: Executor): Promise<TreasuryWalletOption[]> {
  const rows = await ex
    .selectFrom('treasury_wallet')
    .select(['id', 'label', 'address', 'observed_balance_minor', 'reserved_minor'])
    .where('status', '=', 'ACTIVE')
    .where('role', 'in', ['HOT', 'COLD'])
    .orderBy('label')
    .execute();
  return rows.map((r) => {
    const available = r.observed_balance_minor - r.reserved_minor;
    return {
      walletId: r.id,
      label: r.label,
      address: r.address,
      available: Money.ofMinor(available > 0n ? available : 0n, 'USDT').toDecimalString(),
    };
  });
}
