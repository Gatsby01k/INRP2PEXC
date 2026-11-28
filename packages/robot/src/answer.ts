import { sql } from 'kysely';
import { DomainError } from '@inrp2p/kernel';
import type { Db } from '@inrp2p/db';
import { type MindAnswer, type RobotMind } from '@inrp2p/adapters';
import { waitingFactsOf } from '@inrp2p/quotes';
import { type RobotAction, type RobotBrief, briefFrom } from './brief.ts';
import { openCase } from './cases.ts';
import { type PersonFacts, personFacts } from './facts.ts';
import { journeyOf } from './journey.ts';
import { PLAYBOOKS } from './playbooks.ts';
import { currentRobotPolicy } from './policy.ts';
import { amountWords, rateWords } from './format.ts';
import { type RobotWorld, loadWorld } from './world.ts';

/**
 * The robot answers a person's question (ADR 0034 §2.8) — in the app, or in the bot's chat — from what is true for that
 * person now. Rules first: most questions are one of a dozen ("where is my money", "what's the rate", "how do I sell"),
 * and the answer to each is the person's own state in words. Only a question no rule recognises goes to the model, and
 * only when the owner switched it on and today's limit is not spent; its answer is checked before anyone reads it.
 * Whatever is left — and anything that needs a decision — goes to a person at INRP2P, and the robot says so plainly.
 *
 * The robot never decides a dispute, a payment, a review or a refund, and never asks for a code, a password or a key.
 */
export type Intent =
  | 'HUMAN' | 'PAYMENT_ISSUE' | 'STATUS' | 'RATE' | 'HOW_SELL' | 'HOW_BUY' | 'FEES' | 'SAFETY' | 'TIME' | 'LIMITS'
  | 'TRADER' | 'ACCOUNT' | 'DOCUMENTS' | 'GREETING' | 'THANKS' | 'HELP' | 'UNKNOWN';

