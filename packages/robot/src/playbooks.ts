import { Money } from '@inrp2p/kernel';
import type { PersonFacts } from './facts.ts';
import type { ExchangeStage, Stage, TraderStage } from './journey.ts';
import { amountWords, rateWords, usdtWords, wholeUsdt } from './format.ts';
import { type RobotWorld, sideTakes } from './world.ts';

/**
 * The robot's playbooks (ADR 0034 §2.3): for each stage a person can be stuck at, whether it is worth a message, when,
 * how many times, and in what words. Each is a pure function of the person's facts and the world's: a figure in a message
 * is a figure of record — the market's fresh reference, the person's own amount, last week's real demand — and when there
 * is nothing true and useful to say, `compose` says nothing.
 *
 * - SERVICE playbooks are about something the person started; they need the person's default consent.
 * - OPPORTUNITY playbooks are about something new for them; they need the person's "tell me everything".
 *
 * Every message ends in one action — the page where it is done — and asks no question it does not need answered.
 */
export interface Draft {
  readonly title: string;
  readonly body: string;
  readonly href: string;
}

export type PlaybookKind = 'SERVICE' | 'OPPORTUNITY';

export interface Playbook {
  readonly key: string;
  readonly track: 'EXCHANGE' | 'TRADER';
  readonly stage: ExchangeStage | TraderStage;
  readonly kind: PlaybookKind;
  /** Hours after the stage began for each attempt; the list's length is how many there are. */
  readonly after: readonly number[];
  /** A stage older than this many days is not started on: a first message never wakes a lead from long ago. */
  readonly freshDays: number;
  /** What the desk reads beside the playbook. */
  readonly label: string;
  /** Who of a client hears it: only someone who can do the thing it asks. */
  readonly audience: (f: PersonFacts) => boolean;
  readonly compose: (f: PersonFacts, s: Stage<string>, w: RobotWorld, attempt: number) => Draft | null;
}

const marketLine = (w: RobotWorld): string | null => {
  const sell = w.market.SELL_USDT;
  const buy = w.market.BUY_USDT;
  if (sell === null || buy === null) return null;
  return `Today's market: sell at ${rateWords(sell)}, buy at ${rateWords(buy)} per USDT.`;
};

const sellReady = (f: PersonFacts) => (f.member?.banksActive ?? 0) > 0;
/** Adding destinations and running the trader programme are an administrator's. */
const admin = (f: PersonFacts) => f.member?.role === 'CLIENT_ADMIN';
/** Asking for and accepting a price: an administrator, or someone with the right to accept (D-01). */
const decider = (f: PersonFacts) => !f.member || f.member.role === 'CLIENT_ADMIN' || f.member.canAcceptQuotes;
/** A request's recovery goes to who asked for it. */
const asker = (f: PersonFacts) => decider(f) && f.member?.lastRequest?.createdBy === f.userId;
const anyone = () => true;
const buyReady = (f: PersonFacts) => (f.member?.walletsActive ?? 0) > 0;

