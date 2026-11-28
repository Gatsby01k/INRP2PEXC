import { Money, Rate } from '@inrp2p/kernel';
import type { ExchangeView, HistoryRow, PortalTrade } from '@inrp2p/portal';
import { formatIstTime, formatRate, formatUsdtHeadline } from '@inrp2p/ui/format';

/**
 * What Bhai says on a stage, in his own voice (ADR 0034 addendum "the robot at the client's side").
 *
 * Pure over the page's own projection, like `_assistant/model.ts`: every figure is one the server returned, every
 * promise is something the product does by itself. One line of dialogue at a time: the first sentence is what matters
 * — short enough to read at a glance — and a second, quieter one says why. Never about money he does not hold or a
 * decision that is not his (a dispute, a release). He guards the moments the Indian P2P market loses money: a
 * screenshot instead of a bank credit, a payment from someone else's account, a deal moved to WhatsApp, a request to
 * cancel after paying, the last minutes of a step.
 */

export type SpeechTone = 'calm' | 'guard' | 'alert' | 'happy';

export interface Speech {
  /** Changes when what he says changes, so the bubble can arrive again — and only then. */
  readonly key: string;
  readonly tone: SpeechTone;
  /** The line, then at most one quieter one; three only for the first hello. */
  readonly lines: readonly string[];
  /** One move the line offers ("Same again"), a link within the workspace. */
  readonly action?: { readonly label: string; readonly href: string };
}

const usdt = (amount: string) => formatUsdtHeadline(Money.parse(amount, 'USDT'));
const rate = (value: string) => formatRate(Rate.parse(value, 'CLIENT'));
/** A time as a person says it in a line of dialogue: the clock alone — the page says IST where it matters. */
const clock = (iso: string) => formatIstTime(new Date(iso)).replace(/\s*IST$/, '');
/** A USDT amount as the Exchange's form takes it back: digits, a point, no grouping, no trailing zeros. */
const plain = (amount: string) => (amount.includes('.') ? amount.replace(/0+$/, '').replace(/\.$/, '') : amount);
const say = (key: string, tone: SpeechTone, ...lines: string[]): Speech => ({ key, tone, lines });

/** How close to the end of a step Bhai says so, calmly, once. */
export const LAST_MINUTES_MS = 5 * 60_000;

// ── Exchange, before a request ─────────────────────────────────────────────────────────────────────────────────

/** The first hello, on a client's first visit to the Exchange: who he is, what he does, why it is safe. */
export const INTRO: Speech = say('intro', 'happy', 'Hi, I’m Bhai — your INRP2P robot.', 'Tell me an amount, I get you one firm price.', 'The USDT stays locked till the rupees land.');

/**
 * The Exchange with nothing asked yet. A client's first visit gets the hello; one who traded before is reminded of its
 * last completed deal — the figures of that trade, and today's market for the same side when there is one — with the
 * same request one tap away. Otherwise, what Bhai does when asked.
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
    return say('idle', 'calm', 'Tell me an amount.', 'One firm price for all of it, held while you decide.');
  }
  const sold = last.direction === 'SELL_USDT';
  const today = input.market?.[last.direction] ?? null;
  return {
    ...say(
      `memory:${last.ref}:${today ?? ''}`,
      'calm',
      `Last time: ${sold ? 'sold' : 'bought'} ${usdt(last.base)} at ${rate(last.clientRate)}.`,
      ...(today ? [`Market today: ${formatRate(Rate.parse(today, 'REFERENCE'))}.`] : []),
    ),
    action: { label: 'Same again', href: `/exchange?direction=${sold ? 'sell' : 'buy'}&amount=${plain(last.base)}` },
  };
}

// ── Exchange, a request with the desk ──────────────────────────────────────────────────────────────────────────

export function pricingSpeech(request: NonNullable<ExchangeView['request']>): Speech {
  return request.gatheringUntil
    ? say(`gathering:${request.ref}`, 'calm', 'Collecting prices for this amount.', `The best one lands here by ${clock(request.gatheringUntil)}.`)
    : say(`pricing:${request.ref}`, 'calm', 'The desk is pricing it.', 'It lands right here — no need to reload.');
}

/** A request that waits for a price (ADR 0032/0033): what Bhai is doing about it, in a line. The stage carries the facts. */
export function waitingSpeech(request: NonNullable<ExchangeView['request']>, opts: { readonly telegram: boolean; readonly now: number }): Speech {
  const peer = request.peer;
  const meeting = peer?.meeting?.status === 'WAITING_MAKER' ? peer.meeting : null;
  const other = request.direction === 'SELL_USDT' ? 'buyer' : 'seller';
  if (meeting?.role === 'MAKER') return say(`maker:${meeting.ref}`, 'calm', 'They said yes to your price.', `Start by ${clock(meeting.yesUntil)} — I’ll walk you through it.`);
  if (meeting) return say(`taker:${meeting.ref}`, 'calm', `I’ve asked the ${other} to start.`, `Your price is held till ${clock(meeting.yesUntil)}.`);
  if (peer?.paused) return say(`paused:${request.ref}`, 'calm', 'You missed a client while away.', 'Say you’re still looking and I’ll put you back.');
  if (peer?.offer?.kind === 'READY') return say(`ready:${peer.offer.rate}`, 'calm', `A ${other} is ready at ${rate(peer.offer.rate)}.`, 'Say yes and they start.');
  if (peer?.offer?.kind === 'NEAR') return say(`near:${peer.offer.rate}`, 'calm', `A ${other} is close at ${rate(peer.offer.rate)}.`, 'Meet them, or I keep looking.');
  if (request.waiting?.on === 'MARKET') return say(`market:${request.ref}`, 'calm', 'The market rate is updating.', 'I price it the moment it’s back.');
  return say(`waiting:${request.ref}`, 'calm', 'I’m on it — close the page if you like.', `Once it’s priced, I hold it 10 min and ping you ${opts.telegram ? 'on Telegram' : 'here and by email'}.`);
}

