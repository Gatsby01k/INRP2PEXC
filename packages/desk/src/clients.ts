import { sql } from 'kysely';
import { DomainError, Money, requireUuid } from '@inrp2p/kernel';
import type { DirectionValue, Executor } from '@inrp2p/db';
import { listBankAccounts } from '@inrp2p/clients';
import type { DeskAccess } from './access.ts';

export interface ClientBookRow {
  readonly clientId: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'SUSPENDED';
  readonly kycStatus: string;
  readonly openTrades: number;
  readonly completedTrades: number;
  /** Lifetime completed USDT volume. Economics-gated figures live on the detail view, not here. */
  readonly completedVolume: string;
  readonly lastActivityAt: string | null;
}

/** The dealer's book: who the clients are and how much of the desk's attention they currently hold. */
export async function clientBook(ex: Executor, opts: { search?: string; limit?: number } = {}): Promise<readonly ClientBookRow[]> {
  const search = (opts.search ?? '').trim();
  const rows = await sql<{
    id: string; name: string; status: 'ACTIVE' | 'SUSPENDED'; kyc_status: string;
    open_trades: string; completed_trades: string; completed_volume: string; last_activity: Date | null;
  }>`
    select c.id, c.display_name as name, c.status, c.kyc_status,
           count(t.id) filter (where t.lifecycle_state not in ('COMPLETED', 'CANCELLED'))::text as open_trades,
           count(t.id) filter (where t.lifecycle_state = 'COMPLETED')::text as completed_trades,
           coalesce(sum(e.base_minor) filter (where t.lifecycle_state = 'COMPLETED'), 0)::text as completed_volume,
           max(t.opened_at) as last_activity
    from client c
    left join trade t on t.client_id = c.id
    left join trade_economics e on e.trade_id = t.id
    where (${search}::text = '' or c.display_name ilike ${`${search}%`})
    group by c.id, c.display_name, c.status, c.kyc_status
    order by c.display_name
    limit ${opts.limit ?? 100}`.execute(ex);
  return rows.rows.map((r) => ({
    clientId: r.id,
    name: r.name,
    status: r.status,
    kycStatus: r.kyc_status,
    openTrades: Number.parseInt(r.open_trades, 10),
    completedTrades: Number.parseInt(r.completed_trades, 10),
    completedVolume: Money.ofMinor(BigInt(r.completed_volume), 'USDT').toDecimalString(),
    lastActivityAt: r.last_activity ? r.last_activity.toISOString() : null,
  }));
}

export interface ClientDestination {
  readonly id: string;
  readonly kind: 'BANK' | 'WALLET';
  readonly label: string;
  readonly detail: string;
  readonly status: string;
  readonly isDefault: boolean;
}

export interface ClientDetail {
  readonly clientId: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'SUSPENDED';
  readonly kycStatus: string;
  readonly bankAccounts: readonly ClientDestination[];
  readonly wallets: readonly ClientDestination[];
  readonly acceptors: readonly { readonly clientUserId: string; readonly maskedEmail: string }[];
  /** The last trades, for "repeat trade" and for context when quoting. */
  readonly recentTrades: readonly {
    readonly tradeId: string;
    readonly ref: string;
    readonly direction: DirectionValue;
    readonly base: string;
    readonly quoteInr: string;
    readonly lifecycle: string;
    readonly openedAt: string;
    readonly clientRate?: string;
  }[];
}

/**
 * One client, as the desk needs them before quoting: who may accept, where money may go, and what they last
 * traded. Destinations are the same ACTIVE-only list the commands will accept, so the panel cannot offer a
 * destination that acceptance would then refuse (S8).
 */
export async function clientDetail(ex: Executor, clientId: string, access: DeskAccess): Promise<ClientDetail> {
  const id = requireUuid(clientId, 'clientId');
  const client = await ex.selectFrom('client').select(['id', 'display_name', 'status', 'kyc_status']).where('id', '=', id).executeTakeFirst();
  if (!client) throw new DomainError('NOT_FOUND', 'client not found');

  const banks = await listBankAccounts(ex, id);
  const wallets = await ex
    .selectFrom('crypto_wallet')
    .select(['id', 'label', 'address', 'network', 'purpose', 'status'])
    .where('client_id', '=', id)
    .where('status', '=', 'ACTIVE')
    .orderBy('created_at')
    .execute();
  const { listAuthorizedAcceptors } = await import('@inrp2p/clients');
  const acceptors = await listAuthorizedAcceptors(ex, id);

  const trades = await sql<{
    id: string; ref: string; direction: DirectionValue; base_minor: bigint; quote_inr_minor: bigint;
    lifecycle_state: string; opened_at: Date; client_rate_micro: bigint;
  }>`
    select t.id, t.ref, t.direction, e.base_minor, e.quote_inr_minor, t.lifecycle_state, t.opened_at, e.client_rate_micro
    from trade t join trade_economics e on e.trade_id = t.id
    where t.client_id = ${id}
    order by t.opened_at desc
    limit 10`.execute(ex);
  const { microToDecimal } = await import('./strip.ts');

  return {
    clientId: client.id,
    name: client.display_name,
    status: client.status,
    kycStatus: client.kyc_status,
    bankAccounts: banks.map((b) => ({
      id: b.id,
      kind: 'BANK' as const,
      label: b.holderName,
      detail: `${b.bankName} ${b.ifsc} ••••${b.last4}`,
      status: b.status,
      isDefault: false,
    })),
    wallets: wallets
      .filter((w) => w.purpose !== 'SOURCE')
      .map((w) => ({
        id: w.id,
        kind: 'WALLET' as const,
        label: w.label,
        detail: `${w.network} · ${w.address}`,
        status: w.status,
        isDefault: false,
      })),
    acceptors,
    recentTrades: trades.rows.map((t) => ({
      tradeId: t.id,
      ref: t.ref,
      direction: t.direction,
      base: Money.ofMinor(t.base_minor, 'USDT').toDecimalString(),
      quoteInr: Money.ofMinor(t.quote_inr_minor, 'INR').toDecimalString(),
      lifecycle: t.lifecycle_state,
      openedAt: t.opened_at.toISOString(),
      ...(access.economics ? { clientRate: microToDecimal(t.client_rate_micro) } : {}),
    })),
  };
}
