import { Money, Rate } from '@inrp2p/kernel';
import type { ExchangeView, HistoryRow, PortalTrade } from '@inrp2p/portal';
import { formatInr, formatIstTime, formatRate, formatUsdtHeadline } from '@inrp2p/ui/format';

/**
 * What the robot says on a stage, in its own voice (ADR 0034 addendum "the robot at the client's side").
 *
 * Pure over the page's own projection, like `_assistant/model.ts`: every figure is one the server returned, every
 * promise is something the product does by itself. The robot speaks in the first person, one remark at a time, at most
 * two short sentences — and never about money it does not hold or a decision that is not its own (a dispute, a release).
 * It guards at the moments the Indian P2P market loses money: a screenshot instead of a bank credit, a payment from
 * someone else's account, a deal moved to WhatsApp, a request to cancel after paying, the last minutes of a step.
 */

export type SpeechTone = 'calm' | 'guard' | 'alert' | 'happy';

/** One line of the robot's work, as the visor shows it: something done (with its time), or what it is doing now. */
export interface LogRow {
  readonly at: string | null;
  readonly text: string;
  readonly state: 'done' | 'live';
}

export interface Speech {
  /** Changes when what it says changes, so the bubble can arrive again — and only then. */
  readonly key: string;
  readonly tone: SpeechTone;
  /** The remark: one or two sentences, three only for the first hello. */
  readonly lines: readonly string[];
  /** The robot's work log, oldest first, the live row last. */
  readonly log?: readonly LogRow[];
  /** One move the remark offers ("Same again"), a link within the workspace. */
  readonly action?: { readonly label: string; readonly href: string };
}

const usdt = (amount: string) => formatUsdtHeadline(Money.parse(amount, 'USDT'));
const inrExact = (amount: string) => formatInr(Money.parse(amount, 'INR'), { fraction: 'always' });
const rate = (value: string) => formatRate(Rate.parse(value, 'CLIENT'));
const time = (iso: string) => formatIstTime(new Date(iso));
/** A time on the visor's log: the clock alone — the page already says IST. */
const clock = (iso: string) => time(iso).replace(/\s*IST$/, '');
/** A USDT amount as the Exchange's form takes it back: digits, a point, no grouping, no trailing zeros. */
const plain = (amount: string) => (amount.includes('.') ? amount.replace(/0+$/, '').replace(/\.$/, '') : amount);

/** How close to the end of a step the robot says so, calmly, once. */
export const LAST_MINUTES_MS = 5 * 60_000;

// ── Exchange, before a request ─────────────────────────────────────────────────────────────────────────────────

/** The first hello, on a client's first visit to the Exchange: who it is, what it does, why it is safe. Three lines. */
export const INTRO: Speech = {
  key: 'intro',
  tone: 'happy',
  lines: [
    'Hi, I’m the INRP2P robot.',
    'Tell me an amount and I’ll get you one firm price for all of it.',
    'Every deal runs through escrow: the USDT stays locked until the rupees are confirmed.',
  ],
};

/**
 * The Exchange with nothing asked yet. A client's first visit gets the hello; one who traded before is reminded of its
 * last completed deal — the figures of that trade, and today's market for the same side when there is one — with the
 * same request one tap away. Otherwise, what the robot does when asked.
 */
