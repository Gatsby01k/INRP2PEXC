import { sql } from 'kysely';
import { DomainError, Money, requireUuid } from '@inrp2p/kernel';
import type { DirectionValue, Executor } from '@inrp2p/db';
import { listBankAccounts } from '@inrp2p/clients';
import { isTelegramPlaceholderEmail, signInLabel } from '@inrp2p/identity';
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
  /** When the client's record was made: its own sign-up, or the desk adding it. */
  readonly joinedAt: string;
  /** Migration 0052: where the edge placed its people's first recorded sign-in; null before one was recorded. */
  readonly firstPlace: Place | null;
  readonly ref: string;
  readonly typicalDirection: DirectionValue | null;
  /** Typical ticket, in USDT, as the desk recorded it. */
  readonly typicalSize: string | null;
  /** Economics-gated (`economics:view`): the client rate of the latest trade, and the margin its completed trades made. */
  readonly lastRate?: string | null;
  readonly marginGenerated?: string;
  /** What its completed P2P deals earned INRP2P, in USDT. */
  readonly marginGeneratedUsdt?: string;
}

/** Where the edge placed an address: ISO country, its subdivision code, the city — any of them may be unknown. */
export interface Place {
  readonly country: string | null;
  readonly region: string | null;
  readonly city: string | null;
}

const placeOf = (r: { country: string | null; region: string | null; city: string | null }): Place | null =>
  r.country || r.region || r.city ? { country: r.country, region: r.region, city: r.city } : null;

/** How the book is read: who joined last, who traded last, or by name (the command bar's search). */
export type ClientBookSort = 'NEWEST' | 'ACTIVE' | 'NAME';

