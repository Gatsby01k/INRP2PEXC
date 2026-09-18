import { DomainError, Money, requireUuid } from '@inrp2p/kernel';
import type { DirectionValue, Executor, FixedSideValue } from '@inrp2p/db';
import { currentRouteRate } from '@inrp2p/pricing';
import type { DeskAccess } from './access.ts';
import { microToDecimal } from './strip.ts';

export interface QuoteRouteOption {
  readonly routeId: string;
  readonly name: string;
  readonly executionMode: 'DIRECT_TO_CLIENT' | 'TO_EXCHANGE';
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
}

/**
 * What the quote builder needs (UX_FLOWS F4): the client's ask, where the money would go, and the route rates
 * the desk can price against right now. The panel computes the INR and the margin from these with the kernel's
 * own economics, so the preview and the command agree by construction (FI-02).
 */
export async function deskRequest(ex: Executor, requestId: string, access: DeskAccess, opts: { maxRateAgeSeconds?: number } = {}): Promise<DeskRequest> {
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

  const maxAge = (opts.maxRateAgeSeconds ?? 15 * 60) * 1000;
  const routes = await ex.selectFrom('liquidity_route').select(['id', 'name', 'execution_mode']).where('status', '=', 'ACTIVE').orderBy('name').execute();
  const options: QuoteRouteOption[] = [];
  for (const r of routes) {
    const snapshot = await currentRouteRate(ex, r.id, row.direction);
    options.push({
      routeId: r.id,
      name: r.name,
      executionMode: r.execution_mode,
      rate: snapshot ? snapshot.rate.toDecimalString() : null,
      publishedAt: snapshot ? snapshot.effectiveAt.toISOString() : null,
      stale: snapshot ? Date.now() - snapshot.effectiveAt.getTime() > maxAge : true,
    });
  }
  return { ...base, routes: options };
}
