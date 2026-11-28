import { sql } from 'kysely';
import { Money, requireUuid } from '@inrp2p/kernel';
import type { AutoReviewFlag, DirectionValue, Executor, TraderSide, TraderStatus } from '@inrp2p/db';
import { TELEGRAM_PROVIDER, isTelegramPlaceholderEmail } from '@inrp2p/identity';
import { reserveFigures, traderProgram } from '@inrp2p/trader-core';
import { type RobotPreference, robotPreferenceOf } from './preference.ts';

/**
 * Everything the robot knows about one person, read from the rows of record and nothing else (ADR 0034 §2.2). The
 * journey, the playbooks, the in-app brief and the answers are pure functions of this; none of them reads the database
 * again, so what the robot says and what it decides always agree with each other.
 *
 * Nothing here is a route rate, a margin, another client or a trader's identity: a person's facts are their own.
 */
export interface PersonFacts {
  readonly userId: string;
  readonly createdAt: Date;
  /** A verified, real address (not the placeholder of an account Telegram opened); null when there is none. */
  readonly email: string | null;
  /** A private chat the robot may write to: the person's linked alerts chat, or — with no account yet — the Telegram they signed in with. */
  readonly telegramChat: string | null;
  /** The person's alerts chat is linked (`telegram_link`), not only their sign-in. */
  readonly telegramLinked: boolean;
  /** A browser of theirs takes notifications. */
  readonly push: boolean;
  readonly lastSeenAt: Date | null;
  /** In the workspace in the last 15 minutes: the robot shows it there instead of writing. */
  readonly activeNow: boolean;
  /** Came in through the trader acquisition page (`acquisition_link`). */
  readonly traderLead: boolean;
  readonly member: MemberFacts | null;
  readonly trader: TraderFacts | null;
  /** When the person (or their whole client) was last told anything in the inbox. */
  readonly lastNotifiedAt: Date | null;
  readonly touches: readonly TouchMemory[];
  readonly preference: RobotPreference;
}

export interface MemberFacts {
  readonly clientId: string;
  readonly clientName: string;
  readonly role: 'CLIENT_ADMIN' | 'CLIENT_TRADER';
  /** May accept a price for the client (D-01). */
  readonly canAcceptQuotes: boolean;
  readonly exchangeAccess: boolean;
  readonly createdAt: Date;
  readonly banksActive: number;
  readonly walletsActive: number;
  readonly pendingReview: number;
  readonly requests: number;
  readonly lastRequest: RequestFacts | null;
  /** A firm price waiting for the client's yes (held for a waiting client, or an ordinary live quote). */
  readonly liveQuote: { readonly ref: string; readonly expiresAt: Date; readonly held: boolean } | null;
  readonly openTrades: readonly OpenTrade[];
  readonly completed: number;
  readonly lastTrade: LastTrade | null;
}

export interface RequestFacts {
  readonly id: string;
  readonly ref: string;
  readonly status: string;
  readonly direction: DirectionValue;
  readonly fixedSide: 'BASE' | 'QUOTE';
  /** The amount in the currency of its fixed side, as a decimal. */
  readonly amount: string;
  readonly currency: 'USDT' | 'INR';
  readonly createdAt: Date;
  readonly closedAt: Date | null;
  readonly waitingUntil: Date | null;
  readonly noPriceReason: string | null;
  readonly peerPaused: boolean;
  /** Who asked: a person of the client, or the desk on its behalf. */
  readonly createdBy: string;
}

export interface OpenTrade {
  readonly ref: string;
  readonly direction: DirectionValue;
  readonly state: string;
  readonly hold: boolean;
  readonly dispute: boolean;
}

export interface LastTrade {
  readonly ref: string;
  readonly direction: DirectionValue;
  readonly base: string;
  readonly inr: string;
  readonly rateMicro: bigint;
  readonly completedAt: Date;
}

export interface TraderFacts {
  readonly id: string;
  readonly ref: string;
  readonly status: Exclude<TraderStatus, 'PERSONAL'>;
  readonly appliedAt: Date;
  readonly approvedAt: Date | null;
  readonly flags: readonly AutoReviewFlag[];
  readonly offersBuy: boolean;
  readonly offersSell: boolean;
  readonly available: boolean;
  readonly sides: readonly { readonly side: TraderSide; readonly priced: boolean; readonly active: boolean }[];
  /** The Security Reserve: what is required, what is still missing, and whether it is in. */
  readonly reserve: { readonly required: string | null; readonly shortfall: string | null; readonly funded: boolean };
}