// ── Exchange, a firm quote ─────────────────────────────────────────────────────────────────────────────────────

/** Under this, Bhai says the price is about to go — once, calmly, with what happens next. */
const QUOTE_LAST_MS = 30_000;

export function quoteSpeech(quote: NonNullable<ExchangeView['quote']>, opts: { readonly canAccept: boolean; readonly canReprice: boolean; readonly now: number }): Speech {
  const until = quote.expiresAt ? clock(quote.expiresAt) : null;
  const left = quote.expiresAt ? Date.parse(quote.expiresAt) - opts.now : Infinity;
  if (!opts.canAccept) return say(`quote:${quote.ref}:view`, 'calm', `Held${until ? ` till ${until}` : ''}.`, 'Someone with acceptance rights has to accept it.');
  if (left <= QUOTE_LAST_MS) {
    return say(`quote:${quote.ref}:last`, 'calm', 'Seconds left on this price.', opts.canReprice ? 'If it runs out, a new one is a tap away.' : 'If it runs out, the desk can send a new one.');
  }
  return say(`quote:${quote.ref}`, 'calm', `One price for all ${usdt(quote.base.amount)}.`, `Held${until ? ` till ${until}` : ''} — nothing moves till you accept.`);
}

// ── A P2P deal ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A P2P deal's stage (ADR 0019/0023): what Bhai is doing, and the one thing that protects the client now. */
export function dealSpeech(view: PortalTrade, now: number): Speech | null {
  const deal = view.p2p;
  if (!deal) return null;
  const ref = view.trade.ref;
  const sell = view.trade.direction === 'SELL_USDT';
  const amount = usdt(view.trade.base.amount);
  const exact = usdt(view.trade.depositInstructions?.amount ?? view.trade.base.amount);
  const mine = deal.turn === (sell ? 'SELLER' : 'BUYER');
  const lastMinutes = mine && deal.dueBy !== null && Date.parse(deal.dueBy) - now <= LAST_MINUTES_MS && Date.parse(deal.dueBy) > now;
  const again = { label: 'Same again', href: `/exchange?direction=${sell ? 'sell' : 'buy'}&amount=${plain(view.trade.base.amount)}` };
  const line = (key: string, tone: SpeechTone, ...lines: string[]) => say(`${ref}:${key}`, tone, ...lines);

  if (deal.dispute?.status === 'OPEN') {
    return sell ? line('dispute', 'calm', 'INRP2P is checking with the banks.', 'Your USDT stays locked meanwhile.') : line('dispute', 'calm', 'INRP2P is checking your payment.', 'The USDT stays locked for you.');
  }
  if (view.onHold && view.trade.status !== 'COMPLETED' && deal.step !== 'DONE') return line('hold', 'calm', 'Paused for a quick check.', 'Nothing is lost — I’ll show you when it moves.');
  switch (deal.step) {
    case 'ESCROW':
      if (!sell) return line('escrow-buy', 'guard', 'Don’t pay yet.', 'The seller is locking the USDT first.');
      if (view.incoming) return line('escrow-seen', 'calm', `Got it — ${usdt(view.incoming.amount)} on TRON.`, 'Confirming now.');
      if (lastMinutes) return line('escrow-last', 'calm', 'A few minutes left to send.', `Exactly ${exact}.`);
      return line('escrow-sell', 'calm', `Watching TRON for your ${exact}.`, 'No button to press — I see it land.');
    case 'PAY':
      if (sell) {
        return deal.payWindow?.final
          ? line('pay-sell-final', 'calm', 'Their time’s almost up.', 'No payment, and your USDT comes back.')
          : line('pay-sell', 'guard', 'Your USDT is locked while they pay.', 'Release nothing till the rupees land.');
      }
      if (lastMinutes || deal.payWindow?.final) return line('pay-buy-last', 'calm', 'A few minutes left to pay.', 'Paid already? Say so now.');
      return line('pay-buy', 'calm', 'USDT locked. Safe to pay now.');
    case 'CONFIRM':
      if (sell) {
        if (lastMinutes) return line('confirm-last', 'calm', 'A few minutes left.', 'Not in your bank? Tap “It hasn’t arrived”.');
        return line('confirm-sell', 'guard', 'Check your bank app, not a screenshot.', 'Screenshots and SMS can be faked.');
      }
      return deal.receiptLate
        ? line('confirm-buy-late', 'calm', 'Slower than usual.', 'INRP2P is following it up.')
        : line('confirm-buy', 'calm', 'The seller is checking your payment.', `${amount} comes to your wallet when they confirm.`);
    case 'RELEASE':
      return sell ? line('release', 'happy', 'Done on your side.', 'Releasing to the buyer.') : line('release', 'happy', 'Payment confirmed.', `${amount} on its way to your wallet.`);
    case 'DONE':
      return { ...line('done', 'happy', 'All settled. Pleasure doing business.', ...(view.receipt ? ['Your receipt is ready.'] : [])), action: again };
    case 'REFUND':
      return deal.unwind?.reason === 'NOT_PAID'
        ? line('refund', 'calm', 'The payment never arrived.', 'Your USDT is coming back.')
        : line('refund', 'calm', 'The buyer ran out of time.', 'Your USDT is coming back.');
    case 'CANCELLED':
      return { ...line('cancelled', 'calm', 'Deal closed.', 'Want the same again?'), action: again };
    default:
      return null;
  }
}

