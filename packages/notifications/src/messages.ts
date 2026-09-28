import { Money } from '@inrp2p/kernel';
import type { NotificationKind } from '@inrp2p/db';

/**
 * What a client is told, and where it takes them.
 *
 * Every message is written for the person receiving it, in the words of their own transaction: a reference they
 * recognise and a figure they can check. Nothing here explains how the desk works — a client's notification is
 * not a window into the exchange's operations (SECURITY §5), and the database refuses internal vocabulary in
 * these columns anyway.
 */
export interface NotificationDraft {
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
  readonly subjectRef: string | null;
  readonly href: string | null;
}

/** Facts the events carry, resolved to the references and amounts a client recognises. */
export interface NotificationFacts {
  readonly quoteRef?: string;
  readonly tradeRef?: string;
  readonly inr?: string;
  readonly base?: string;
  readonly paid?: string;
  readonly of?: string;
  readonly reason?: string;
  readonly label?: string;
  readonly expiresAt?: Date;
  readonly direction?: 'SELL_USDT' | 'BUY_USDT';
  /** Trader messages: the order, its side in the trader's words, and its figures at the trader's own rate. */
  readonly orderRef?: string;
  readonly side?: 'BUY_USDT' | 'SELL_USDT';
  readonly rate?: string;
  readonly reward?: string;
}

const inr = (amount: string): string => `₹${Money.parse(amount, 'INR').toDecimalString()}`;
const usdt = (amount: string): string => `${Money.parse(amount, 'USDT').toDecimalString()} USDT`;

/** A reason an operator typed is shown to the client as written, trimmed and bounded by the column's own limit. */
const short = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

export function draftFor(kind: NotificationKind, facts: NotificationFacts): NotificationDraft {
  switch (kind) {
    case 'QUOTE_SENT':
      return {
        kind,
        title: 'Your quote is ready',
        body: facts.inr
          ? `${facts.quoteRef}: ${facts.direction === 'BUY_USDT' ? 'you pay' : 'you receive'} ${inr(facts.inr)}. It is only held for a short time.`
          : `${facts.quoteRef} is ready. It is only held for a short time.`,
        subjectRef: facts.quoteRef ?? null,
        href: '/exchange',
      };
    case 'QUOTE_EXPIRED':
      return {
        kind,
        title: 'Your quote expired',
        body: `${facts.quoteRef} is no longer valid. Ask for a new one whenever you are ready.`,
        subjectRef: facts.quoteRef ?? null,
        href: '/exchange',
      };
    case 'REQUEST_DECLINED':
      return {
        kind,
        title: 'The desk could not price your request',
        body: facts.reason ? short(`Your request was declined: ${facts.reason}`, 400) : 'Your request was declined.',
        subjectRef: null,
        href: '/exchange',
      };
    case 'TRADE_OPENED':
      return {
        kind,
        title: 'Trade open',
        body:
          facts.direction === 'SELL_USDT'
            ? `${facts.tradeRef} is open. Send ${facts.base ? usdt(facts.base) : 'the USDT'} to the address shown on the trade.`
            : `${facts.tradeRef} is open. The payment details are on the trade.`,
        subjectRef: facts.tradeRef ?? null,
        href: facts.tradeRef ? `/trades/${facts.tradeRef}` : null,
      };
    case 'PAYOUT_CONFIRMED':
      return {
        kind,
        title: 'Payment sent',
        body: `${facts.tradeRef}: ${facts.paid ? inr(facts.paid) : 'a payment'} of ${facts.of ? inr(facts.of) : 'your total'} has been paid.`,
        subjectRef: facts.tradeRef ?? null,
        href: facts.tradeRef ? `/trades/${facts.tradeRef}` : null,
      };
    case 'TRADE_COMPLETED':
      return {
        kind,
        title: 'Trade complete',
        body: `${facts.tradeRef} is settled in full${facts.inr ? `: ${inr(facts.inr)}` : ''}.`,
        subjectRef: facts.tradeRef ?? null,
        href: facts.tradeRef ? `/trades/${facts.tradeRef}` : null,
      };
    case 'TRADE_CANCELLED':
      return {
        kind,
        title: 'Trade cancelled',
        body: short(`${facts.tradeRef} was cancelled${facts.reason ? `: ${facts.reason}` : ''}.`, 400),
        subjectRef: facts.tradeRef ?? null,
        href: facts.tradeRef ? `/trades/${facts.tradeRef}` : null,
      };
    case 'DESTINATION_ADDED':
      return {
        kind,
        title: 'A destination was added',
        body: `${facts.label ?? 'A new destination'} was added to your account. If you did not expect this, tell us straight away.`,
        subjectRef: null,
        href: '/destinations',
      };
    case 'DESTINATION_ARCHIVED':
      return {
        kind,
        title: 'A destination was archived',
        body: `${facts.label ?? 'A destination'} can no longer be used for payouts.`,
        subjectRef: null,
        href: '/destinations',
      };
    default:
      return traderDraft(kind, facts);
  }
}