export interface TouchMemory {
  readonly id: string;
  readonly playbook: string;
  readonly subject: string;
  readonly attempt: number;
  readonly mode: 'LIVE' | 'DRY_RUN';
  readonly title: string;
  readonly createdAt: Date;
  readonly actedAt: Date | null;
  /** To this person; otherwise to another person of the same client (counted once per client, never as this person's). */
  readonly mine: boolean;
}

const ACTIVE_WINDOW_MINUTES = 15;
const TOUCH_MEMORY_DAYS = 90;

/** The facts of one person; null when the account is not an active client-side person. */
export async function personFacts(ex: Executor, userId: string): Promise<PersonFacts | null> {
  const id = requireUuid(userId, 'userId');
  const user = await ex.selectFrom('auth_user as u')
    .leftJoin('client_user as cu', (j) => j.onRef('cu.user_id', '=', 'u.id').on('cu.status', '=', 'ACTIVE'))
    .leftJoin('client as c', (j) => j.onRef('c.id', '=', 'cu.client_id').on('c.status', '=', 'ACTIVE'))
    .leftJoin('auth_account as tg', (j) => j.onRef('tg.user_id', '=', 'u.id').on('tg.provider_id', '=', TELEGRAM_PROVIDER))
    .select([
      'u.id', 'u.email', 'u.email_verified', 'u.kind', 'u.status', 'u.created_at', 'tg.account_id as tg_account',
      'cu.id as client_user_id', 'cu.role', 'cu.can_accept_quotes', 'c.id as client_id', 'c.display_name', 'c.exchange_access', 'c.created_at as client_created_at',
    ])
    .where('u.id', '=', id)
    .executeTakeFirst();
  if (!user || user.kind !== 'CLIENT' || user.status !== 'ACTIVE') return null;

  const clientId = user.client_id;
  const clientUserId = user.client_user_id;
  const [presence, link, push, lead, touches, preference] = await Promise.all([
    sql<{ last_seen: Date | null; active: boolean }>`
      select greatest((select max(a.last_activity_at) from session_activity a join auth_session s on s.id = a.session_id where s.user_id = ${id}::uuid),
                      (select max(at) from sign_in where user_id = ${id}::uuid)) as last_seen,
             exists (select 1 from session_activity a join auth_session s on s.id = a.session_id
                      where s.user_id = ${id}::uuid and s.surface = 'CLIENT'
                        and a.last_activity_at > inrp2p_now() - make_interval(mins => ${ACTIVE_WINDOW_MINUTES})) as active`.execute(ex),
    clientUserId
      ? ex.selectFrom('telegram_link').select('chat_id').where('client_user_id', '=', clientUserId).where('status', '=', 'ACTIVE').where('chat_id', 'is not', null).orderBy('linked_at', 'desc').executeTakeFirst()
      : Promise.resolve(undefined),
    clientUserId
      ? ex.selectFrom('push_subscription').select('id').where('client_user_id', '=', clientUserId).where('status', '=', 'ACTIVE').executeTakeFirst()
      : Promise.resolve(undefined),
    ex.selectFrom('acquisition_link').select('visitor_id').where('user_id', '=', id).executeTakeFirst(),
    ex.selectFrom('robot_touch').select(['id', 'user_id', 'playbook', 'subject', 'attempt', 'mode', 'title', 'created_at', 'acted_at'])
      .where((eb) => (user.client_id ? eb.or([eb('user_id', '=', id), eb('client_id', '=', user.client_id)]) : eb('user_id', '=', id)))
      .where('created_at', '>', sql<Date>`inrp2p_now() - make_interval(days => ${TOUCH_MEMORY_DAYS})`)
      .orderBy('created_at', 'desc').limit(100).execute(),
    robotPreferenceOf(ex, id),
  ]);

  const [member, trader, notified] = clientId
    ? await Promise.all([
        user.exchange_access !== null ? memberFacts(ex, clientId, user.display_name!, user.role === 'CLIENT_ADMIN' ? 'CLIENT_ADMIN' : 'CLIENT_TRADER', user.can_accept_quotes === true, user.exchange_access, user.client_created_at!) : Promise.resolve(null),
        traderFacts(ex, clientId),
        ex.selectFrom('client_notification').select((eb) => eb.fn.max('created_at').as('at'))
          .where('client_id', '=', clientId).where((eb) => eb.or([eb('user_id', 'is', null), eb('user_id', '=', id)])).executeTakeFirst(),
      ])
    : [null, null, undefined];

  const realEmail = user.email_verified && !isTelegramPlaceholderEmail(user.email) ? user.email : null;
  // A member's alerts chat is the one they linked (and may have stopped); someone with no account yet has only the
  // Telegram they signed in with, which the bot already wrote to when it was connected.
  const telegramChat = clientId ? (link?.chat_id?.toString() ?? null) : (user.tg_account ?? null);
  return {
    userId: id,
    createdAt: user.created_at,
    email: realEmail,
    telegramChat,
    telegramLinked: link !== undefined,
    push: push !== undefined,
    lastSeenAt: presence.rows[0]?.last_seen ?? null,
    activeNow: presence.rows[0]?.active ?? false,
    traderLead: lead !== undefined,
    member,
    trader,
    lastNotifiedAt: (notified?.at as Date | null | undefined) ?? null,
    touches: touches.map((t) => ({ id: t.id, playbook: t.playbook, subject: t.subject, attempt: t.attempt, mode: t.mode, title: t.title, createdAt: t.created_at, actedAt: t.acted_at, mine: t.user_id === id })),
    preference,
  };
}

