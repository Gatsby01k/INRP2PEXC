import type { PersonFacts } from './facts.ts';

/**
 * Where a person is on their way through INRP2P (ADR 0034 §2.2), as a pure function of their facts. Two tracks, because
 * one person can be both: the Exchange (a client asking for prices) and the trader programme (providing them).
 *
 * A stage says what is true now and since when. It never guesses intent: "ready, never asked" is a fact; "probably wants
 * to sell" is not, and is never a stage.
 */
export type ExchangeStage =
  /** Signed in, no account opened. */
  | 'NEW_ACCOUNT'
  /** Signed in from the trader page, never applied. */
  | 'TRADER_LEAD'
  /** An account, nowhere to be paid. */
  | 'NEEDS_DESTINATION'
  /** Its only destinations wait for the desk to verify them: the desk's to do, not the person's. */
  | 'DESTINATION_IN_REVIEW'
  /** Set up, never asked for a price. */
  | 'READY'
  /** Asked; the desk prices it (automatic prices off), or a price request runs. */
  | 'PRICING'
  /** Asked; nothing priced it yet and the exchange keeps looking (ADR 0032). */
  | 'WAITING'
  /** A firm price waits for the client's yes. */
  | 'PRICE_READY'
  /** Its last request ended without a price, and nothing newer was asked. */
  | 'UNMATCHED'
  /** A trade is under way. */
  | 'IN_DEAL'
  /** Has traded, and was here in the last two weeks. */
  | 'ACTIVE'
  /** Has traded, and has not been back for two weeks or more. */
  | 'DORMANT'
  /** Asked before, nothing open, nothing to recover. */
  | 'IDLE';

export type TraderStage =
  /** Applied; the Security Reserve is not in. */
  | 'RESERVE_DUE'
  /** Applied; the bank account is in another name — the applicant can fix it. */
  | 'FIX_BANK_NAME'
  /** Applied; waiting for a person at INRP2P (a flag a rule could not settle, or reviews by hand). */
  | 'IN_REVIEW'
  /** Approved, no price on any side. */
  | 'NO_PRICE'
  /** Approved, priced, offline. */
  | 'OFFLINE'
  /** Approved, priced, online. */
  | 'LIVE'
  | 'PAUSED'
  | 'REJECTED';

export interface Stage<S extends string> {
  readonly stage: S;
  /** Since when it has been true, as far as the record can say. */
  readonly since: Date;
  /** What it is about — a request's reference, the account — so a playbook's attempts are counted per thing. */
  readonly subject: string;
}

export interface Journey {
  readonly exchange: Stage<ExchangeStage> | null;
  readonly trader: Stage<TraderStage> | null;
}

/** Two weeks without a visit makes a client who has traded "away". */
export const DORMANT_DAYS = 14;
/** A request that ended unpriced is worth recovering for a week. */
export const UNMATCHED_DAYS = 7;

const DAY = 86_400_000;
const OPEN_REQUEST = new Set(['OPEN', 'QUOTED']);
const UNPRICED_END = new Set(['DECLINED', 'EXPIRED']);

export function exchangeStage(f: PersonFacts, now: Date): Stage<ExchangeStage> | null {
  const m = f.member;
  if (!m) return f.traderLead ? { stage: 'TRADER_LEAD', since: f.createdAt, subject: 'apply' } : { stage: 'NEW_ACCOUNT', since: f.createdAt, subject: 'account' };
  if (!m.exchangeAccess) return null;
  if (m.openTrades.length > 0) return { stage: 'IN_DEAL', since: now, subject: m.openTrades[0]!.ref };
  const last = m.lastRequest;
  if (m.liveQuote) return { stage: 'PRICE_READY', since: now, subject: m.liveQuote.ref };
  if (last && OPEN_REQUEST.has(last.status)) {
    return last.waitingUntil ? { stage: 'WAITING', since: last.createdAt, subject: last.ref } : { stage: 'PRICING', since: last.createdAt, subject: last.ref };
  }
  if (m.banksActive === 0 && m.walletsActive === 0) {
    return m.pendingReview > 0 ? { stage: 'DESTINATION_IN_REVIEW', since: m.createdAt, subject: 'destination' } : { stage: 'NEEDS_DESTINATION', since: m.createdAt, subject: 'destination' };
  }
  if (m.requests === 0) return { stage: 'READY', since: m.createdAt, subject: 'first_request' };
  // Ended by the system without a price (declined unpriced, or its wait ran out) — not withdrawn by the client — in the
  // last week, and nothing traded since.
  const unmatched = last !== null && UNPRICED_END.has(last.status) && last.noPriceReason !== null && last.closedAt !== null
    && now.getTime() - last.closedAt.getTime() < UNMATCHED_DAYS * DAY
    && (m.lastTrade === null || last.closedAt > m.lastTrade.completedAt);
  if (unmatched) return { stage: 'UNMATCHED', since: last.closedAt!, subject: last.ref };
  if (m.lastTrade) {
    const seen = f.lastSeenAt && f.lastSeenAt > m.lastTrade.completedAt ? f.lastSeenAt : m.lastTrade.completedAt;
    return now.getTime() - seen.getTime() >= DORMANT_DAYS * DAY
      ? { stage: 'DORMANT', since: seen, subject: `away:${m.lastTrade.ref}` }
      : { stage: 'ACTIVE', since: m.lastTrade.completedAt, subject: m.lastTrade.ref };
  }
  return { stage: 'IDLE', since: last?.closedAt ?? last?.createdAt ?? m.createdAt, subject: last?.ref ?? 'idle' };
}

export function traderStage(f: PersonFacts): Stage<TraderStage> | null {
  const t = f.trader;
  if (!t) return null;
  const subject = t.ref;
  switch (t.status) {
    case 'REJECTED':
      return { stage: 'REJECTED', since: t.appliedAt, subject };
    case 'PAUSED':
      return { stage: 'PAUSED', since: t.approvedAt ?? t.appliedAt, subject };
    case 'UNDER_REVIEW':
      if (t.flags.includes('BANK_NAME_MISMATCH')) return { stage: 'FIX_BANK_NAME', since: t.appliedAt, subject };
      // The reserve is due only once the programme says how much it is; without an amount the desk decides first.
      if (!t.reserve.funded && t.reserve.required !== null) return { stage: 'RESERVE_DUE', since: t.appliedAt, subject };
      return { stage: 'IN_REVIEW', since: t.appliedAt, subject };
    case 'APPROVED': {
      const since = t.approvedAt ?? t.appliedAt;
      if (!t.sides.some((s) => s.priced)) return { stage: 'NO_PRICE', since, subject };
      return t.available ? { stage: 'LIVE', since, subject } : { stage: 'OFFLINE', since, subject };
    }
    default:
      return null;
  }
}

export function journeyOf(f: PersonFacts, now: Date): Journey {
  return { exchange: exchangeStage(f, now), trader: traderStage(f) };
}
