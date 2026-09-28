import { sql } from 'kysely';
import { DomainError, Money, requireUuid } from '@inrp2p/kernel';
import type { DirectionValue, Executor } from '@inrp2p/db';
import { listBankAccounts } from '@inrp2p/clients';
import type { DeskAccess } from './access.ts';
import { microToDecimal } from './strip.ts';

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
  readonly ref: string;
  readonly typicalDirection: DirectionValue | null;
  /** Typical ticket, in USDT, as the desk recorded it. */
  readonly typicalSize: string | null;
  /** Economics-gated (`economics:view`): the client rate of the latest trade, and the margin its completed trades made. */
  readonly lastRate?: string | null;
  readonly marginGenerated?: string;
}

/** The dealer's book: who the clients are and how much of the desk's attention they currently hold. */
export async function clientBook(ex: Executor, opts: { search?: string; limit?: number; access?: DeskAccess } = {}): Promise<readonly ClientBookRow[]> {
  const search = (opts.search ?? '').trim();
  const rows = await sql<{
    id: string; ref: string; name: string; status: 'ACTIVE' | 'SUSPENDED'; kyc_status: string; typical_direction: DirectionValue | null;
    typical_size_usdt_minor: bigint | null; open_trades: string; completed_trades: string; completed_volume: string; last_activity: Date | null;
    margin: string; last_rate_micro: bigint | null;
  }>`
    select c.id, c.ref, c.display_name as name, c.status, c.kyc_status, c.typical_direction, c.typical_size_usdt_minor,
           count(t.id) filter (where t.lifecycle_state not in ('COMPLETED', 'CANCELLED'))::text as open_trades,
           count(t.id) filter (where t.lifecycle_state = 'COMPLETED')::text as completed_trades,
           coalesce(sum(e.base_minor) filter (where t.lifecycle_state = 'COMPLETED'), 0)::text as completed_volume,
           coalesce(sum(e.gross_margin_inr_minor) filter (where t.lifecycle_state = 'COMPLETED'), 0)::text as margin,
           (select e2.client_rate_micro from trade t2 join trade_economics e2 on e2.trade_id = t2.id
             where t2.client_id = c.id order by t2.opened_at desc limit 1) as last_rate_micro,
           max(t.opened_at) as last_activity
    from client c
    left join trade t on t.client_id = c.id
    left join trade_economics e on e.trade_id = t.id
    where (${search}::text = '' or c.display_name ilike ${`${search}%`})
    group by c.id, c.ref, c.display_name, c.status, c.kyc_status, c.typical_direction, c.typical_size_usdt_minor
    order by c.display_name
    limit ${opts.limit ?? 100}`.execute(ex);
  return rows.rows.map((r) => {
    const row: ClientBookRow = {
      clientId: r.id,
      ref: r.ref,
      name: r.name,
      status: r.status,
      kycStatus: r.kyc_status,
      typicalDirection: r.typical_direction,
      typicalSize: r.typical_size_usdt_minor === null ? null : Money.ofMinor(r.typical_size_usdt_minor, 'USDT').toDecimalString(),
      openTrades: Number.parseInt(r.open_trades, 10),
      completedTrades: Number.parseInt(r.completed_trades, 10),
      completedVolume: Money.ofMinor(BigInt(r.completed_volume), 'USDT').toDecimalString(),
      lastActivityAt: r.last_activity ? r.last_activity.toISOString() : null,
    };
    if (!opts.access?.economics) return row;
    return {
      ...row,
      lastRate: r.last_rate_micro === null ? null : microToDecimal(r.last_rate_micro),
      marginGenerated: Money.ofMinor(BigInt(r.margin), 'INR').toDecimalString(),
    };
  });
}

export interface ClientDestination {
  readonly id: string;
  readonly kind: 'BANK' | 'WALLET';
  readonly label: string;
  readonly detail: string;
  readonly status: string;
  readonly isDefault: boolean;
}

export interface ClientContact {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly telegram: string | null;
  /** Masked: the sealed numbers are never opened for a list (SECURITY §5). */
  readonly phoneLast4: string | null;
  readonly whatsappLast4: string | null;
  readonly primary: boolean;
  readonly notes: string | null;
}