async function memberFacts(ex: Executor, clientId: string, clientName: string, role: MemberFacts['role'], canAcceptQuotes: boolean, exchangeAccess: boolean, createdAt: Date): Promise<MemberFacts> {
  const [dest, requests, last, open, done, lastTrade] = await Promise.all([
    sql<{ banks: string; wallets: string; pending: string }>`
      select (select count(*) from bank_account where client_id = ${clientId}::uuid and status = 'ACTIVE')::text as banks,
             (select count(*) from crypto_wallet where client_id = ${clientId}::uuid and status = 'ACTIVE' and purpose <> 'SOURCE')::text as wallets,
             ((select count(*) from bank_account where client_id = ${clientId}::uuid and status = 'PENDING_REVIEW')
              + (select count(*) from crypto_wallet where client_id = ${clientId}::uuid and status = 'PENDING_REVIEW'))::text as pending`.execute(ex),
    ex.selectFrom('trade_request').select((eb) => eb.fn.countAll<string>().as('n')).where('client_id', '=', clientId).where('desk_id', 'is', null).executeTakeFirstOrThrow(),
    ex.selectFrom('trade_request')
      .select(['id', 'ref', 'status', 'direction', 'fixed_side', 'requested_base_minor', 'requested_quote_minor', 'created_at', 'closed_at', 'waiting_until', 'no_price_reason', 'peer_paused_at', 'created_by'])
      .where('client_id', '=', clientId).where('desk_id', 'is', null)
      .orderBy('created_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst(),
    ex.selectFrom('trade as t')
      .select(['t.ref', 't.direction', 't.lifecycle_state', 't.hold'])
      .select((eb) => eb.exists(eb.selectFrom('p2p_dispute as d').select('d.id').whereRef('d.trade_id', '=', 't.id').where('d.status', '=', 'OPEN')).as('dispute'))
      .where('t.client_id', '=', clientId).where('t.lifecycle_state', 'not in', ['COMPLETED', 'CANCELLED'])
      .orderBy('t.opened_at', 'desc').limit(8).execute(),
    ex.selectFrom('trade').select((eb) => eb.fn.countAll<string>().as('n')).where('client_id', '=', clientId).where('lifecycle_state', '=', 'COMPLETED').executeTakeFirstOrThrow(),
    ex.selectFrom('trade as t').innerJoin('trade_economics as e', 'e.trade_id', 't.id')
      .select(['t.ref', 't.direction', 't.completed_at', 'e.base_minor', 'e.quote_inr_minor', 'e.client_rate_micro'])
      .where('t.client_id', '=', clientId).where('t.lifecycle_state', '=', 'COMPLETED')
      .orderBy('t.completed_at', 'desc').limit(1).executeTakeFirst(),
  ]);
  const liveQuote = last && (last.status === 'OPEN' || last.status === 'QUOTED')
    ? await ex.selectFrom('quote as q').leftJoin('auto_quote as a', 'a.quote_id', 'q.id').select(['q.ref', 'q.expires_at', 'a.held'])
      .where('q.trade_request_id', '=', last.id).where('q.status', '=', 'SENT').where('q.expires_at', '>', sql<Date>`inrp2p_now()`)
      .orderBy('q.created_at', 'desc').limit(1).executeTakeFirst()
    : undefined;
  return {
    clientId,
    clientName,
    role,
    canAcceptQuotes,
    exchangeAccess,
    createdAt,
    banksActive: Number.parseInt(dest.rows[0]!.banks, 10),
    walletsActive: Number.parseInt(dest.rows[0]!.wallets, 10),
    pendingReview: Number.parseInt(dest.rows[0]!.pending, 10),
    requests: Number.parseInt(requests.n, 10),
    lastRequest: last
      ? {
          id: last.id, ref: last.ref, status: last.status, direction: last.direction, fixedSide: last.fixed_side,
          amount: last.fixed_side === 'BASE' ? Money.ofMinor(last.requested_base_minor!, 'USDT').toDecimalString() : Money.ofMinor(last.requested_quote_minor!, 'INR').toDecimalString(),
          currency: last.fixed_side === 'BASE' ? 'USDT' : 'INR',
          createdAt: last.created_at, closedAt: last.closed_at, waitingUntil: last.waiting_until, noPriceReason: last.no_price_reason, peerPaused: last.peer_paused_at !== null, createdBy: last.created_by,
        }
      : null,
    liveQuote: liveQuote?.expires_at ? { ref: liveQuote.ref, expiresAt: liveQuote.expires_at, held: liveQuote.held === true } : null,
    openTrades: open.map((t) => ({ ref: t.ref, direction: t.direction, state: t.lifecycle_state, hold: t.hold, dispute: Boolean(t.dispute) })),
    completed: Number.parseInt(done.n, 10),
    lastTrade: lastTrade
      ? {
          ref: lastTrade.ref, direction: lastTrade.direction, completedAt: lastTrade.completed_at ?? new Date(0),
          base: Money.ofMinor(lastTrade.base_minor, 'USDT').toDecimalString(), inr: Money.ofMinor(lastTrade.quote_inr_minor, 'INR').toDecimalString(),
          rateMicro: lastTrade.client_rate_micro,
        }
      : null,
  };
}

async function traderFacts(ex: Executor, clientId: string): Promise<TraderFacts | null> {
  const t = await ex.selectFrom('trader_profile')
    .select(['id', 'ref', 'status', 'applied_at', 'approved_at', 'auto_review_flags', 'offers_buy', 'offers_sell', 'available'])
    .where('client_id', '=', clientId).where('status', '<>', 'PERSONAL').executeTakeFirst();
  if (!t || t.status === 'PERSONAL') return null;
  const [blocks, reserve, program] = await Promise.all([
    ex.selectFrom('trader_block').select(['side', 'status', 'rate_basis', 'rate_micro', 'market_offset_bps']).where('trader_id', '=', t.id).execute(),
    reserveFigures(ex, t.id),
    traderProgram(ex),
  ]);
  // An applicant's reserve is the programme's until the desk sets one of its own (ADR 0024: named before anyone applies).
  const required = reserve.required ?? program.defaultRequiredReserve;
  const free = reserve.balance.minor - reserve.pendingRelease.minor - reserve.applying.minor;
  const shortfall = required === null ? null : required.minor > free ? Money.ofMinor(required.minor - (free > 0n ? free : 0n), 'USDT') : null;
  return {
    id: t.id,
    ref: t.ref,
    status: t.status,
    appliedAt: t.applied_at,
    approvedAt: t.approved_at,
    flags: t.auto_review_flags,
    offersBuy: t.offers_buy,
    offersSell: t.offers_sell,
    available: t.available,
    sides: blocks.map((b) => ({
      side: b.side,
      priced: b.rate_basis === 'MARKET' ? b.market_offset_bps !== null : b.rate_micro !== null,
      active: b.status === 'ACTIVE',
    })),
    reserve: {
      required: required?.toDecimalString() ?? null,
      shortfall: shortfall?.toDecimalString() ?? null,
      funded: required !== null && shortfall === null,
    },
  };
}