export function idleSpeech(input: {
  readonly recent: readonly HistoryRow[];
  /** The market's reference for each side (`/api/market-rate`), when it is fresh enough to show. */
  readonly market: { readonly SELL_USDT: string | null; readonly BUY_USDT: string | null } | null;
  /** Whether this browser has already been greeted. */
  readonly greeted: boolean;
}): Speech {
  const last = input.recent.find((r) => r.status === 'COMPLETED' && !r.peerDeal);
  if (!last) {
    if (input.recent.length === 0 && !input.greeted) return INTRO;
    return { key: 'idle', tone: 'calm', lines: ['Tell me an amount — I’ll get one firm price for the whole of it and hold it while you decide.'] };
  }
  const sold = last.direction === 'SELL_USDT';
  const today = input.market?.[last.direction] ?? null;
  const lines = [`Last time you ${sold ? 'sold' : 'bought'} ${usdt(last.base)} at ${rate(last.clientRate)}.`];
  if (today) lines.push(`Today the market is ${formatRate(Rate.parse(today, 'REFERENCE'))}.`);
  return {
    key: `memory:${last.ref}:${today ?? ''}`,
    tone: 'calm',
    lines,
    action: { label: 'Same again', href: `/exchange?direction=${sold ? 'sell' : 'buy'}&amount=${plain(last.base)}` },
  };
}

// ── Exchange, a request with the desk ──────────────────────────────────────────────────────────────────────────

export function pricingSpeech(request: NonNullable<ExchangeView['request']>): Speech {
  if (request.gatheringUntil) {
    return {
      key: `gathering:${request.ref}`,
      tone: 'calm',
      lines: ['I’m gathering prices for this amount.', `The best one lands right here by ${time(request.gatheringUntil)} — no need to reload.`],
    };
  }
  return { key: `pricing:${request.ref}`, tone: 'calm', lines: ['The desk is pricing it now. I’ll put the firm price right here the moment it is sent.'] };
}

/**
 * A request that waits for a price (ADR 0032/0033). The stage's title says what leads; the robot says what it is doing
 * about it, and its log is the wait's own record: when it started, how many traders were told, how many are online,
 * the place in line, and the search itself.
 */
export function waitingSpeech(
  request: NonNullable<ExchangeView['request']>,
  opts: { readonly telegram: boolean; readonly now: number },
): Speech {
  const wait = request.waiting;
  const peer = request.peer;
  const meeting = peer?.meeting?.status === 'WAITING_MAKER' ? peer.meeting : null;
  const other = request.direction === 'SELL_USDT' ? 'buyer' : 'seller';
  if (meeting?.role === 'MAKER') {
    return { key: `maker:${meeting.ref}`, tone: 'calm', lines: [`They said yes to your price. Start the deal by ${time(meeting.yesUntil)} — I’ll take you through every step.`] };
  }
  if (meeting) {
    return { key: `taker:${meeting.ref}`, tone: 'calm', lines: [`I’ve asked the ${other} to start. Your price is held until ${time(meeting.yesUntil)}.`] };
  }
  if (peer?.paused) {
    return { key: `paused:${request.ref}`, tone: 'calm', lines: ['You were away when another client wanted your price. Say you’re still looking and I’ll put you back in the book.'] };
  }
  if (peer?.offer?.kind === 'READY') {
    return { key: `ready:${peer.offer.rate}`, tone: 'calm', lines: [`A ${other} is ready at ${rate(peer.offer.rate)}. Say yes and they start the deal.`] };
  }
  if (peer?.offer?.kind === 'NEAR') {
    return { key: `near:${peer.offer.rate}`, tone: 'calm', lines: [`A ${other} is close at ${rate(peer.offer.rate)}. Meet them there, or I keep looking.`] };
  }
  if (wait?.on === 'MARKET') {
    return { key: `market:${request.ref}`, tone: 'calm', lines: ['The market rate is updating. I’ll price your request the moment it’s back — you can close this page.'] };
  }
  const reach = opts.telegram ? 'on Telegram' : 'here and by email';
  const lines = ['I keep looking while you get on with your day.', `When a trader prices it, I hold the price for you for 10 minutes and tell you ${reach}.`];
  const log: LogRow[] = [{ at: clock(wait?.since ?? request.createdAt), text: 'Request in the book', state: 'done' }];
  if (wait && wait.tradersTold > 0) log.push({ at: null, text: `Told ${wait.tradersTold} ${wait.tradersTold === 1 ? 'trader' : 'traders'} who take this side`, state: 'done' });
  if (wait) log.push({ at: null, text: `${wait.tradersOnline} online now · ${ordinal(wait.ahead + 1)} in line`, state: 'done' });
  log.push({ at: null, text: `Looking until ${clock(wait?.until ?? request.waitingUntil!)}`, state: 'live' });
  return { key: `waiting:${request.ref}`, tone: 'calm', lines, log };
}

