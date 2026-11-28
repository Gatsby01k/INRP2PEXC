import { createHash } from 'node:crypto';
import type { Executor, RobotConsent } from '@inrp2p/db';
import { waitingFactsOf } from '@inrp2p/quotes';
import { type PersonFacts, personFacts } from './facts.ts';
import { type Journey, journeyOf } from './journey.ts';
import { PLAYBOOKS, type Draft } from './playbooks.ts';
import { amountWords, istWhen, rateWords, usdtWords } from './format.ts';
import { type RobotWorld, loadWorld } from './world.ts';

/**
 * The robot in the workspace (ADR 0034 §2.7): the one thing that matters to this person now, what the robot is doing for
 * them meanwhile, and what it remembers — as data the masthead's robot draws. Pure over the person's facts and the world,
 * like the playbooks, so the page and the messages never disagree; every figure is a figure of record.
 *
 * The order is the order of what matters: a deal waiting on them, a price waiting for their yes, a search the robot runs
 * for them, a step on their own way in, and only then the market and their history.
 */
export type RobotMood = 'ready' | 'waiting' | 'focused' | 'verifying' | 'success' | 'alert';
/** The face the small robot makes — its eyes on the visor. */
export type RobotFace = 'calm' | 'happy' | 'look' | 'dots' | 'alert' | 'star' | 'heart' | 'sleep';

export interface RobotAction {
  readonly label: string;
  readonly href: string;
}

export interface RobotBrief {
  /** Stable for as long as what the robot says stays the same; a new key is news. */
  readonly key: string;
  readonly isNew: boolean;
  readonly kind: 'MOVE' | 'PRICE' | 'SEARCH' | 'STEP' | 'DEAL' | 'REST';
  readonly mood: RobotMood;
  readonly face: RobotFace;
  /** A few characters for the visor. */
  readonly visor: string;
  readonly title: string;
  readonly body: string;
  readonly action: RobotAction | null;
  /** The playbook behind a step, so "Not now" can rest it. */
  readonly playbook: string | null;
  /** What the robot is doing for them while they are away, in one line; null when nothing. */
  readonly working: string | null;
  /** What it remembers that is worth saying: their last deal, its last message, the desk's answer. */
  readonly remembers: readonly string[];
  readonly consent: RobotConsent;
  readonly reach: { readonly telegram: boolean; readonly email: boolean; readonly push: boolean };
  readonly question: { readonly ref: string; readonly status: 'OPEN' | 'ANSWERED'; readonly question: string; readonly answer: string | null } | null;
}

/** A deal waiting on the person, as the workspace's bar already reads it (`LiveDeal` in the web app). */
export interface DealWaiting {
  readonly ref: string;
  readonly href: string;
  readonly move: string;
  readonly dueBy: string | null;
  readonly more: number;
}

const keyOf = (...parts: readonly string[]): string => createHash('sha256').update(parts.join('|')).digest('base64url').slice(0, 22);

/** When, in India's calendar: "within the hour", "today", "yesterday", "3 days ago". */
const relative = (from: Date, now: Date): string => {
  if (now.getTime() - from.getTime() < 60 * 60_000) return 'within the hour';
  const day = (d: Date) => {
    const t = d.getTime() + 330 * 60_000;
    return (t - (t % 86_400_000)) / 86_400_000;
  };
  const days = day(now) - day(from);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
};

const ageDate = (d: Date): string => {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ist = new Date(d.getTime() + 330 * 60_000);
  return `${ist.getUTCDate()} ${months[ist.getUTCMonth()]}`;
};

function stepFrom(f: PersonFacts, j: Journey, w: RobotWorld): { draft: Draft; playbook: string; mood: RobotMood; face: RobotFace } | null {
  const now = w.now.getTime();
  for (const p of PLAYBOOKS) {
    const s = p.track === 'TRADER' ? j.trader : j.exchange;
    if (!s || s.stage !== p.stage || !p.audience(f)) continue;
    // The page shows a step whatever the message schedule — but not one the person said "not now" to.
    const snoozed = f.preference.snoozed[p.key];
    if (snoozed && Date.parse(snoozed) > now) continue;
    // An opportunity is shown only to someone who asked to hear of them, on the page as in a message.
    if (p.kind === 'OPPORTUNITY' && f.preference.outreach !== 'ALL') continue;
    const draft = p.compose(f, s, w, 1);
    if (!draft) continue;
    const mood: RobotMood = p.key === 'fix_bank_name' ? 'alert' : p.key === 'supply_back' ? 'focused' : 'ready';
    const face: RobotFace = p.key === 'fix_bank_name' ? 'alert' : p.key === 'supply_back' ? 'star' : p.key === 'come_back' ? 'heart' : 'look';
    return { draft, playbook: p.key, mood, face };
  }
  return null;
}

/** Where the robot will tell them, in their words. */
function reachWords(f: PersonFacts): string {
  if (f.telegramLinked) return 'on Telegram';
  if (f.push) return 'in this browser';
  if (f.email) return 'by email';
  return 'here';
}