export const PLAYBOOKS: readonly Playbook[] = Object.freeze([
  // ---- the trader programme: someone who wants to provide liquidity is never left half way -------------------------
  {
    key: 'fix_bank_name',
    audience: admin,
    track: 'TRADER',
    stage: 'FIX_BANK_NAME',
    kind: 'SERVICE',
    after: [0.5, 48],
    freshDays: 30,
    label: 'Applicant: bank account in another name',
    compose: () => ({
      title: 'Your bank account needs to be in your name',
      body: 'The bank account on your trader application is in another name. Traders are paid only to an account of their own — add yours, and your review carries on by itself.',
      href: '/traders',
    }),
  },
  {
    key: 'send_reserve',
    audience: admin,
    track: 'TRADER',
    stage: 'RESERVE_DUE',
    kind: 'SERVICE',
    after: [2, 24, 72],
    freshDays: 30,
    label: 'Applicant: Security Reserve not sent',
    compose: (f, _s, w) => {
      const r = f.trader?.reserve;
      if (!r?.required) return null;
      const amount = usdtWords(r.shortfall ?? r.required);
      return {
        title: `Send your ${amount} reserve to go live`,
        body: w.autoReview
          ? `Your trader application is in. Send ${amount} from your registered wallet to your reserve address — you're approved the moment it lands, and it stays yours.`
          : `Your trader application is in. Send ${amount} from your registered wallet to your reserve address — the desk reviews you as soon as it lands, and it stays yours.`,
        href: '/traders/reserve',
      };
    },
  },
  {
    key: 'set_prices',
    audience: admin,
    track: 'TRADER',
    stage: 'NO_PRICE',
    kind: 'SERVICE',
    after: [1, 24, 72],
    freshDays: 30,
    label: 'Approved trader: no price set',
    compose: (f, _s, w) => {
      const t = f.trader!;
      // Demand on the sides this trader offers: a side buying USDT fills clients selling it, and the other way round.
      const asked = (t.offersBuy ? w.demand.SELL_USDT.requests : 0) + (t.offersSell ? w.demand.BUY_USDT.requests : 0);
      const size = (t.offersBuy ? w.demand.SELL_USDT.usdtMinor : 0n) + (t.offersSell ? w.demand.BUY_USDT.usdtMinor : 0n);
      const demand = asked > 0 ? ` Clients asked for ${asked === 1 ? 'a price' : `${asked} prices`} on your side${t.offersBuy && t.offersSell ? 's' : ''} this week${size >= 1_000_000n ? ` — about ${wholeUsdt(size)} USDT` : ''}.` : '';
      return {
        title: "You're approved — set your price",
        body: `Follow the market in one press and go online; orders come to you privately, one at a time.${demand}`,
        href: '/traders/setup',
      };
    },
  },
  // ---- the Exchange: from a sign-in to a first price --------------------------------------------------------------
  {
    key: 'apply_trader',
    audience: anyone,
    track: 'EXCHANGE',
    stage: 'TRADER_LEAD',
    kind: 'SERVICE',
    after: [2, 72],
    freshDays: 30,
    label: 'Signed in from the trader page, never applied',
    compose: (_f, _s, w) => {
      const asked = w.demand.SELL_USDT.requests + w.demand.BUY_USDT.requests;
      return {
        title: 'Finish your trader application',
        body: `Applying takes three short steps: your bank (found from its IFSC), your wallet, the sides you trade.${asked > 0 ? ` ${asked === 1 ? 'A client' : `${asked} clients`} asked for prices this week.` : ''} The rupees land in your bank before any USDT is released.`,
        href: '/traders/apply',
      };
    },
  },
  {
    key: 'open_account',
    audience: anyone,
    track: 'EXCHANGE',
    stage: 'NEW_ACCOUNT',
    kind: 'SERVICE',
    after: [2, 72],
    freshDays: 30,
    label: 'Signed in, no account opened',
    compose: (_f, _s, w, attempt) => {
      const market = marketLine(w);
      return {
        title: attempt === 1 ? 'Your account is one step away' : 'Still want to swap USDT and INR?',
        body: `${attempt === 1 ? 'You signed in but have not opened your account yet. It takes a minute.' : 'Open your account in a minute — nothing is committed until you accept a price.'}${market ? ` ${market}` : ''}`,
        href: '/open-account',
      };
    },
  },
  {
    key: 'add_destination',
    audience: admin,
    track: 'EXCHANGE',
    stage: 'NEEDS_DESTINATION',
    kind: 'SERVICE',
    after: [1, 48],
    freshDays: 30,
    label: 'Account open, nowhere to be paid',
    compose: () => ({
      title: 'Add where you get paid',
      body: 'Your account is open. Add a bank account to sell USDT for rupees, or a TRC20 wallet to buy USDT — then your price comes in seconds.',
      href: '/destinations',
    }),
  },
  {
    key: 'first_request',
    audience: decider,
    track: 'EXCHANGE',
    stage: 'READY',
    kind: 'SERVICE',
    after: [6, 96],
    freshDays: 30,
    label: 'Set up, never asked for a price',
    compose: (f, _s, w) => {
      const sell = sellReady(f);
      const buy = buyReady(f);
      const rate = sell && !buy ? w.market.SELL_USDT : buy && !sell ? w.market.BUY_USDT : null;
      const market = rate !== null ? `Today's market is ${rateWords(rate)} per USDT.` : marketLine(w);
      return {
        title: 'Ready when you are',
        body: `You're set up to ${sell && buy ? 'sell and buy' : sell ? 'sell' : 'buy'} USDT.${market ? ` ${market}` : ''} Ask for a firm price — nothing is committed until you accept it.`,
        href: sell && !buy ? '/exchange?direction=sell' : buy && !sell ? '/exchange?direction=buy' : '/exchange',
      };
    },
  },
  {
    key: 'supply_back',
    audience: asker,
    track: 'EXCHANGE',
    stage: 'UNMATCHED',
    kind: 'SERVICE',
    after: [0],
    freshDays: 7,
    label: 'Request ended unpriced; a trader for it is online now',
    compose: (f, _s, w) => {
      const r = f.member?.lastRequest;
      if (!r || !w.autoQuote) return null;
      if (!sideTakes(w, { direction: r.direction, amount: r.amount, currency: r.currency, excludeClientId: f.member!.clientId })) return null;
      const amount = amountWords(r.amount, r.currency);
      const sell = r.direction === 'SELL_USDT';
      return {
        title: `A trader for ${amount} is online now`,
        body: `Your request to ${sell ? 'sell' : 'buy'} ${amount} ended without a price. A trader who ${sell ? 'buys' : 'sells'} that much is online now — ask again with the same terms in one tap.`,
        href: `/exchange?again=${encodeURIComponent(r.ref)}`,
      };
    },
  },
  {
    key: 'come_back',
    audience: decider,
    track: 'EXCHANGE',
    stage: 'DORMANT',
    kind: 'OPPORTUNITY',
    after: [0],
    freshDays: 120,
    label: 'Traded before, away two weeks',
    compose: (f, _s, w) => {
      const t = f.member?.lastTrade;
      if (!t) return null;
      const sell = t.direction === 'SELL_USDT';
      const today = w.market[t.direction];
      if (today === null) return null;
      if (sell ? !sellReady(f) : !buyReady(f)) return null;
      const base = Money.parse(t.base, 'USDT');
      const amount = base.toDecimalString().replace(/\.?0+$/, '');
      return {
        title: `Today's market: ${rateWords(today)} per USDT`,
        body: `Last time you ${sell ? 'sold' : 'bought'} ${usdtWords(t.base)} at ${rateWords(t.rateMicro)}. ${sell ? 'Sell' : 'Buy'} again in one tap — the same amount is filled in for you.`,
        href: `/exchange?direction=${sell ? 'sell' : 'buy'}&amount=${encodeURIComponent(amount)}`,
      };
    },
  },
]);