const ordinal = (n: number): string => (n % 100 >= 11 && n % 100 <= 13 ? `${n}th` : n % 10 === 1 ? `${n}st` : n % 10 === 2 ? `${n}nd` : n % 10 === 3 ? `${n}rd` : `${n}th`);

// ── Exchange, a firm quote ─────────────────────────────────────────────────────────────────────────────────────

/** Under this, the robot says the price is about to go — once, calmly, with what happens next. */
const QUOTE_LAST_MS = 30_000;

export function quoteSpeech(
  quote: NonNullable<ExchangeView['quote']>,
  opts: { readonly canAccept: boolean; readonly canReprice: boolean; readonly now: number },
): Speech {
  const whole = usdt(quote.base.amount);
  const until = quote.expiresAt ? time(quote.expiresAt) : null;
  const left = quote.expiresAt ? Date.parse(quote.expiresAt) - opts.now : Infinity;
  if (!opts.canAccept) {
    return { key: `quote:${quote.ref}:view`, tone: 'calm', lines: [`I’m holding this price${until ? ` until ${until}` : ''}. Someone with acceptance rights on your account has to accept it.`] };
  }
  if (left <= QUOTE_LAST_MS) {
    return {
      key: `quote:${quote.ref}:last`,
      tone: 'calm',
      lines: ['A few seconds left on this price.', opts.canReprice ? 'If it runs out, you can ask me for a new one in one tap.' : 'If it runs out, the desk can send a new one.'],
    };
  }
  return {
    key: `quote:${quote.ref}`,
    tone: 'calm',
    lines: [`One firm price for the whole ${whole}.`, `I’m holding it${until ? ` until ${until}` : ''} — nothing moves until you accept.`],
  };
}

// ── A P2P deal ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A P2P deal's stage (ADR 0019/0023): what the robot is doing and the one thing that protects the client now. Its log
 * is the deal's own record — the stops reached, the transfer seen on TRON, the payment filed — each at its time, with
 * the step in progress as the live row.
 */