export async function robotBriefOf(ex: Executor, userId: string, opts: { deal?: DealWaiting | null; world?: RobotWorld } = {}): Promise<RobotBrief | null> {
  const f = await personFacts(ex, userId);
  if (!f) return null;
  const w = opts.world ?? (await loadWorld(ex));
  const question = await ex.selectFrom('robot_case').select(['ref', 'status', 'question', 'answer', 'answered_at', 'created_at'])
    .where('user_id', '=', f.userId).where('status', 'in', ['OPEN', 'ANSWERED'])
    .where('created_at', '>', new Date(w.now.getTime() - 30 * 86_400_000))
    .orderBy('created_at', 'desc').limit(1).executeTakeFirst();
  const waiting = f.member?.lastRequest?.waitingUntil && (f.member.lastRequest.status === 'OPEN' || f.member.lastRequest.status === 'QUOTED')
    ? await waitingFactsOf(ex, f.member.lastRequest.id)
    : null;
  return briefFrom(f, journeyOf(f, w.now), w, {
    deal: opts.deal ?? null,
    tradersOnline: waiting?.tradersOnline ?? null,
    question: question ? { ref: question.ref, status: question.status === 'ANSWERED' ? 'ANSWERED' : 'OPEN', question: question.question, answer: question.answer } : null,
  });
}