/** Liquidity discovery (§2.5): composed per waiting request, not per stage, so it is not in the list above. */
export const DEMAND_MATCH = Object.freeze({ key: 'demand_match', kind: 'OPPORTUNITY' as const, label: 'Someone waits for what this client traded before' });

export const PLAYBOOK_KEYS: ReadonlySet<string> = new Set([...PLAYBOOKS.map((p) => p.key), DEMAND_MATCH.key]);
export const PLAYBOOK_LABELS: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries([...PLAYBOOKS.map((p) => [p.key, p.label]), [DEMAND_MATCH.key, DEMAND_MATCH.label]]));
export const PLAYBOOK_KINDS: Readonly<Record<string, PlaybookKind>> = Object.freeze(Object.fromEntries([...PLAYBOOKS.map((p) => [p.key, p.kind]), [DEMAND_MATCH.key, DEMAND_MATCH.kind]]));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** However the schedule falls, two messages of one playbook are at least this far apart. */
const MIN_GAP_HOURS = 12;

/**
 * Which attempt of a playbook is due for a stage now, counting only the touches of the same mode — so a dry run's
 * rehearsal never uses up the real messages — or null when none is: all were made, the stage is too old to start on, or
 * the next one's hour has not come.
 */
/**
 * A playbook's attempts are counted per subject across the person's whole client: two administrators of one company are
 * not each told about the same request.
 */
export function attemptDue(p: Pick<Playbook, 'key' | 'after' | 'freshDays'>, s: Stage<string>, touches: PersonFacts['touches'], mode: 'LIVE' | 'DRY_RUN', now: Date): number | null {
  const prior = touches.filter((t) => t.playbook === p.key && t.subject === s.subject && t.mode === mode);
  const k = prior.length;
  if (k >= p.after.length) return null;
  const age = now.getTime() - s.since.getTime();
  if (k === 0 && age > p.freshDays * DAY) return null;
  if (age < p.after[k]! * HOUR) return null;
  const latest = prior.reduce<Date | null>((a, t) => (a === null || t.createdAt > a ? t.createdAt : a), null);
  if (latest && now.getTime() - latest.getTime() < MIN_GAP_HOURS * HOUR) return null;
  return k + 1;
}