export function dealSpeech(view: PortalTrade, now: number): Speech | null {
  const deal = view.p2p;
  if (!deal) return null;
  const sell = view.trade.direction === 'SELL_USDT';
  const amount = usdt(view.trade.base.amount);
  const inr = inrExact(deal.inr);
  const mine = deal.turn === (sell ? 'SELLER' : 'BUYER');
  const disputed = deal.dispute?.status === 'OPEN';
  const seen = sell && deal.step === 'ESCROW' && view.incoming !== null;
  const lastMinutes = mine && deal.dueBy !== null && Date.parse(deal.dueBy) - now <= LAST_MINUTES_MS && Date.parse(deal.dueBy) > now;
  const log = dealLog(view);
  const say = (key: string, tone: SpeechTone, ...lines: string[]): Speech => ({ key: `${view.trade.ref}:${key}`, tone, lines, log });
  const again = { label: 'Same again', href: `/exchange?direction=${sell ? 'sell' : 'buy'}&amount=${plain(view.trade.base.amount)}` };

  if (disputed) {
    return sell
      ? say('dispute', 'calm', 'INRP2P is checking this with the banks.', `Your ${amount} stays locked in escrow meanwhile — nothing is lost.`)
      : say('dispute', 'calm', 'INRP2P is checking your payment with the seller.', `The ${amount} stays locked for you meanwhile.`);
  }
  if (view.onHold && view.trade.status !== 'COMPLETED' && deal.step !== 'DONE') {
    return say('hold', 'calm', 'INRP2P paused this to check something. Nothing is lost — I’ll show you here the moment it moves.');
  }
  switch (deal.step) {
    case 'ESCROW':
      if (!sell) return say('escrow-buy', 'guard', 'The seller is locking the USDT in escrow.', 'Don’t pay anything yet — I’ll tell you the moment it’s locked.');
      if (seen) return say('escrow-seen', 'calm', `I see your ${amount} on TRON and I’m confirming it.`, 'Then the buyer pays you.');
      if (lastMinutes) return say('escrow-last', 'calm', 'A few minutes left to send.', `Send exactly ${usdt(view.trade.depositInstructions?.amount ?? view.trade.base.amount)} — I’ll spot it the moment it lands.`);
      return say('escrow-sell', 'calm', `I’m watching TRON for exactly ${usdt(view.trade.depositInstructions?.amount ?? view.trade.base.amount)}.`, 'It’s locked the moment it lands, and released only when you confirm the rupees.');
    case 'PAY':
      if (sell) {
        return deal.payWindow?.final
          ? say('pay-sell-final', 'calm', 'The buyer’s time is almost up.', 'If they don’t say they’ve paid, I send your USDT back to you.')
          : say('pay-sell', 'guard', `Your USDT is locked while the buyer pays ${inr}.`, 'Don’t release anything until I ask you to check your bank.');
      }
      if (lastMinutes || deal.payWindow?.final) return say('pay-buy-last', 'calm', 'A few minutes left to pay.', 'If you’ve already paid, say so now — I’ll take it from there.');
      // The sheet under the stage carries the payment's own rule (your own account, this account): the robot says why now is safe.
      return say('pay-buy', 'calm', 'The seller’s USDT is locked in escrow, so it’s safe to pay now.');
    case 'CONFIRM':
      if (sell) {
        if (lastMinutes) return say('confirm-last', 'calm', 'A few minutes left on this step.', 'Check your bank app — if it isn’t there, tap “It hasn’t arrived” and I keep the USDT locked.');
        return say('confirm-sell', 'guard', `Open your bank app and find ${inr} from the buyer’s own account.`, 'Screenshots and SMS can be faked — only the credit in your bank counts.');
      }
      return deal.receiptLate
        ? say('confirm-buy-late', 'calm', 'This payment is taking longer than usual.', 'INRP2P is following it up — nothing for you to do.')
        : say('confirm-buy', 'calm', 'The seller is checking your payment.', `The ${amount} is released to your wallet the moment they confirm.`);
    case 'RELEASE':
      return sell ? say('release', 'happy', 'All done on your side.', 'I’m releasing the escrow to the buyer.') : say('release', 'happy', 'Payment confirmed.', `Your ${amount} is on its way to your wallet.`);
    case 'DONE':
      return {
        ...say('done', 'happy', 'All settled — thank you for trading with me.', view.receipt ? 'Your receipt is ready whenever you need it.' : 'Want to do it again?'),
        action: again,
      };
    case 'REFUND':
      return deal.unwind?.reason === 'NOT_PAID'
        ? say('refund', 'calm', 'INRP2P found the buyer’s payment didn’t arrive, so I’m sending your USDT back.', 'Nothing of yours is kept.')
        : say('refund', 'calm', 'The buyer didn’t pay in time, so I’m sending your USDT back.', 'Nothing of yours is kept.');
    case 'CANCELLED':
      return { ...say('cancelled', 'calm', 'This deal is closed.', 'Want a new price for the same amount?'), action: again };
    default:
      return null;
  }
}

