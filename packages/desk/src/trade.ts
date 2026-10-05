import { sql } from 'kysely';
import { DomainError, Money, requireUuid } from '@inrp2p/kernel';
import type { DirectionValue, ExecutionMode, Executor } from '@inrp2p/db';
import { istToday } from '@inrp2p/inr-accounts';
import { effectiveObligations, legTotals, tradeFundingModel } from '@inrp2p/trades';
import { fundingPosition, obligationRemaining } from '@inrp2p/settlement';
import type { DeskAccess } from './access.ts';
import { microToDecimal } from './strip.ts';

export interface DeskLeg {
  readonly id: string;
  readonly ref: string;
  /** `REFUND_TO_CLIENT` is the leg that returns a client's own confirmed funds before a cancellation (T10). */
  readonly side: 'CLIENT_TO_EXCHANGE' | 'EXCHANGE_TO_CLIENT' | 'REFUND_TO_CLIENT';
  readonly asset: 'INR' | 'USDT';
  readonly amount: string;
  readonly status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  readonly payer: 'CLIENT' | 'EXCHANGE_ACCOUNT' | 'ROUTE';
  /** Where an exchange-paid INR leg draws from, for the panel's account line. */
  readonly accountLabel: string | null;
  readonly routeName: string | null;
  /** A USDT leg's sending address — its deposit address when it passes money through, else its treasury wallet. */
  readonly walletAddress: string | null;
  /** Bank reference or transaction hash, whichever this leg's evidence is. */
  readonly reference: string | null;
  readonly referenceKind: 'UTR' | 'TX' | null;
  readonly createdAt: string;
  readonly sentAt: string | null;
  readonly confirmedAt: string | null;
  readonly failedAt: string | null;
  readonly cancelledAt: string | null;
  readonly failureReason: string | null;
  /**
   * Who created the leg (the operator's user id, or SYSTEM), and a readable name for it. Shown because the desk's
   * two-person rules key on it: a refund is confirmed by someone other than its creator (FI-31, SECURITY §4).
   */
  readonly createdBy: string;
  readonly createdByLabel: string;
  /** Who marked it sent (C1), when the record says; null for a leg not sent yet or sent before 0027. */
  readonly sentBy: string | null;
  readonly sentByLabel: string | null;
  /** A payout above the approval threshold: someone other than its sender confirms it (SECURITY §4). */
  readonly needsSecondPerson: boolean;
}