const sideWords = (side: NotificationFacts['side']): string => (side === 'SELL_USDT' ? 'Sell' : 'Buy');
const orderHref = (facts: NotificationFacts): string | null => (facts.orderRef ? `/traders/orders/${facts.orderRef}` : '/traders');

/**
 * What a trader is told. The same rules as every client message: the trader's own reference and figures, and
 * nothing about the client on the other side — who they are, what they were quoted, or what INRP2P keeps.
 */
function traderDraft(kind: NotificationKind, facts: NotificationFacts): NotificationDraft {
  const ref = facts.orderRef ?? null;
  const usdtAmount = facts.base ? usdt(facts.base) : 'the USDT';
  const inrAmount = facts.inr ? inr(facts.inr) : 'the INR';
  switch (kind) {
    case 'TRADER_APPROVED':
      return { kind, title: 'You are approved as a trader', body: 'Set your capacity and rates on Traders, then switch on to receive matching orders.', subjectRef: null, href: '/traders' };
    case 'TRADER_REJECTED':
      return {
        kind,
        title: 'Your trader application was not approved',
        body: facts.reason ? short(`The desk's note: ${facts.reason}`, 400) : 'You can apply again from Traders.',
        subjectRef: null,
        href: '/traders',
      };
    case 'TRADER_PAUSED':
      return {
        kind,
        title: 'Your trader account is paused',
        body: short(`No new orders are assigned. Orders already in progress continue.${facts.reason ? ` Reason: ${facts.reason}` : ''}`, 400),
        subjectRef: null,
        href: '/traders',
      };
    case 'TRADER_RESUMED':
      return { kind, title: 'Your trader account is active again', body: 'You can switch on to receive matching orders.', subjectRef: null, href: '/traders' };
    case 'TRADER_ORDER_NEW':
      return {
        kind,
        title: ref ? `New order ${ref}` : 'New order',
        body: `${sideWords(facts.side)} ${usdtAmount}${facts.rate ? ` at ₹${facts.rate} per USDT` : ''}. Accept or decline it on Traders.`,
        subjectRef: ref,
        href: orderHref(facts),
      };
    case 'TRADER_ORDER_ACCEPTED':
      return { kind, title: ref ? `Order ${ref} is confirmed` : 'Your order is confirmed', body: 'The trade is open. You will be told when it is your turn to send.', subjectRef: ref, href: orderHref(facts) };
    case 'TRADER_ACTION_REQUIRED':
      return {
        kind,
        title: `Send your ${facts.side === 'SELL_USDT' ? 'USDT' : 'INR'} for ${ref ?? 'your order'}`,
        body: `The other side is funded. Send ${facts.side === 'SELL_USDT' ? usdtAmount : inrAmount} as shown on the order.`,
        subjectRef: ref,
        href: orderHref(facts),
      };
    case 'TRADER_PAYMENT_CONFIRMED':
      return {
        kind,
        title: `Payment received for ${ref ?? 'your order'}`,
        body: `INRP2P confirmed your ${facts.side === 'SELL_USDT' ? usdtAmount : inrAmount}. Your ${facts.side === 'SELL_USDT' ? 'INR' : 'USDT'} is on its way.`,
        subjectRef: ref,
        href: orderHref(facts),
      };
    case 'TRADER_ORDER_COMPLETED':
      return {
        kind,
        title: ref ? `Order ${ref} completed` : 'Order completed',
        body: `Settled in full.${facts.reward ? ` Reward earned: ${inr(facts.reward)}.` : ''}`,
        subjectRef: ref,
        href: orderHref(facts),
      };
    case 'TRADER_ORDER_CLOSED':
      return {
        kind,
        title: ref ? `Order ${ref} closed` : 'Order closed',
        body: short(facts.reason ?? 'Nothing is held for it any more.', 400),
        subjectRef: ref,
        href: orderHref(facts),
      };
    case 'TRADER_RESERVE_ISSUE':
      return {
        kind,
        title: 'Your Security Reserve needs attention',
        body: short(facts.reason ?? 'Open Traders to see what is needed.', 400),
        subjectRef: null,
        href: '/traders/reserve',
      };
    default:
      throw new Error(`no message for ${kind}`);
  }
}