/** The deal's own record as the robot's log: at most the last three things done, then what it is doing now. */
export function dealLog(view: PortalTrade): readonly LogRow[] {
  const deal = view.p2p;
  if (!deal) return [];
  const sell = view.trade.direction === 'SELL_USDT';
  // Each row with its place in a deal's order, so two things recorded in the same second still read in the order they happen.
  const rows: { at: string; order: number; text: string }[] = [];
  for (const s of view.stages) {
    if (s.status !== 'done' || !s.at) continue;
    if (s.key === 'accepted') rows.push({ at: s.at, order: 0, text: 'Price accepted, deal opened' });
    else if (s.key === 'funded') rows.push({ at: s.at, order: 2, text: sell ? 'Your USDT locked in escrow' : 'Seller’s USDT locked in escrow' });
    else if (s.key === 'settling') rows.push({ at: s.at, order: 4, text: sell ? 'Rupees confirmed' : 'Your payment confirmed' });
    else if (s.key === 'completed') rows.push({ at: s.at, order: 5, text: sell ? 'Escrow released to the buyer' : 'USDT delivered' });
  }
  if (sell && view.incoming) rows.push({ at: view.incoming.detectedAt, order: 1, text: `${usdt(view.incoming.amount)} seen on TRON` });
  for (const p of deal.payments) rows.push({ at: p.filedAt, order: 3, text: sell ? `Buyer says they paid ${inrExact(p.amount)}` : `You said you paid ${inrExact(p.amount)}` });
  rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.order - b.order);
  const done: LogRow[] = rows.slice(-3).map((r) => ({ at: clock(r.at), text: r.text, state: 'done' }));

  const live = liveRow(view);
  return live ? [...done, { at: null, text: live, state: 'live' }] : done;
}

function liveRow(view: PortalTrade): string | null {
  const deal = view.p2p!;
  const sell = view.trade.direction === 'SELL_USDT';
  if (deal.dispute?.status === 'OPEN') return 'INRP2P is checking';
  if (view.onHold) return 'Paused for a check';
  switch (deal.step) {
    case 'ESCROW':
      return sell ? (view.incoming ? 'Confirming on TRON' : 'Watching TRON for your USDT') : 'Waiting for the seller’s USDT';
    case 'PAY':
      return sell ? 'Waiting for the buyer’s payment' : 'Waiting for your payment';
    case 'CONFIRM':
      return sell ? 'Waiting for your check' : 'Waiting for the seller to confirm';
    case 'RELEASE':
      return sell ? 'Releasing the escrow' : 'Sending your USDT';
    case 'REFUND':
      return 'Sending your USDT back';
    default:
      return null;
  }
}

// ── Guardian moments ───────────────────────────────────────────────────────────────────────────────────────────

/** What in a chat message takes a deal out of the escrow's reach, or undoes it after a payment. */
export type ChatRisk = 'contact' | 'cancel';

/** An Indian mobile number (with or without +91/0 and separators), or any run of 10+ digits that reads as a phone. */
const PHONE = /(?<!\d)(?:\+?91[\s-]?|0)?[6-9](?:[\s-]?\d){9}(?!\d)/;
const APPS = /\b(?:whats\s*app|whatsapp|wa\.me|telegram|tele\s*gram|t\.me|signal|insta(?:gram)?|snap(?:chat)?|imo|call\s+me|dm\s+me|message\s+me\s+on)\b/i;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]{2,}/;
const HANDLE = /(?:^|\s)@[a-z0-9_]{4,32}\b/i;
const CANCEL = /\b(?:cancel|cancell?ed|cancelling|cancel\s+karo|cancel\s+kar\s+do|cancel\s+kardo|raddh?)\b/i;

/**
 * Whether a chat message moves the deal off the platform (a phone number, an app, an email, a handle) or asks to cancel
 * it. A heuristic, said as a warning beside the message, never a block: the words are the people's, the escrow is ours.
 */
export function chatRisk(text: string): ChatRisk | null {
  if (PHONE.test(text) || APPS.test(text) || EMAIL.test(text) || HANDLE.test(text)) return 'contact';
  if (CANCEL.test(text)) return 'cancel';
  return null;
}

