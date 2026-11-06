import { DomainError, Money, requireUuid } from '@inrp2p/kernel';
import type { DirectionValue, Executor, FixedSideValue } from '@inrp2p/db';
import { networkFeePolicy, usdtNetworkTerms } from '@inrp2p/network';
import { type DeskOrderRow, requestTraderOrders } from '@inrp2p/traders';
import type { DeskAccess } from './access.ts';
import { microToDecimal } from './strip.ts';

export interface QuoteRouteOption {
  readonly routeId: string;
  readonly name: string;
  readonly executionMode: 'DIRECT_TO_CLIENT' | 'TO_EXCHANGE' | 'P2P';
  /** Current route rate for this request's direction, or null when none has been published. */
  readonly rate: string | null;
  readonly publishedAt: string | null;
  /** True when the snapshot is older than the quoting policy allows — the dealer must refresh it first. */
  readonly stale: boolean;
}

export interface DeskRequest {
  readonly requestId: string;
  readonly ref: string;
  readonly status: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly direction: DirectionValue;
  readonly fixedSide: FixedSideValue;
  /** Whichever side the client fixed, as a decimal in that side's currency. */
  readonly amount: string;
  readonly amountCurrency: 'USDT' | 'INR';
  readonly targetRate: string | null;
  readonly destination: string;
  readonly createdAt: string;
  /** Routes a quote could be priced against. Absent without `economics:view` — a quote is economics. */
  readonly routes?: readonly QuoteRouteOption[];
  /**
   * The request's trader side (docs/TRADERS.md): its live order, if one is offered, held or started, and what came
   * before. A trader's rate is a route rate, so this is absent without `economics:view` too.
   */
  readonly trader?: {
    readonly live: DeskOrderRow | null;
    readonly liveTraderRef: string | null;
    readonly liveRouteId: string | null;
    /** The client rate the live order was sized at: a P2P quote must use exactly it. */
    readonly livePlannedClientRate: string | null;
    readonly history: readonly (DeskOrderRow & { readonly traderRef: string })[];
  };
  /**
   * What a quote's price must also carry: the minimum net margin and, on GasFree (ADR 0022), the USDT a P2P deal carries for
   * its network out of INRP2P's margin — null when GasFree's fees are not current. On TRX the trader's deposit pays it.
   * The builder values them at the rate being typed with the kernel's own functions, as the command does.
   */
  readonly network?: { readonly gasFreeAllowanceUsdtMinor: string | null; readonly resourceMode: 'BURN' | 'GASFREE'; readonly minNetMarginMinor: string } | null;
}

/**
 * What the quote builder needs (UX_FLOWS F4): the client's ask, where the money would go, and the route rates
 * the desk can price against right now. The panel computes the INR and the margin from these with the kernel's
 * own economics, so the preview and the command agree by construction (FI-02).
 */
export async function deskRequest(ex: Executor, requestId: string, access: DeskAccess): Promise<DeskRequest> {
  const id = requireUuid(requestId, 'requestId');
  const row = await ex
    .selectFrom('trade_request as r')
    .innerJoin('client as c', 'c.id', 'r.client_id')
    .leftJoin('bank_account as b', 'b.id', 'r.bank_account_id')
    .leftJoin('crypto_wallet as w', 'w.id', 'r.crypto_wallet_id')
    .select([
      'r.id', 'r.ref', 'r.status', 'r.client_id', 'c.display_name as client_name', 'r.direction', 'r.fixed_side',
      'r.requested_base_minor', 'r.requested_quote_minor', 'r.target_rate_micro', 'r.created_at',
      'b.bank_name', 'b.ifsc', 'b.account_last4', 'w.address', 'w.network', 'w.label as wallet_label',
    ])
    .where('r.id', '=', id)
    .executeTakeFirst();
  if (!row) throw new DomainError('NOT_FOUND', 'request not found');

  const base: DeskRequest = {
    requestId: row.id,
    ref: row.ref,
    status: row.status,
    clientId: row.client_id,
    clientName: row.client_name,
    direction: row.direction,
    fixedSide: row.fixed_side,
    amount:
      row.fixed_side === 'BASE'
        ? Money.ofMinor(row.requested_base_minor ?? 0n, 'USDT').toDecimalString()
        : Money.ofMinor(row.requested_quote_minor ?? 0n, 'INR').toDecimalString(),
    amountCurrency: row.fixed_side === 'BASE' ? 'USDT' : 'INR',
    targetRate: row.target_rate_micro === null ? null : microToDecimal(row.target_rate_micro),
    destination: row.bank_name
      ? `${row.bank_name} ${row.ifsc} ••••${row.account_last4}`
      : row.address
        ? `${row.wallet_label ?? row.network} · ${row.address}`
        : 'no destination on file',
    createdAt: row.created_at.toISOString(),
  };
  if (!access.economics) return base;

  const trader = await requestTraderOrders(ex, row.id);
  const liveRoute = trader.live ? await ex.selectFrom('trader_order').select(['route_id', 'planned_client_rate_micro']).where('id', '=', trader.live.orderId).executeTakeFirst() : undefined;
  const fees = await networkFeePolicy(ex);
  let gasFreeAllowance: string | null = null;
  if (fees.resourceMode === 'GASFREE') {
    try {
      gasFreeAllowance = (await usdtNetworkTerms(ex, { funderTraderId: null })).allowanceUsdtMinor.toString();
    } catch (e) {
      if (!(e instanceof DomainError && e.code === 'NETWORK_FEES_UNKNOWN')) throw e;
    }
  }
  const network: DeskRequest['network'] = { gasFreeAllowanceUsdtMinor: gasFreeAllowance, resourceMode: fees.resourceMode, minNetMarginMinor: fees.minNetMarginInrMinor.toString() };
  return {
    ...base,
    network,
    routes: [],
    trader: {
      live: trader.live,
      liveTraderRef: trader.live ? (trader.traderRefs[trader.live.orderId] ?? null) : null,
      liveRouteId: liveRoute?.route_id ?? null,
      livePlannedClientRate: liveRoute?.planned_client_rate_micro ? microToDecimal(liveRoute.planned_client_rate_micro) : null,
      history: trader.history.map((h) => ({ ...h, traderRef: trader.traderRefs[h.orderId] ?? '' })),
    },
  };
}