export interface DeskCase {
  readonly id: string;
  readonly ref: string;
  readonly type: string;
  readonly severity: 'BLOCKING' | 'WARNING';
  readonly status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'VOID';
  readonly details: Record<string, unknown>;
  readonly openedAt: string;
  /** Whoever took the case (`exception.take`), so two operators do not work the same one. */
  readonly takenBy: string | null;
  readonly takenByLabel: string | null;
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

/** One place a trade's money is (D-16): a bank account or a TRON address, and what may still leave from it. */
export interface FundingPlace {
  readonly kind: 'CLIENT_FUNDS' | 'COUNTERPARTY_FUNDS';
  readonly asset: 'INR' | 'USDT';
  /** `INR:{accountId}` or `TRON:{address}`. */
  readonly location: string;
  readonly label: string;
  readonly inrAccountId: string | null;
  readonly treasuryWalletId: string | null;
  readonly depositAddressId: string | null;
  readonly address: string | null;
  /**
   * What a new outflow may still take from here. Counterparty funds are capped at what the client is still owed
   * unless the viewer may see route positions: the uncapped figure divided by the trade's size is the route rate.
   */
  readonly free: string;
  /** Route-positions viewers only: what arrived here for this trade, what is planned out of it, what has left. */
  readonly arrived?: string;
  readonly planned?: string;
  readonly spent?: string;
}

export interface TradeFunding {
  readonly model: 'COUNTERPARTY_FUNDED' | 'LEGACY_EXCHANGE_FUNDED';
  readonly places: readonly FundingPlace[];
  /** Whether the counterparty has delivered its side (confirmed): nothing yet, part of it, or all of it. */
  readonly counterparty: 'NONE' | 'PARTIAL' | 'FULL';
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
  /** True once a settlement receipt has been issued for this trade (Phase 8). */
  readonly receipt: boolean;
  /** SELL only: the address this client was told to send to, and the amount expected there (D-02). */
  readonly deposit?: { readonly address: string; readonly expected: string | null; readonly status: string };
  /** Route side, only with `route_positions:view`. */
  readonly route?: RouteSide;
  /** Where this trade's money is and what may leave from where (D-16). */
  readonly funding: TradeFunding;
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
  const receipt = await ex.selectFrom('receipt').select('id').where('trade_id', '=', id).executeTakeFirst();
  const payoutAsset = payout.currency;
  const unallocatedMinor = payout.minor - totals.committed > 0n ? payout.minor - totals.committed : 0n;
  const funding = await tradeFunding(ex, id, { unallocatedMinor, routePositions: access.routePositions });

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
    unallocated: Money.ofMinor(unallocatedMinor, payoutAsset).toDecimalString(),
    receivable: receivable.toJSON(),
    received: Money.ofMinor(totals.received, receivable.currency).toDecimalString(),
    legs,
    cases,
    receipt: receipt !== undefined,
    funding,
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
    payer: DeskLeg['payer']; account_label: string | null; route_name: string | null; wallet_address: string | null; utr: string | null; tx_hash: string | null;
    created_at: Date; sent_at: Date | null; confirmed_at: Date | null; failed_at: Date | null; cancelled_at: Date | null; failure_reason: string | null;
    created_by: string; created_by_label: string | null; sent_by: string | null; sent_by_label: string | null; needs_second: boolean | null;
  }>`
    select l.id, l.ref, l.side, l.asset, l.amount_minor, l.status, l.payer,
           a.label as account_label, r.name as route_name, coalesce(da.address, tw.address) as wallet_address, f.utr, c.tx_hash,
           l.created_at, l.sent_at, l.confirmed_at, l.failed_at, l.cancelled_at, l.failure_reason,
           l.created_by, coalesce(u.name, u.email) as created_by_label,
           l.sent_by, coalesce(su.name, su.email) as sent_by_label,
           case when l.side = 'EXCHANGE_TO_CLIENT' then inrp2p_payout_needs_second_person(l.trade_id, l.asset, l.amount_minor) end as needs_second
    from settlement_leg l
    left join inr_settlement_account a on a.id = l.inr_account_id
    left join liquidity_route r on r.id = l.route_id
    left join treasury_wallet tw on tw.id = l.treasury_wallet_id
    left join deposit_address da on da.id = l.source_deposit_address_id
    left join transfer_allocation al on al.settlement_leg_id = l.id and al.voided_at is null
    left join fiat_transfer f on f.id = al.fiat_transfer_id
    left join crypto_transfer c on c.id = al.crypto_transfer_id
    left join auth_user u on u.id::text = l.created_by
    left join auth_user su on su.id::text = l.sent_by
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
    walletAddress: r.wallet_address,
    reference: r.utr ?? r.tx_hash ?? null,
    referenceKind: r.utr ? 'UTR' : r.tx_hash ? 'TX' : null,
    createdAt: r.created_at.toISOString(),
    sentAt: r.sent_at ? r.sent_at.toISOString() : null,
    confirmedAt: r.confirmed_at ? r.confirmed_at.toISOString() : null,
    failedAt: r.failed_at ? r.failed_at.toISOString() : null,
    cancelledAt: r.cancelled_at ? r.cancelled_at.toISOString() : null,
    failureReason: r.failure_reason,
    createdBy: r.created_by,
    createdByLabel: r.created_by.startsWith('SYSTEM') ? 'System' : (r.created_by_label ?? 'an operator'),
    sentBy: r.sent_by,
    sentByLabel: r.sent_by ? (r.sent_by.startsWith('SYSTEM') ? 'System' : (r.sent_by_label ?? 'an operator')) : null,
    needsSecondPerson: r.needs_second === true,
  }));
}

async function deskCases(ex: Executor, tradeId: string): Promise<DeskCase[]> {
  const rows = await sql<{
    id: string; ref: string; type: string; severity: DeskCase['severity']; status: DeskCase['status']; details: unknown; opened_at: Date;
    taken_by: string | null; taken_by_label: string | null;
  }>`
    select x.id, x.ref, x.type, x.severity, x.status, x.details, x.opened_at, x.taken_by, coalesce(u.name, u.email) as taken_by_label
    from exception_case x
    left join auth_user u on u.id::text = x.taken_by
    where x.trade_id = ${tradeId} and x.status in ('OPEN', 'IN_PROGRESS')
    order by x.opened_at`.execute(ex);
  return rows.rows.map((r) => ({
    id: r.id,
    ref: r.ref,
    type: r.type,
    severity: r.severity,
    status: r.status,
    details: (r.details ?? {}) as Record<string, unknown>,
    openedAt: r.opened_at.toISOString(),
    takenBy: r.taken_by,
    takenByLabel: r.taken_by ? (r.taken_by_label ?? 'an operator') : null,
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

/**
 * The trade's funding, place by place: confirmed client and counterparty money (the `funding_source` view) less what
 * is planned out of it (ACTIVE earmarks) and what has left (CONSUMED). Legacy trades have no places — the treasury
 * paid them, as it always did.
 */
export async function tradeFunding(ex: Executor, tradeId: string, opts: { unallocatedMinor: bigint; routePositions: boolean }): Promise<TradeFunding> {
  const model = await tradeFundingModel(ex, tradeId);
  const { sources, allocations } = await fundingPosition(ex, tradeId);
  const byPlace = new Map<string, { kind: FundingPlace['kind']; asset: 'INR' | 'USDT'; location: string; arrived: bigint; planned: bigint; spent: bigint }>();
  for (const src of sources) {
    const key = `${src.kind}|${src.location}`;
    const place = byPlace.get(key) ?? { kind: src.kind, asset: src.asset, location: src.location, arrived: 0n, planned: 0n, spent: 0n };
    place.arrived += src.amountMinor;
    for (const a of allocations) {
      if (a.source_leg_id !== src.sourceId && a.source_route_settlement_id !== src.sourceId) continue;
      if (a.status === 'ACTIVE') place.planned += a.amount_minor;
      else if (a.status === 'CONSUMED') place.spent += a.amount_minor;
    }
    byPlace.set(key, place);
  }
  const places: FundingPlace[] = [];
  for (const p of byPlace.values()) {
    const free = p.arrived - p.planned - p.spent;
    const shown = p.kind === 'COUNTERPARTY_FUNDS' && !opts.routePositions && free > opts.unallocatedMinor ? opts.unallocatedMinor : free;
    const where = await placeOf(ex, p.location);
    places.push({
      kind: p.kind,
      asset: p.asset,
      location: p.location,
      ...where,
      free: Money.ofMinor(shown > 0n ? shown : 0n, p.asset).toDecimalString(),
      ...(opts.routePositions
        ? { arrived: Money.ofMinor(p.arrived, p.asset).toDecimalString(), planned: Money.ofMinor(p.planned, p.asset).toDecimalString(), spent: Money.ofMinor(p.spent, p.asset).toDecimalString() }
        : {}),
    });
  }
  const obligation = await ex.selectFrom('route_obligation').select(['route_delivers_minor']).where('trade_id', '=', tradeId).executeTakeFirst();
  const delivered = sources.filter((x) => x.kind === 'COUNTERPARTY_FUNDS').reduce((sum, x) => sum + x.amountMinor, 0n);
  const counterparty: TradeFunding['counterparty'] = delivered === 0n ? 'NONE' : obligation && delivered < obligation.route_delivers_minor ? 'PARTIAL' : 'FULL';
  return { model, places, counterparty };
}

async function placeOf(ex: Executor, location: string): Promise<Pick<FundingPlace, 'label' | 'inrAccountId' | 'treasuryWalletId' | 'depositAddressId' | 'address'>> {
  if (location.startsWith('INR:')) {
    const id = location.slice(4);
    const a = await ex.selectFrom('inr_settlement_account').select(['label', 'bank_name', 'account_last4']).where('id', '=', id).executeTakeFirst();
    return { label: a ? `${a.label} · ${a.bank_name} ••${a.account_last4}` : 'INR account', inrAccountId: id, treasuryWalletId: null, depositAddressId: null, address: null };
  }
  const address = location.slice(5);
  const wallet = await ex.selectFrom('treasury_wallet').select(['id', 'label']).where('network', '=', 'TRON').where('address', '=', address).executeTakeFirst();
  if (wallet) return { label: wallet.label, inrAccountId: null, treasuryWalletId: wallet.id, depositAddressId: null, address };
  const deposit = await ex.selectFrom('deposit_address').select('id').where('network', '=', 'TRON').where('address', '=', address).executeTakeFirst();
  return { label: 'Deposit address', inrAccountId: null, treasuryWalletId: null, depositAddressId: deposit?.id ?? null, address };
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