export function briefFrom(
  f: PersonFacts,
  j: Journey,
  w: RobotWorld,
  extra: { readonly deal: DealWaiting | null; readonly tradersOnline: number | null; readonly question: RobotBrief['question'] },
): RobotBrief {
  const remembers: string[] = [];
  if (extra.question?.status === 'ANSWERED') remembers.push(`The desk answered your question (${extra.question.ref}).`);
  else if (extra.question) remembers.push(`Your question is with the desk (${extra.question.ref}) — the answer comes ${reachWords(f)}.`);
  const lastNote = f.touches.find((t) => t.mine && t.mode === 'LIVE');
  if (lastNote && w.now.getTime() - lastNote.createdAt.getTime() < 7 * 86_400_000) remembers.push(`I wrote to you ${relative(lastNote.createdAt, w.now)}: “${lastNote.title}”.`);
  const last = f.member?.lastTrade;
  if (last && last.completedAt.getTime() > 0) {
    remembers.push(`Your last deal: ${last.direction === 'SELL_USDT' ? 'sold' : 'bought'} ${usdtWords(last.base)} at ${rateWords(last.rateMicro)} on ${ageDate(last.completedAt)}.`);
  }
  const common = {
    remembers: remembers.slice(0, 3),
    consent: f.preference.outreach,
    reach: { telegram: f.telegramLinked || (!f.member && f.telegramChat !== null), email: f.email !== null, push: f.push },
    question: extra.question,
  };
  const make = (kind: RobotBrief['kind'], parts: Omit<RobotBrief, 'key' | 'isNew' | 'kind' | keyof typeof common>): RobotBrief => {
    const key = keyOf(kind, parts.title, parts.body, extra.question?.status ?? '');
    return { key, isNew: key !== f.preference.seenKey, kind, ...parts, ...common };
  };

  // 1. A deal waits on them: the bar already shows it; the robot looks at it with them.
  if (extra.deal) {
    const d = extra.deal;
    const until = d.dueBy ? ` by ${istWhen(new Date(d.dueBy), w.now)}` : '';
    return make('MOVE', {
      mood: 'focused', face: 'alert', visor: 'YOUR MOVE', playbook: null, working: null,
      title: `Your move: ${d.move}`,
      body: `${d.ref} is waiting on you${until}.${d.more > 0 ? ` ${d.more === 1 ? 'One more deal waits' : `${d.more} more deals wait`} on you too.` : ''} The USDT stays locked in escrow until the rupees are confirmed.`,
      action: { label: 'Open the deal', href: d.href },
    });
  }
  const m = f.member;
  const ex = j.exchange;
  // 2. A firm price waits for their yes.
  if (m?.liveQuote) {
    return make('PRICE', {
      mood: 'focused', face: 'star', visor: 'PRICE ✓', playbook: null, working: null,
      title: m.liveQuote.held ? 'I found you a price' : 'Your price is ready',
      body: `It is held for you until ${istWhen(m.liveQuote.expiresAt, w.now)}. Nothing is committed until you accept it.`,
      action: { label: 'See the price', href: '/exchange' },
    });
  }
  // 3. The robot is looking for them.
  if (ex?.stage === 'WAITING' && m?.lastRequest) {
    const r = m.lastRequest;
    const online = extra.tradersOnline;
    return make('SEARCH', {
      mood: 'waiting', face: 'dots', visor: 'SEARCHING', playbook: null,
      working: `Looking for a trader for ${amountWords(r.amount, r.currency)} until ${istWhen(r.waitingUntil!, w.now)}.`,
      title: `Finding a trader for ${amountWords(r.amount, r.currency)}`,
      body: `${online === null ? '' : online === 0 ? 'No trader with that side is online right now. ' : `${online === 1 ? 'One trader' : `${online} traders`} with that side ${online === 1 ? 'is' : 'are'} online. `}The moment one prices it, I hold the price for you and tell you ${reachWords(f)}.${r.peerPaused ? ' Your request is paused for other clients — say you are still looking on the Exchange.' : ''}`,
      action: { label: 'See your request', href: '/exchange' },
    });
  }
  if (ex?.stage === 'PRICING' && m?.lastRequest) {
    return make('SEARCH', {
      mood: 'waiting', face: 'dots', visor: 'PRICING', playbook: null, working: `The desk is pricing ${m.lastRequest.ref}.`,
      title: 'The desk is pricing your request',
      body: `Your firm price appears on the Exchange as soon as it is sent, and I tell you ${reachWords(f)}.`,
      action: { label: 'See your request', href: '/exchange' },
    });
  }
  if (ex?.stage === 'IN_DEAL' && m) {
    const t = m.openTrades[0]!;
    return make('DEAL', {
      mood: t.dispute || t.hold ? 'alert' : 'verifying', face: t.dispute || t.hold ? 'alert' : 'calm', visor: t.ref.replace(/-\d{6}-/, '-'), playbook: null,
      working: `Watching ${t.ref} for you.`,
      title: t.dispute ? `INRP2P is checking ${t.ref}` : t.hold ? `${t.ref} is paused for a check` : `${t.ref} is moving`,
      body: t.dispute
        ? 'A payment is in dispute. INRP2P decides it from both sides’ evidence; the USDT stays locked in escrow meanwhile.'
        : t.hold
          ? 'INRP2P is checking something on it. Nothing is lost, and it moves on as soon as the check is done.'
          : `Nothing is needed from you right now. I tell you ${reachWords(f)} the moment it is your move.`,
      action: { label: 'Open the deal', href: `/trades/${t.ref}` },
    });
  }
  // 4. A step on their own way in — trader steps first, then the Exchange's.
  const tr = j.trader;
  if (tr?.stage === 'IN_REVIEW') {
    return make('STEP', {
      mood: 'waiting', face: 'dots', visor: 'IN REVIEW', playbook: null, working: 'Your trader application is with the desk.',
      title: 'Your application is with the desk',
      body: 'Everything that rules can check is checked. A person at INRP2P looks at the rest — you are told the moment it is decided.',
      action: { label: 'Your application', href: '/traders' },
    });
  }
  const step = stepFrom(f, j, w);
  if (step) {
    return make('STEP', {
      mood: step.mood, face: step.face, visor: step.playbook === 'supply_back' ? 'ONLINE NOW' : 'NEXT STEP', playbook: step.playbook, working: null,
      title: step.draft.title, body: step.draft.body,
      action: { label: actionLabel(step.playbook), href: step.draft.href },
    });
  }
  if (ex?.stage === 'DESTINATION_IN_REVIEW') {
    return make('STEP', {
      mood: 'waiting', face: 'dots', visor: 'CHECKING', playbook: null, working: 'The desk is verifying where you get paid.',
      title: 'Your payout details are being checked',
      body: 'A person at INRP2P verifies them; you can ask for prices as soon as they are active.',
      action: { label: 'Bank & wallets', href: '/destinations' },
    });
  }
  if (tr?.stage === 'OFFLINE') {
    return make('STEP', {
      mood: 'ready', face: 'sleep', visor: 'OFFLINE', playbook: null, working: null,
      title: 'You are offline',
      body: 'Your prices are set. Go online when you can take orders; I tell you when a client waits for a price on your side.',
      action: { label: 'Go online', href: '/traders' },
    });
  }
  // 5. Rest: the market, and what they did last.
  const sell = w.market.SELL_USDT;
  const buy = w.market.BUY_USDT;
  return make('REST', {
    mood: 'ready', face: tr?.stage === 'LIVE' ? 'happy' : 'calm', visor: sell !== null ? rateWords(sell) : 'HI!', playbook: null,
    working: tr?.stage === 'LIVE' ? 'You are online: orders on your side come to you.' : null,
    title: tr?.stage === 'LIVE' ? 'You are online' : 'All quiet',
    body: sell !== null && buy !== null ? `Today's market: sell at ${rateWords(sell)}, buy at ${rateWords(buy)} per USDT.` : 'Nothing needs you right now.',
    action: m?.exchangeAccess ? { label: 'Ask for a price', href: '/exchange' } : null,
  });
}

function actionLabel(playbook: string): string {
  switch (playbook) {
    case 'fix_bank_name': return 'Change the bank account';
    case 'send_reserve': return 'Send the reserve';
    case 'set_prices': return 'Set my price';
    case 'apply_trader': return 'Finish applying';
    case 'open_account': return 'Open my account';
    case 'add_destination': return 'Add bank or wallet';
    case 'first_request': return 'Ask for a price';
    case 'supply_back': return 'Ask again';
    case 'come_back': return 'Fill it in';
    default: return 'Open';
  }
}
