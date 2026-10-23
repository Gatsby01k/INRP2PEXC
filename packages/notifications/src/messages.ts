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
  /** Team messages: what changed, and the role it concerns. Never the person's address — the Team screen shows who. */
  readonly teamChange?: 'JOINED' | 'ROLE_CHANGED' | 'REMOVED';
  readonly teamRole?: 'ADMIN' | 'OPERATOR';
  /** P2P disputes and unwinds (block 9): who is told — the side that received the rupees, or the one that paid them. */
  readonly p2p?: {
    readonly audience: 'CLIENT' | 'TRADER';
    readonly payee: boolean;
    readonly decision?: 'PAID' | 'NOT_PAID';
    /** A trader's order that is a desk's own deal: it opens in the desk's workspace. */
    readonly deskDeal?: boolean;
  };
  /** A decision of INRP2P's about the trader's desk (block 11). */
  readonly deskAction?: 'SUSPENDED' | 'RESUMED' | 'PAGE_HIDDEN' | 'PAGE_SHOWN' | 'RENAMED';
}

/** Thousands grouped the international way (D-11) — `10,200,000` — whatever the reader's locale. */
const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** `₹10,200,000`, or `₹2,550,000.50` when there are paise: the figure as the client checks it against their bank. */
const inr = (amount: string): string => {
  const [whole = '0', paise = ''] = Money.parse(amount, 'INR').toDecimalString().split('.');
  return `₹${group(whole)}${/[1-9]/.test(paise) ? `.${paise}` : ''}`;
};

/** `5,000 USDT`, or every decimal that is not a trailing zero: an amount to send is never rounded. */
const usdt = (amount: string): string => {
  const [whole = '0', fraction = ''] = Money.parse(amount, 'USDT').toDecimalString().split('.');
  const kept = fraction.replace(/0+$/, '');
  return `${group(whole)}${kept ? `.${kept}` : ''} USDT`;
};

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
    case 'PAYMENT_RETURNED':
      return {
        kind,
        title: 'Payment from another account',
        body: short(`A payment for ${facts.tradeRef ?? 'your trade'} came from an account that is not yours. It is going back to where it came from and does not count — pay again from your own registered account.`, 400),
        subjectRef: facts.tradeRef ?? null,
        href: facts.tradeRef ? `/trades/${facts.tradeRef}` : null,
      };
    case 'DESTINATION_ADDED':
      return {
        kind,
        title: 'A bank account or wallet was added',
        body: `${facts.label ?? 'A new bank account or wallet'} was added to where you are paid. If you did not expect this, tell the desk straight away.`,
        subjectRef: null,
        href: '/destinations',
      };
    case 'DESTINATION_ARCHIVED':
      return {
        kind,
        title: 'A bank account or wallet was archived',
        body: `${facts.label ?? 'It'} can no longer be paid to.`,
        subjectRef: null,
        href: '/destinations',
      };
    case 'TRADE_DESTINATION_CHANGED':
      return {
        kind,
        title: 'A trade now pays somewhere else',
        body: short(`${facts.tradeRef ?? 'A trade'} will be paid to ${facts.label ?? 'a different destination'}. If you did not ask for this, tell us straight away.`, 400),
        subjectRef: facts.tradeRef ?? null,
        href: facts.tradeRef ? `/trades/${facts.tradeRef}` : '/destinations',
      };
    case 'TEAM_CHANGED':
      return teamDraft(facts);
    case 'P2P_DISPUTE_OPENED':
    case 'P2P_DISPUTE_DECIDED':
    case 'P2P_REFUND':
      return p2pDraft(kind, facts);
    default:
      return traderDraft(kind, facts);
  }
}

/**
 * Who can act for the account changed. Everyone on the team is told — like a new place to be paid, it is what someone
 * who took over a session would do — and pointed at the Team screen, which shows who.
 */
function teamDraft(facts: NotificationFacts): NotificationDraft {
  const as = facts.teamRole === 'ADMIN' ? 'an administrator' : 'an operator';
  switch (facts.teamChange) {
    case 'JOINED':
      return { kind: 'TEAM_CHANGED', title: 'Someone joined your team', body: `A person accepted an invitation and can now act for your account as ${as}. If you did not expect this, remove them on Team straight away.`, subjectRef: null, href: '/account/team' };
    case 'ROLE_CHANGED':
      return { kind: 'TEAM_CHANGED', title: 'A role on your team changed', body: `A member of your team is now ${as}. If you did not expect this, check Team straight away.`, subjectRef: null, href: '/account/team' };
    default:
      return { kind: 'TEAM_CHANGED', title: 'Someone left your team', body: 'A member was removed from your team and can no longer act for your account.', subjectRef: null, href: '/account/team' };
  }
}