export interface ClientDetail {
  readonly clientId: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'SUSPENDED';
  readonly kycStatus: string;
  readonly ref: string;
  readonly legalName: string;
  readonly type: 'COMPANY' | 'INDIVIDUAL';
  readonly typicalDirection: DirectionValue | null;
  readonly typicalSize: string | null;
  readonly pricingNotes: string | null;
  readonly stats: {
    readonly openTrades: number;
    readonly completedTrades: number;
    readonly completedVolume: string;
    /** Economics-gated. */
    readonly marginGenerated?: string;
  };
  /** CRM contacts, only when the caller asked for them (the page asks with `client:manage`). */
  readonly contacts?: readonly ClientContact[];
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
    readonly hold: boolean;
    readonly clientRate?: string;
    readonly margin?: string;
  }[];
}

/**
 * One client, as the desk needs them before quoting: who may accept, where money may go, and what they last
 * traded. Destinations are the same ACTIVE-only list the commands will accept, so the panel cannot offer a
 * destination that acceptance would then refuse (S8).
 */
export async function clientDetail(ex: Executor, clientId: string, access: DeskAccess, opts: { contacts?: boolean } = {}): Promise<ClientDetail> {
  const id = requireUuid(clientId, 'clientId');
  const client = await ex
    .selectFrom('client')
    .select(['id', 'ref', 'display_name', 'legal_name', 'type', 'status', 'kyc_status', 'typical_direction', 'typical_size_usdt_minor', 'pricing_notes'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!client) throw new DomainError('NOT_FOUND', 'client not found');
  const totals = await sql<{ open_trades: string; completed_trades: string; completed_volume: string; margin: string }>`
    select count(*) filter (where t.lifecycle_state not in ('COMPLETED', 'CANCELLED'))::text as open_trades,
           count(*) filter (where t.lifecycle_state = 'COMPLETED')::text as completed_trades,
           coalesce(sum(e.base_minor) filter (where t.lifecycle_state = 'COMPLETED'), 0)::text as completed_volume,
           coalesce(sum(e.gross_margin_inr_minor) filter (where t.lifecycle_state = 'COMPLETED'), 0)::text as margin
    from trade t join trade_economics e on e.trade_id = t.id
    where t.client_id = ${id}`.execute(ex);
  const tot = totals.rows[0]!;
  const contacts = opts.contacts
    ? await ex
        .selectFrom('client_contact')
        .select(['id', 'name', 'email', 'telegram_handle', 'phone_last4', 'whatsapp_last4', 'is_primary', 'notes'])
        .where('client_id', '=', id)
        .where('status', '=', 'ACTIVE')
        .orderBy('is_primary', 'desc')
        .orderBy('created_at')
        .execute()
    : null;

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
    lifecycle_state: string; opened_at: Date; client_rate_micro: bigint; hold: boolean; gross_margin_inr_minor: bigint;
  }>`
    select t.id, t.ref, t.direction, e.base_minor, e.quote_inr_minor, t.lifecycle_state, t.opened_at, e.client_rate_micro, t.hold, e.gross_margin_inr_minor
    from trade t join trade_economics e on e.trade_id = t.id
    where t.client_id = ${id}
    order by t.opened_at desc
    limit 20`.execute(ex);

  return {
    clientId: client.id,
    name: client.display_name,
    status: client.status,
    kycStatus: client.kyc_status,
    ref: client.ref,
    legalName: client.legal_name,
    type: client.type,
    typicalDirection: client.typical_direction,
    typicalSize: client.typical_size_usdt_minor === null ? null : Money.ofMinor(client.typical_size_usdt_minor, 'USDT').toDecimalString(),
    pricingNotes: client.pricing_notes,
    stats: {
      openTrades: Number.parseInt(tot.open_trades, 10),
      completedTrades: Number.parseInt(tot.completed_trades, 10),
      completedVolume: Money.ofMinor(BigInt(tot.completed_volume), 'USDT').toDecimalString(),
      ...(access.economics ? { marginGenerated: Money.ofMinor(BigInt(tot.margin), 'INR').toDecimalString() } : {}),
    },
    ...(contacts
      ? {
          contacts: contacts.map((c) => ({
            id: c.id,
            name: c.name,
            email: c.email,
            telegram: c.telegram_handle,
            phoneLast4: c.phone_last4,
            whatsappLast4: c.whatsapp_last4,
            primary: c.is_primary,
            notes: c.notes,
          })),
        }
      : {}),
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
      hold: t.hold,
      ...(access.economics ? { clientRate: microToDecimal(t.client_rate_micro), margin: Money.ofMinor(t.gross_margin_inr_minor, 'INR').toDecimalString() } : {}),
    })),
  };
}