// ── Guardian moments ───────────────────────────────────────────────────────────────────────────────────────────

/** What in a chat message takes a deal out of the escrow's reach, or undoes it after a payment. */
export type ChatRisk = 'contact' | 'cancel';

/** An Indian mobile number (with or without +91/0 and separators), never part of a longer run of digits. */
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

/** Bhai's warning for a risk in the chat — about the other side's message, or the person's own draft. */
export function chatRiskSpeech(risk: ChatRisk, from: 'them' | 'you', other: 'buyer' | 'seller'): Speech {
  if (risk === 'contact') {
    return from === 'you'
      ? say('chat:contact:you', 'guard', 'Keep it in this chat.', 'Off INRP2P there’s no escrow to protect you.')
      : say('chat:contact:them', 'guard', `The ${other} wants to go off INRP2P.`, 'Keep it here — off-platform is where scams start.');
  }
  return from === 'you'
    ? say('chat:cancel:you', 'guard', 'Paid already? Don’t cancel.', 'Tap Support — the escrow stays locked meanwhile.')
    : say('chat:cancel:them', 'guard', `The ${other} wants to cancel.`, 'If money moved, don’t — tap Support.');
}

/** The payer-name check (ADR 0030) after a seller confirmed: when the name is not the buyer's, what it means. */
export function payerNameSpeech(verdict: string): Speech | null {
  if (verdict === 'MATCH') return null;
  return verdict === 'PARTIAL'
    ? say('payer:partial', 'guard', 'Close to the buyer’s name, not the same.', 'INRP2P checks it; the escrow stays locked.')
    : say('payer:mismatch', 'alert', 'Not the buyer’s account. Don’t spend it.', 'It goes back to the sender; the escrow stays locked.');
}

// ── The screens without a stage ────────────────────────────────────────────────────────────────────────────────

/** Bank & wallets: what the client can do with what it has added, and the one thing to add next. */
export function destinationsSpeech(input: { readonly canSell: boolean; readonly canBuy: boolean; readonly isAdmin: boolean }): Speech {
  const { canSell, canBuy, isAdmin } = input;
  if (canSell && canBuy) return { ...say('dest:both', 'happy', 'All set.', 'Sales pay into your bank, buys land in your wallet.'), action: { label: 'Get a price', href: '/exchange' } };
  if (!isAdmin) {
    return canSell || canBuy
      ? say('dest:one:viewer', 'calm', `You can ${canSell ? 'sell' : 'buy'} now.`, 'An administrator adds the rest.')
      : say('dest:none:viewer', 'calm', 'An administrator of your account adds these.', 'Then ask me for a price.');
  }
  if (canSell) return say('dest:sell', 'calm', 'You can sell now.', 'Add a TRC20 wallet to buy too.');
  if (canBuy) return say('dest:buy', 'calm', 'You can buy now.', 'Add a bank account to sell too.');
  return say('dest:none', 'calm', 'Add a bank to sell, or a TRC20 wallet to buy.', 'Buyers pay straight into your bank.');
}

/** Account: where Bhai reaches the person outside the app. `telegram` is null where Telegram is not offered. */
export function accountSpeech(input: { readonly telegram: boolean | null }): Speech | null {
  if (input.telegram === null) return null;
  return input.telegram
    ? say('account:telegram', 'calm', 'I ping you on Telegram when something needs you.', 'Ask me there any time, too.')
    : say('account:no-telegram', 'calm', 'Connect Telegram.', 'I’ll ping you the moment a price or a payment needs you.');
}

/** Opening an account: what happens the moment it exists. */
export const OPEN_ACCOUNT: Speech = say('open-account', 'happy', 'Name it, and you’re in.', 'I’ll be there for your first price.');