/** The dealer's book: who the clients are and how much of the desk's attention they currently hold. */
export async function clientBook(ex: Executor, opts: { search?: string; limit?: number; access?: DeskAccess; sort?: ClientBookSort } = {}): Promise<readonly ClientBookRow[]> {
  const search = (opts.search ?? '').trim();
  const sort = opts.sort ?? 'NAME';
  const rows = await sql<{
    id: string; ref: string; name: string; status: 'ACTIVE' | 'SUSPENDED'; kyc_status: string; typical_direction: DirectionValue | null;
    typical_size_usdt_minor: bigint | null; open_trades: string; completed_trades: string; completed_volume: string; last_activity: Date | null;
    margin: string; margin_usdt: string; last_rate_micro: bigint | null; created_at: Date;
    first_country: string | null; first_region: string | null; first_city: string | null;
  }>`
    select c.id, c.ref, c.display_name as name, c.status, c.kyc_status, c.typical_direction, c.typical_size_usdt_minor, c.created_at,
           count(t.id) filter (where t.lifecycle_state not in ('COMPLETED', 'CANCELLED'))::text as open_trades,
           count(t.id) filter (where t.lifecycle_state = 'COMPLETED')::text as completed_trades,
           coalesce(sum(e.base_minor) filter (where t.lifecycle_state = 'COMPLETED'), 0)::text as completed_volume,
           coalesce(sum(e.gross_margin_inr_minor) filter (where t.lifecycle_state = 'COMPLETED'), 0)::text as margin,
           coalesce(sum((e.gross_margin_base_minor - coalesce(e.network_fee_base_minor, 0))) filter (where t.lifecycle_state = 'COMPLETED'), 0)::text as margin_usdt,
           (select e2.client_rate_micro from trade t2 join trade_economics e2 on e2.trade_id = t2.id
             where t2.client_id = c.id order by t2.opened_at desc limit 1) as last_rate_micro,
           max(t.opened_at) as last_activity,
           fs.country as first_country, fs.region as first_region, fs.city as first_city
    from client c
    left join lateral (
      select si.country, si.region, si.city
        from sign_in si join client_user cu on cu.user_id = si.user_id and cu.client_id = c.id
       where si.surface = 'CLIENT'
       order by si.at
       limit 1) fs on true
    left join trade t on t.client_id = c.id
    left join trade_economics e on e.trade_id = t.id
    where (${search}::text = '' or c.display_name ilike ${`${search}%`})
    group by c.id, c.ref, c.display_name, c.status, c.kyc_status, c.typical_direction, c.typical_size_usdt_minor, c.created_at, fs.country, fs.region, fs.city
    order by
      case when ${sort} = 'NEWEST' then c.created_at end desc,
      case when ${sort} = 'ACTIVE' then max(t.opened_at) end desc nulls last,
      case when ${sort} = 'ACTIVE' then c.created_at end desc,
      c.display_name, c.id
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
      joinedAt: r.created_at.toISOString(),
      firstPlace: placeOf({ country: r.first_country, region: r.first_region, city: r.first_city }),
    };
    if (!opts.access?.economics) return row;
    return {
      ...row,
      lastRate: r.last_rate_micro === null ? null : microToDecimal(r.last_rate_micro),
      marginGenerated: Money.ofMinor(BigInt(r.margin), 'INR').toDecimalString(),
      marginGeneratedUsdt: Money.ofMinor(BigInt(r.margin_usdt), 'USDT').toDecimalString(),
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
  /** When the client's record was made: its own sign-up, or the desk adding it. */
  readonly joinedAt: string;
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
  /** What its completed P2P deals earned INRP2P, in USDT. */
  readonly marginGeneratedUsdt?: string;
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
    readonly marginUsdt?: string | null;
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
    .select(['id', 'ref', 'display_name', 'legal_name', 'type', 'status', 'kyc_status', 'typical_direction', 'typical_size_usdt_minor', 'pricing_notes', 'created_at'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!client) throw new DomainError('NOT_FOUND', 'client not found');
  const totals = await sql<{ open_trades: string; completed_trades: string; completed_volume: string; margin: string; margin_usdt: string }>`
    select count(*) filter (where t.lifecycle_state not in ('COMPLETED', 'CANCELLED'))::text as open_trades,
           count(*) filter (where t.lifecycle_state = 'COMPLETED')::text as completed_trades,
           coalesce(sum(e.base_minor) filter (where t.lifecycle_state = 'COMPLETED'), 0)::text as completed_volume,
           coalesce(sum(e.gross_margin_inr_minor) filter (where t.lifecycle_state = 'COMPLETED'), 0)::text as margin,
           coalesce(sum((e.gross_margin_base_minor - coalesce(e.network_fee_base_minor, 0))) filter (where t.lifecycle_state = 'COMPLETED'), 0)::text as margin_usdt
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
    lifecycle_state: string; opened_at: Date; client_rate_micro: bigint; hold: boolean; gross_margin_inr_minor: bigint; margin_usdt_minor: bigint | null;
  }>`
    select t.id, t.ref, t.direction, e.base_minor, e.quote_inr_minor, t.lifecycle_state, t.opened_at, e.client_rate_micro, t.hold, e.gross_margin_inr_minor, (e.gross_margin_base_minor - coalesce(e.network_fee_base_minor, 0)) as margin_usdt_minor
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
    joinedAt: client.created_at.toISOString(),
    legalName: client.legal_name,
    type: client.type,
    typicalDirection: client.typical_direction,
    typicalSize: client.typical_size_usdt_minor === null ? null : Money.ofMinor(client.typical_size_usdt_minor, 'USDT').toDecimalString(),
    pricingNotes: client.pricing_notes,
    stats: {
      openTrades: Number.parseInt(tot.open_trades, 10),
      completedTrades: Number.parseInt(tot.completed_trades, 10),
      completedVolume: Money.ofMinor(BigInt(tot.completed_volume), 'USDT').toDecimalString(),
      ...(access.economics ? { marginGenerated: Money.ofMinor(BigInt(tot.margin), 'INR').toDecimalString(), marginGeneratedUsdt: Money.ofMinor(BigInt(tot.margin_usdt), 'USDT').toDecimalString() } : {}),
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
      ...(access.economics ? { clientRate: microToDecimal(t.client_rate_micro), margin: Money.ofMinor(t.gross_margin_inr_minor, 'INR').toDecimalString(), marginUsdt: t.margin_usdt_minor === null ? null : Money.ofMinor(t.margin_usdt_minor, 'USDT').toDecimalString() } : {}),
    })),
  };
}

export interface ClientSignIn {
  readonly key: string;
  /** Who signed in, masked: the desk tells the client's people apart, it does not need their addresses here. */
  readonly who: string;
  readonly at: string;
  readonly method: 'EMAIL' | 'TELEGRAM' | null;
  /** The address the request came from, as Better Auth resolved it; null when none was recorded. */
  readonly ip: string | null;
  /** Where the edge placed that address (migration 0052); null for a sign-in from before it was recorded. */
  readonly place: Place | null;
  readonly userAgent: string | null;
  /** The session it opened can still be used: not signed out, not expired. */
  readonly live: boolean;
}

export interface ClientAccess {
  /** The first recorded sign-in of any of the client's people — for a client that signed itself up, where it did. */
  readonly first: ClientSignIn | null;
  readonly latest: readonly ClientSignIn[];
}

type SignInRow = { key: string; email: string; telegram_username: string | null; at: Date; method: string | null; ip: string | null; user_agent: string | null; country: string | null; region: string | null; city: string | null; live: boolean };

const TELEGRAM_USERNAME = sql`(select a.telegram_username from auth_account a where a.user_id = u.id and a.provider_id = 'telegram')`;

const signInOf = (r: SignInRow): ClientSignIn => ({
  key: r.key,
  // An account Telegram opened, with no email yet, is shown by its Telegram — never by its placeholder address.
  who: isTelegramPlaceholderEmail(r.email) ? signInLabel(r.email, r.telegram_username) : maskAddress(r.email),
  at: r.at.toISOString(),
  method: r.method === 'EMAIL' || r.method === 'TELEGRAM' ? r.method : null,
  ip: r.ip && r.ip.trim() !== '' ? r.ip.replace(/\/(32|128)$/, '') : null,
  place: placeOf(r),
  userAgent: r.user_agent && r.user_agent.trim() !== '' ? r.user_agent : null,
  live: r.live,
});

/**
 * Where the client's people sign in from: the first recorded sign-in and the latest ones, newest first — when, how, the
 * address, where the edge placed it, the device, and whether the session is still open. Read from `sign_in` (0052),
 * which outlives the sessions; a client with nothing recorded there yet (it signed in before 0052) gets its live
 * sessions instead, with their address and device and no place. Only for a caller who may manage the client (the page
 * asks with `client:manage`).
 */
export async function clientSignIns(ex: Executor, clientId: string, limit = 6): Promise<ClientAccess> {
  const id = requireUuid(clientId, 'clientId');
  const recorded = (order: 'asc' | 'desc', n: number) => sql<SignInRow>`
    select si.id::text as key, u.email, ${TELEGRAM_USERNAME} as telegram_username, si.at, si.method, host(si.ip) as ip, si.user_agent, si.country, si.region, si.city,
           exists (select 1 from auth_session s where s.id = si.session_id and s.expires_at > statement_timestamp()) as live
      from sign_in si
      join client_user cu on cu.user_id = si.user_id and cu.client_id = ${id}
      join auth_user u on u.id = si.user_id
     where si.surface = 'CLIENT'
     order by si.at ${sql.raw(order)}
     limit ${n}`.execute(ex);
  const [latest, first] = await Promise.all([recorded('desc', limit), recorded('asc', 1)]);
  if (latest.rows.length > 0) return { first: first.rows[0] ? signInOf(first.rows[0]) : null, latest: latest.rows.map(signInOf) };
  const sessions = await sql<SignInRow>`
    select s.id::text as key, u.email, ${TELEGRAM_USERNAME} as telegram_username, s.created_at as at, s.sign_in_method as method, s.ip_address as ip, s.user_agent,
           null::text as country, null::text as region, null::text as city, s.expires_at > statement_timestamp() as live
      from auth_session s
      join client_user cu on cu.user_id = s.user_id and cu.client_id = ${id}
      join auth_user u on u.id = s.user_id
     where s.surface = 'CLIENT'
       -- A session made by the product itself (never through a sign-in request) carries neither; it is no sign-in.
       and (s.ip_address is not null or s.user_agent is not null)
     order by s.created_at desc
     limit ${limit}`.execute(ex);
  return { first: null, latest: sessions.rows.map(signInOf) };
}

/**
 * Where each of these clients' people first signed in (migration 0052), for a list that shows many at once — one read
 * for all of them. A client with nothing recorded is left out. Only for a caller who may manage clients.
 */
export async function clientFirstPlaces(ex: Executor, clientIds: readonly string[]): Promise<Readonly<Record<string, Place>>> {
  const ids = [...new Set(clientIds)].map((x) => requireUuid(x, 'clientId'));
  if (ids.length === 0) return {};
  const rows = await sql<{ client_id: string; country: string | null; region: string | null; city: string | null }>`
    select distinct on (cu.client_id) cu.client_id, si.country, si.region, si.city
      from sign_in si
      join client_user cu on cu.user_id = si.user_id
     where cu.client_id = any(${ids}::uuid[]) and si.surface = 'CLIENT'
     order by cu.client_id, si.at`.execute(ex);
  const out: Record<string, Place> = {};
  for (const r of rows.rows) {
    const place = placeOf(r);
    if (place) out[r.client_id] = place;
  }
  return out;
}

/** "treasury@acmepay.test" → "t•••@acmepay.test", as the acceptors list shows people. */
function maskAddress(email: string): string {
  const at = email.indexOf('@');
  return at <= 0 ? '•••' : `${email[0]}•••${email.slice(at)}`;
}