/**
 * A P2P deal's dispute or unwind, told to whichever side it concerns (block 9). The seller of the USDT receives the rupees
 * and says when they did not arrive; INRP2P decides from its bank. Neither side is told the other's words — only what
 * happens to the money.
 */
function p2pDraft(kind: 'P2P_DISPUTE_OPENED' | 'P2P_DISPUTE_DECIDED' | 'P2P_REFUND', facts: NotificationFacts): NotificationDraft {
  const p = facts.p2p ?? { audience: 'CLIENT' as const, payee: false };
  const trader = p.audience === 'TRADER';
  const ref = (trader ? facts.orderRef : facts.tradeRef) ?? null;
  const href = trader ? (ref ? (p.deskDeal ? `/desk/deals/${ref}` : `/traders/orders/${ref}`) : '/traders') : ref ? `/trades/${ref}` : '/trades';
  const inrAmount = facts.inr ? inr(facts.inr) : 'the rupees';
  const usdtAmount = facts.base ? usdt(facts.base) : 'the USDT';
  const on = ref ? `${ref}: ` : '';
  switch (kind) {
    case 'P2P_DISPUTE_OPENED':
      return {
        kind,
        title: 'The seller says your payment has not arrived',
        body: `${on}the seller says ${inrAmount} has not reached their account. INRP2P is checking it with their bank — add your bank’s reference, the time you paid and the account you paid from on the ${trader ? 'order' : 'trade'}.`,
        subjectRef: ref,
        href,
      };
    case 'P2P_REFUND':
      return trader
        ? { kind, title: 'You did not pay in time', body: `${on}the time to pay ${inrAmount} ran out. The deal is cancelled and the seller’s USDT goes back to them — do not pay now.`, subjectRef: ref, href }
        : { kind, title: 'The buyer did not pay in time', body: `${on}the buyer did not pay ${inrAmount} in time. The trade is cancelled and your ${usdtAmount} goes back to the wallet you sent it from.`, subjectRef: ref, href };
    default: {
      const paid = p.decision === 'PAID';
      if (p.payee) {
        return paid
          ? { kind, title: 'INRP2P found the payment arrived', body: `${on}INRP2P checked with the bank’s evidence that ${inrAmount} reached your account from the buyer’s own account, and released the USDT to the buyer.`, subjectRef: ref, href }
          : {
              kind,
              title: 'INRP2P found the payment did not arrive',
              body: `${on}INRP2P found ${inrAmount} did not reach your account. The ${trader ? 'deal' : 'trade'} is cancelled and your ${trader ? 'USDT goes back to your registered wallet' : `${usdtAmount} goes back to the wallet you sent it from`}.`,
              subjectRef: ref,
              href,
            };
      }
      return paid
        ? { kind, title: 'Your payment is confirmed', body: `${on}INRP2P confirmed your ${inrAmount} reached the seller. Your USDT is being released to your wallet.`, subjectRef: ref, href }
        : { kind, title: 'Your payment did not arrive', body: `${on}INRP2P found your ${inrAmount} did not reach the seller. The ${trader ? 'deal' : 'trade'} is cancelled and the USDT went back — do not pay again.`, subjectRef: ref, href };
    }
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
    case 'DESK_NOTICE': {
      const why = facts.reason ? ` INRP2P’s note: ${facts.reason}` : '';
      const said: Record<NonNullable<NotificationFacts['deskAction']>, [string, string]> = {
        SUSPENDED: ['INRP2P suspended your desk', `No new deal until INRP2P lifts it; deals already accepted settle as usual.${why}`],
        RESUMED: ['Your desk is no longer suspended', `It is paused: take it live again on Desk when you are ready.${why}`],
        PAGE_HIDDEN: ['INRP2P hid your desk’s page', `Your page is not shown to anyone until INRP2P shows it again. Change your desk’s name or words on Desk → Page.${why}`],
        PAGE_SHOWN: ['Your desk’s page is back', `Anyone can open it again.${why}`],
        RENAMED: ['INRP2P renamed your desk', `See its new name and address on Desk → Page.${why}`],
      };
      const [title, body] = said[facts.deskAction ?? 'SUSPENDED'];
      return { kind, title, body: short(body, 400), subjectRef: null, href: '/desk' };
    }
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