/** The robot's warning for a risk in the chat — about the other side's message, or the person's own draft. */
export function chatRiskSpeech(risk: ChatRisk, from: 'them' | 'you', other: 'buyer' | 'seller'): Speech {
  if (risk === 'contact') {
    return from === 'you'
      ? { key: 'chat:contact:you', tone: 'guard', lines: ['Keep the deal in this chat.', 'Off INRP2P the escrow can’t protect you — and nobody here can see what was agreed.'] }
      : { key: 'chat:contact:them', tone: 'guard', lines: [`The ${other} wants to move off INRP2P. Keep it here.`, 'Outside this chat the escrow can’t protect you — that’s where screenshot scams start.'] };
  }
  return from === 'you'
    ? { key: 'chat:cancel:you', tone: 'guard', lines: ['If you’ve paid, don’t agree to cancel.', 'Tell INRP2P instead — tap Support and I’ll keep the escrow locked meanwhile.'] }
    : { key: 'chat:cancel:them', tone: 'guard', lines: [`The ${other} is asking to cancel. If money has moved, don’t.`, 'Tap Support — INRP2P checks it while the escrow stays locked.'] };
}

/** The payer-name check (ADR 0030) after a seller confirmed: when the name is not the buyer's, the robot says what to do. */
export function payerNameSpeech(verdict: string): Speech | null {
  if (verdict === 'MATCH') return null;
  return verdict === 'PARTIAL'
    ? { key: 'payer:partial', tone: 'guard', lines: ['That name is close to the buyer’s, but not the same.', 'INRP2P checks it and tells you; the escrow stays locked meanwhile.'] }
    : {
        key: 'payer:mismatch',
        tone: 'alert',
        lines: ['That isn’t the buyer’s registered account. Don’t spend this money — it goes back to whoever sent it.', 'INRP2P has been told; the escrow stays locked.'],
      };
}

// ── The screens without a stage ────────────────────────────────────────────────────────────────────────────────

/** Bank & wallets: what the client can do with what it has added, and the one thing to add next. */
export function destinationsSpeech(input: { readonly canSell: boolean; readonly canBuy: boolean; readonly isAdmin: boolean }): Speech {
  const { canSell, canBuy, isAdmin } = input;
  if (canSell && canBuy) {
    return { key: 'dest:both', tone: 'happy', lines: ['All set: a sale pays into your bank, a purchase lands in your wallet.'], action: { label: 'Get a price', href: '/exchange' } };
  }
  if (!isAdmin) {
    return canSell || canBuy
      ? { key: 'dest:one:viewer', tone: 'calm', lines: [`You can ${canSell ? 'sell' : 'buy'} now. An administrator of your account adds the rest.`] }
      : { key: 'dest:none:viewer', tone: 'calm', lines: ['An administrator of your account adds these.', 'Once one is here, you can ask me for a price.'] };
  }
  if (canSell) return { key: 'dest:sell', tone: 'calm', lines: ['You can sell now.', 'Add a TRC20 wallet and you can buy USDT too.'] };
  if (canBuy) return { key: 'dest:buy', tone: 'calm', lines: ['You can buy now.', 'Add a bank account and you can sell USDT for rupees too.'] };
  return { key: 'dest:none', tone: 'calm', lines: ['Add a bank account to sell USDT for rupees, or a TRC20 wallet to buy USDT.', 'A buyer pays the rupees straight into the bank account you add here.'] };
}

/** Account: where the robot reaches the person outside the app. `telegram` is null where Telegram is not offered. */
export function accountSpeech(input: { readonly telegram: boolean | null }): Speech | null {
  if (input.telegram === null) return null;
  return input.telegram
    ? { key: 'account:telegram', tone: 'calm', lines: ['I message you on Telegram when a price or a payment needs you.', 'Ask me any time — here, or right in that chat.'] }
    : { key: 'account:no-telegram', tone: 'calm', lines: ['Connect Telegram and I’ll message you the moment a price or a payment needs you.'] };
}

/** Opening an account: what happens the moment it exists. */
export const OPEN_ACCOUNT: Speech = {
  key: 'open-account',
  tone: 'happy',
  lines: ['Name the account and the Exchange opens right away.', 'I’ll be there for your first price.'],
};