/** Each intent's words, in English and the Hinglish people actually type; the first that matches wins. */
const PATTERNS: readonly (readonly [Intent, RegExp])[] = [
  ['HUMAN', /\b(human|real person|a person|agent|customer (care|support)|support team|talk to (someone|somebody|a person|support)|call me|manager|helpdesk|insaan|kisi se baat)\b/],
  ['PAYMENT_ISSUE', /\b(not (received|arrived|credited|come)|didn'?t (get|receive|arrive|come)|did not (get|receive|arrive)|haven'?t (got|received)|wrong amount|scam(med)?|cheat(ed)?|fraud|paise nahi aaye|nahi aaya|nahi mila|dispute)\b/],
  ['DOCUMENTS', /\b(kyc|pan( card)?|aadhaa?r|passport|documents?|id proof|selfie|gst)\b/],
  ['FEES', /\b(fees?|charges?|commission|network fee|gas|kitna cut|hidden)\b/],
  ['SAFETY', /\b(safe|safety|scam|trust|escrow|secure|guarantee|bharosa|legit|risk)\b/],
  ['TRADER', /\b(trader|merchant|become a|earn|margin|security reserve|reserve|liquidity|provide|apply)\b/],
  ['HOW_SELL', /\b(how (do|can|to) (i )?sell|sell (my )?usdt|usdt (sell|bech)|bechna|bechu|bech(na)? hai)\b/],
  ['HOW_BUY', /\b(how (do|can|to) (i )?buy|buy (some )?usdt|usdt (buy|kharid)|kharidna|kharidu|lena hai)\b/],
  ['TIME', /\b(how long|kitna time|kitni der|how fast|how quick|takes? (long|time))\b/],
  ['LIMITS', /\b(limits?|minimum|maximum|min|max|how much can|largest|smallest)\b/],
  ['RATE', /\b(rates?|price|bhav|bhaav|kitne ka|kya rate|today'?s rate|market)\b/],
  ['STATUS', /\b(status|where is|kahan|kab|when will|my (deal|trade|order|usdt|money|payment|request|rupees)|update|stuck|pending|progress)\b/],
  ['ACCOUNT', /\b(bank account|add (a )?bank|upi( id)?|wallets?|sign ?in|log ?in|email|telegram|open (an|my) account)\b/],
  ['THANKS', /\b(thanks|thank you|thx|ty|shukriya|dhanyavad)\b/],
  ['HELP', /^\/?(help|menu|start)\b|\bwhat can you do\b/],
  ['GREETING', /^(hi+|hello|hey|namaste|namaskar|yo|hola|good (morning|afternoon|evening))\b/],
];

export function intentOf(text: string): Intent {
  const t = text.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
  for (const [intent, re] of PATTERNS) if (re.test(t)) return intent;
  return 'UNKNOWN';
}

export interface Answer {
  readonly text: string;
  readonly action: RobotAction | null;
}

/** Where a person who is not linked to an account can write instead. */
export interface AskDeps {
  readonly mind: RobotMind | null;
  /** The desk's address, when the deployment has one. */
  readonly deskEmail?: string | null;
}

const marketWords = (w: RobotWorld): string | null =>
  w.market.SELL_USDT !== null && w.market.BUY_USDT !== null
    ? `Today's market: sell at ${rateWords(w.market.SELL_USDT)}, buy at ${rateWords(w.market.BUY_USDT)} per USDT.`
    : null;

/** The person's state as the model may read it: their stage, their open request and deals, in words — nothing else. */
export function factsInWords(f: PersonFacts | null, w: RobotWorld, brief: RobotBrief | null): string {
  const lines: string[] = [];
  const market = marketWords(w);
  lines.push(market ?? 'The market reading is not fresh right now: no automatic price is given until it is.');
  if (!f) {
    lines.push('This person is not linked to an INRP2P account here.');
    return lines.join('\n');
  }
  const j = journeyOf(f, w.now);
  if (j.exchange) lines.push(`Exchange stage: ${j.exchange.stage}.`);
  if (j.trader) lines.push(`Trader programme stage: ${j.trader.stage}.`);
  const m = f.member;
  if (m) {
    lines.push(`Bank accounts active: ${m.banksActive}. Wallets active: ${m.walletsActive}. Waiting for the desk to verify: ${m.pendingReview}.`);
    if (m.lastRequest) lines.push(`Latest request ${m.lastRequest.ref}: ${m.lastRequest.direction === 'SELL_USDT' ? 'sell' : 'buy'} ${amountWords(m.lastRequest.amount, m.lastRequest.currency)}, status ${m.lastRequest.status}.`);
    for (const t of m.openTrades) lines.push(`Open deal ${t.ref}: ${t.direction === 'SELL_USDT' ? 'selling' : 'buying'} USDT, state ${t.state}${t.dispute ? ', a payment is in dispute (INRP2P decides)' : ''}${t.hold ? ', paused for a check' : ''}.`);
    lines.push(`Completed deals: ${m.completed}.`);
  }
  if (brief) lines.push(`What the robot shows them now: ${brief.title} — ${brief.body}`);
  return lines.join('\n');
}

/** What INRP2P is and how it works, for the model — the same facts the site and the product state, nothing more. */
export const HANDBOOK = `INRP2P is an exchange for USDT (TRC20) and Indian rupees between people. Every deal is P2P: the rupees go directly from the buyer's own bank account or UPI to the seller's own account; INRP2P never holds rupees. INRP2P holds the seller's USDT in the deal's own escrow address and releases it only when the seller confirms the rupees arrived.
Selling USDT: add a bank account (or UPI ID) under Bank & wallets, choose Sell on the Exchange, accept the firm price, send the USDT to the deal's escrow address, the buyer pays the rupees to your account, you confirm they arrived, the escrow is released.
Buying USDT: add a TRC20 wallet, choose Buy, accept the firm price; the seller's USDT is locked in escrow first; you pay from your own account and enter the bank reference (UTR); the USDT is released to your wallet when the seller confirms.
Prices: a firm price is given for the amount asked and must be accepted within its time; nothing is committed until accepted. When no trader can price a request, it waits (24 hours by default) and the client is told the moment a price is found; that price is held for 10 minutes.
Fees: the rate is the market's; each deal shows a network fee — what TRON charges for the escrow and its transfers — as its own line before you accept. When two clients meet each other directly, INRP2P's fee is inside the price shown.
Disputes: if the seller says the rupees did not arrive, INRP2P checks both sides' evidence and decides; the USDT stays locked meanwhile. Rupees from someone else's account are refused.
Traders: people with rupees or USDT can apply to price deals: bank account in their own name, their wallet, the sides they trade, and a Security Reserve sent from their registered wallet; then they set a price (fixed or following the market) and go online. Orders come privately, one at a time.
Notifications: deal alerts and the robot's messages come in the app, on Telegram (connect it in Account), in the browser if turned on, and by email. The robot's suggestions can be turned off at any time.
INRP2P never asks for passwords, sign-in codes, private keys or seed phrases.`;

function ruleAnswer(intent: Intent, f: PersonFacts | null, w: RobotWorld, brief: RobotBrief | null, readyNowUsdt: string | null): Answer | null {
  const market = marketWords(w);
  const m = f?.member ?? null;
  switch (intent) {
    case 'GREETING':
      return brief ? { text: `Hi! ${brief.title}. ${brief.body}`, action: brief.action } : { text: 'Hi! I am the INRP2P robot. Connect your Telegram in your INRP2P workspace and I can tell you about your own deals here.', action: null };
    case 'THANKS':
      return { text: 'Any time.', action: null };
    case 'HELP':
      return {
        text: 'Ask me where your deal or request is, today\'s rate, how selling or buying works, about fees or safety, or how to become a trader. Say "person" and I pass your question to someone at INRP2P.',
        action: null,
      };
    case 'STATUS':
      if (!brief) return { text: 'I can tell you about your own requests and deals once this chat is connected to your INRP2P account (Account & security → Telegram).', action: null };
      return { text: `${brief.title}. ${brief.body}`, action: brief.action };
    case 'PAYMENT_ISSUE': {
      const deal = m?.openTrades[0];
      if (!deal) return null;
      if (deal.dispute) return { text: `${deal.ref} is in dispute: INRP2P is checking both sides' evidence and decides. The USDT stays locked in escrow until then — nothing is lost while it checks.`, action: { label: 'Open the deal', href: `/trades/${deal.ref}` } };
      return {
        text: `I see ${deal.ref}. If money you expected has not arrived, say so on the deal ("It did not arrive") — INRP2P then checks both sides and decides. The USDT stays locked in escrow meanwhile; never release it before the rupees are in your account.`,
        action: { label: 'Open the deal', href: `/trades/${deal.ref}` },
      };
    }
    case 'RATE':
      return {
        text: `${market ?? 'There is no fresh market reading right now, so automatic prices are paused until it is back.'} Your firm price comes when you ask for an amount — nothing is committed until you accept it.${readyNowUsdt ? ` Right now a trader can take up to about ${readyNowUsdt} USDT.` : ''}`,
        action: m?.exchangeAccess ? { label: 'Ask for a price', href: '/exchange' } : null,
      };
    case 'HOW_SELL':
      return {
        text: `${m && m.banksActive === 0 ? 'First add a bank account or UPI ID under Bank & wallets. Then ' : ''}choose Sell on the Exchange and enter your USDT. Accept the firm price, send the USDT to the deal's own escrow address, and the buyer pays rupees straight to your account. You confirm they arrived; only then is the escrow released.`,
        action: m && m.banksActive === 0 ? { label: 'Add a bank account', href: '/destinations' } : { label: 'Sell USDT', href: '/exchange?direction=sell' },
      };
    case 'HOW_BUY':
      return {
        text: `${m && m.walletsActive === 0 ? 'First add your TRC20 wallet under Bank & wallets. Then ' : ''}choose Buy on the Exchange. Accept the firm price; the seller's USDT is locked in escrow before you pay. Pay from your own account, enter the reference, and the USDT is released to your wallet when the seller confirms.`,
        action: m && m.walletsActive === 0 ? { label: 'Add a wallet', href: '/destinations' } : { label: 'Buy USDT', href: '/exchange?direction=buy' },
      };
    case 'FEES':
      return {
        text: 'The rate is the market\'s. Each deal shows the network fee — what TRON charges for its escrow and transfers — as its own line before you accept; nothing else is taken from you. When you meet another client directly, INRP2P\'s fee is already inside the price you see.',
        action: null,
      };
    case 'SAFETY':
      return {
        text: 'Nobody has to trust a stranger: the seller\'s USDT is locked in INRP2P\'s escrow before any rupees move, and released only when the seller confirms the rupees landed. If they say they did not, INRP2P checks both sides and decides. Rupees only ever move between the two people\'s own accounts.',
        action: null,
      };
    case 'TIME':
      return {
        text: 'A price comes in seconds when a trader is online for your amount. After that, most of a deal is the bank transfer itself — IMPS and UPI usually land in minutes. Every step shows its own clock on the deal.',
        action: null,
      };
    case 'LIMITS':
      return {
        text: `There is no fixed size: you get a price for what traders online can take.${readyNowUsdt ? ` Right now that is up to about ${readyNowUsdt} USDT.` : ''} If your amount is outside it, the Exchange tells you the range — or keeps looking for a trader for you.`,
        action: m?.exchangeAccess ? { label: 'Ask for a price', href: '/exchange' } : null,
      };
    case 'TRADER': {
      const t = f ? journeyOf(f, w.now).trader : null;
      if (t && f) {
        const p = PLAYBOOKS.find((x) => x.track === 'TRADER' && x.stage === t.stage);
        const d = p?.compose(f, t, w, 1);
        if (d) return { text: `${d.title}. ${d.body}`, action: { label: 'Open Traders', href: d.href } };
        if (t.stage === 'IN_REVIEW') return { text: 'Your application is with the desk: a person at INRP2P looks at what the rules could not settle. You are told the moment it is decided.', action: { label: 'Open Traders', href: '/traders' } };
        if (t.stage === 'LIVE') return { text: 'You are online: orders on your sides come to you privately, one at a time. Keep your prices current, or let them follow the market.', action: { label: 'Open Traders', href: '/traders' } };
      }
      return {
        text: 'Traders price deals for clients and earn their margin over the market. Apply under Traders: a bank account in your own name, your wallet, the sides you trade. Send your Security Reserve from that wallet, set your price (fixed or following the market) and go online.',
        action: { label: 'Become a trader', href: '/traders' },
      };
    }
    case 'ACCOUNT':
      if (m) {
        const pending = m.pendingReview > 0 ? ` ${m.pendingReview === 1 ? 'One is' : `${m.pendingReview} are`} waiting for the desk to verify.` : '';
        return { text: `You have ${m.banksActive} active bank account${m.banksActive === 1 ? '' : 's'} and ${m.walletsActive} active wallet${m.walletsActive === 1 ? '' : 's'}.${pending} Add or change them under Bank & wallets; Telegram and sign-in are under Account & security.`, action: { label: 'Bank & wallets', href: '/destinations' } };
      }
      return { text: 'Open your account in the workspace — it takes a minute. Bank accounts, wallets, Telegram and sign-in are all managed there.', action: { label: 'Open my account', href: '/open-account' } };
    default:
      return null;
  }
}

/** Every figure the model wrote must be one it was given: otherwise the answer is not heard. */
export function figuresGrounded(answer: string, sources: string): boolean {
  const known = new Set((sources.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((x) => x.replace(/,/g, '').replace(/\.0+$/, '')));
  for (const raw of answer.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) {
    const n = raw.replace(/,/g, '').replace(/\.0+$/, '');
    if (/^\d$/.test(n)) continue;
    if (!known.has(n)) return false;
  }
  return true;
}

const SECRETS = /\b(otp|password|passcode|seed phrase|private key|mnemonic|pin)\b/i;

export interface AskInput {
  readonly userId: string | null;
  readonly channel: 'APP' | 'TELEGRAM';
  readonly telegramChatId?: string | null;
  readonly text: string;
}

export interface AskResult {
  readonly answer: string;
  readonly action: RobotAction | null;
  readonly source: 'RULE' | 'AI' | 'CASE';
  readonly intent: string;
  readonly caseRef: string | null;
}

async function aiAnsweredToday(db: Db): Promise<number> {
  const r = await db.selectFrom('robot_exchange').select((eb) => eb.fn.countAll<string>().as('n')).where('source', '=', 'AI').where('created_at', '>', sql<Date>`inrp2p_now() - interval '24 hours'`).executeTakeFirstOrThrow();
  return Number.parseInt(r.n, 10);
}

export async function askRobot(db: Db, deps: AskDeps, input: AskInput): Promise<AskResult> {
  const text = input.text.replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (!text) throw new DomainError('INVALID_ARGUMENT', 'ask something', { field: 'text' });
  const [policy, world, f] = await Promise.all([currentRobotPolicy(db), loadWorld(db), input.userId ? personFacts(db, input.userId) : Promise.resolve(null)]);
  const waiting = f?.member?.lastRequest?.waitingUntil ? await waitingFactsOf(db, f.member.lastRequest.id) : null;
  const brief = f ? briefFrom(f, journeyOf(f, world.now), world, { deal: null, tradersOnline: waiting?.tradersOnline ?? null, question: null }) : null;
  const reach = f?.telegramLinked ? 'here on Telegram' : input.channel === 'TELEGRAM' ? 'in this chat' : f?.email ? 'here and by email' : 'here';
  const intent = intentOf(text);

  const log = async (r: AskResult, caseId: string | null): Promise<AskResult> => {
    await db.insertInto('robot_exchange').values({ user_id: input.userId, channel: input.channel, intent: r.intent.slice(0, 30), source: r.source, question: text, answer: r.answer.slice(0, 2000), case_id: caseId }).execute();
    return r;
  };
  const handOff = async (intro: string, label: string, fromAi: boolean): Promise<AskResult> => {
    if (!input.userId && !input.telegramChatId) {
      return log({ answer: `${intro} Write to ${deps.deskEmail ?? 'the INRP2P desk'} and a person answers.`, action: null, source: fromAi ? 'AI' : 'CASE', intent: label, caseRef: null }, null);
    }
    if (!input.userId) {
      return log({ answer: `${intro} Connect this chat to your INRP2P account (Account & security → Telegram) and I can pass it on — or write to ${deps.deskEmail ?? 'the INRP2P desk'}.`, action: null, source: fromAi ? 'AI' : 'CASE', intent: label, caseRef: null }, null);
    }
    const c = await openCase(db, {
      userId: input.userId, clientId: f?.member?.clientId ?? null, channel: input.channel, telegramChatId: input.channel === 'TELEGRAM' ? (input.telegramChatId ?? null) : null,
      question: text, context: { stage: brief?.kind ?? null, facts: factsInWords(f, world, brief).slice(0, 1500) },
    });
    return log({ answer: `${intro} I have passed it to a person at INRP2P (${c.ref}); the answer comes ${reach}.`, action: null, source: fromAi ? 'AI' : 'CASE', intent: label, caseRef: c.ref }, c.id);
  };

  // A secret offered or asked about is never handled in a chat.
  if (SECRETS.test(text) && /\b(my|here is|share|send|give|tell)\b/i.test(text)) {
    return log({ answer: 'Never share a password, a sign-in code, a private key or a seed phrase — not even with INRP2P. Nobody here will ever ask for one.', action: null, source: 'RULE', intent: 'SECRET', caseRef: null }, null);
  }
  if (intent === 'HUMAN') return handOff('Of course.', 'HUMAN', false);
  if (intent === 'DOCUMENTS') return handOff('Questions about documents are answered by a person.', 'DOCUMENTS', false);
  const rule = ruleAnswer(intent, f, world, brief, waiting?.readyNowUsdt ?? null);
  if (rule) return log({ answer: rule.text, action: rule.action, source: 'RULE', intent, caseRef: null }, null);
  if (intent === 'PAYMENT_ISSUE') return handOff('I see no open deal of yours to check.', 'PAYMENT_ISSUE', false);

  // No rule knows it: the model, when it is on and today's limit is not spent.
  if (policy.answers === 'AI' && deps.mind && (await aiAnsweredToday(db)) < policy.aiDailyLimit) {
    const facts = factsInWords(f, world, brief);
    const reply: MindAnswer | null = await deps.mind.answer({ handbook: HANDBOOK, facts, question: text }).catch(() => null);
    const label = reply && /^[A-Z_]{2,30}$/.test(reply.intent) ? reply.intent : 'OTHER';
    const said = reply?.answer.trim().slice(0, 700) ?? '';
    const sound = reply !== null && said.length > 0 && figuresGrounded(said, `${HANDBOOK}\n${facts}`) && !SECRETS.test(said.replace(/never (share|ask)[^.]*\./gi, ''));
    if (sound && !reply!.handoff) return log({ answer: said, action: null, source: 'AI', intent: label, caseRef: null }, null);
    if (sound && reply!.handoff) return handOff(said, label, true);
    return handOff('I am not sure about that one.', label, true);
  }
  return handOff('I can not answer that one myself.', 'OTHER', false);
}
