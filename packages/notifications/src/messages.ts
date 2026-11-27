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
  /** ADR 0030: a UPI ID added with its full limits (the desk looked it up), or with the first deals' limit. */
  readonly upiConfirmed?: boolean;
  readonly expiresAt?: Date;
  readonly direction?: 'SELL_USDT' | 'BUY_USDT';
  /** Trader messages: the order, its side in the trader's words, and its figures at the trader's own rate. */
  readonly orderRef?: string;
  readonly side?: 'BUY_USDT' | 'SELL_USDT';
  readonly rate?: string;
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
    /** ADR 0023: who wrote in the deal's chat — the other side by its role, or INRP2P. */
    readonly from?: 'BUYER' | 'SELLER' | 'INRP2P';
    /** ADR 0023: the end of the buyer's final period to say it paid. */
    readonly until?: Date;
    /** ADR 0023: how the rupees were said to be sent. */
    readonly rail?: string;
  };
  /** A decision of INRP2P's about the trader's desk (block 11). */
  readonly deskAction?: 'SUSPENDED' | 'RESUMED' | 'PAGE_HIDDEN' | 'PAGE_SHOWN' | 'RENAMED';
  /** ADR 0024: a change of where the trader is paid — asked for (and when it can take effect), stopped, or made. */
  readonly settlementChange?: { readonly action: 'PROPOSED' | 'CANCELLED' | 'APPLIED'; readonly what: 'BANK' | 'WALLET' | 'BOTH'; readonly effectiveAt?: Date };
  /** ADR 0025: a price the trader is asked for — the amount as asked and how long it has to answer. */
  readonly priceAsk?: { readonly ref: string; readonly amount: string; readonly currency: 'USDT' | 'INR'; readonly closesAt: Date };
  /** A trader's order on a P2P deal (ADR 0019): the minutes it has to lock its USDT in escrow when it is the seller. */
  readonly escrow?: { readonly minutes: number };
  /** A side of the trader's that can no longer take its smallest order: what is left of it, in its own currency. */
  readonly sideEmpty?: { readonly currency: 'INR' | 'USDT'; readonly left: string };
  /**
   * ADR 0032: what a waiting client asked for, in its own currency — told to the client when its wait ends, and to a trader
   * who could take it (never who asks); and how many clients wait on that side now, this one included.
   */
  readonly waiting?: { readonly amount: string; readonly currency: 'USDT' | 'INR'; readonly clients?: number };
  /** ADR 0033: a trader message to a client acting as a meeting's maker — its deal opens on its own deal page. */
  readonly personal?: boolean;
  /** ADR 0033: a meeting of two clients, as this client is in it. */
  readonly peer?: {
    readonly role: 'MAKER' | 'TAKER';
    /** The direction of this client's own request. */
    readonly direction: 'SELL_USDT' | 'BUY_USDT';
    readonly rate: string;
    readonly base: string;
    readonly inr: string;
    readonly network: string;
    readonly until?: Date;
    readonly reason?: string;
    readonly orderRef?: string | null;
    /** A price near this client's own: READY when they cross, NEAR when they are close. */
    readonly near?: 'READY' | 'NEAR';
    readonly ownRate?: string | null;
  };
  /** ADR 0033: the request a message is about, for "Keep looking". */
  readonly requestRef?: string;
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
    case 'WAITING_PRICE_READY': {
      // ADR 0032: the trader the client waited for. Said with the figure to check and how long the price is held for.
      const amount = facts.base ? usdt(facts.base) : 'USDT';
      const pays = facts.inr ? `${facts.direction === 'BUY_USDT' ? 'you pay' : 'you get'} ${inr(facts.inr)}` : null;
      const until = facts.expiresAt ? ` It is held for you until ${ist(facts.expiresAt)}.` : ' It is held for you for 10 minutes.';
      return {
        kind,
        title: 'We found you a trader',
        body: `Your price for ${amount} is ready${pays ? `: ${pays}` : ''}.${until} Open the Exchange to accept it.`,
        subjectRef: facts.quoteRef ?? null,
        href: '/exchange',
      };
    }
    case 'WAITING_ENDED': {
      const w = facts.waiting;
      const amount = w ? (w.currency === 'USDT' ? usdt(w.amount) : `USDT for ${inr(w.amount)}`) : 'your amount';
      return {
        kind,
        title: 'Nobody took your request',
        body: `We looked for ${amount} the whole time you chose and nobody could take it. Nothing was committed. Keep looking with the same terms in one tap.`,
        subjectRef: facts.requestRef ?? null,
        // The Exchange shows this request's end with "Keep looking" beside it (links are paths, no query: 0017).
        href: '/exchange',
      };
    }
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
            : `${facts.tradeRef} is open. The seller locks the USDT in escrow first — you are told the moment it is time to pay.`,
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
        title: facts.label?.startsWith('UPI ID') ? 'A UPI ID was added' : 'A bank account or wallet was added',
        body: facts.label?.startsWith('UPI ID')
          ? facts.upiConfirmed === false
            ? `${facts.label} is ready: deals of up to ₹25,000 can be paid to it by UPI, and its own limits apply once your first one is confirmed. If you did not add it, tell the desk straight away.`
            : `${facts.label} is ready: your deals can be paid to it by UPI, and you can pay from it. If you did not add it, tell the desk straight away.`
          : `${facts.label ?? 'A new bank account or wallet'} was added to where you are paid. If you did not expect this, tell the desk straight away.`,
        subjectRef: null,
        href: '/destinations',
      };
    case 'DESTINATION_ARCHIVED':
      return {
        kind,
        title: facts.label?.startsWith('UPI ID') ? 'A UPI ID was archived' : 'A bank account or wallet was archived',
        body: `${facts.label ?? 'It'} can no longer be paid to.`,
        subjectRef: null,
        href: '/destinations',
      };
    case 'DESTINATION_PAUSED':
      return {
        kind,
        title: 'Your UPI ID is paused',
        body: short(
          `A buyer’s UPI app showed a different name for ${facts.label ?? 'your UPI ID'}${facts.tradeRef ? ` on ${facts.tradeRef}` : ''}. Nothing more is paid to it until INRP2P has checked it — that deal goes on by bank transfer to your account. Only a UPI ID in your own name is paid to.`,
          400,
        ),
        subjectRef: facts.tradeRef ?? null,
        href: '/destinations',
      };
    case 'DESTINATION_REJECTED':
      return {
        kind,
        title: 'Your UPI ID was not verified',
        body: short(`${facts.label ?? 'The UPI ID you added'} was not verified${facts.reason ? `: ${facts.reason}` : '.'} Nothing is paid to it. You can add another one.`, 400),
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
    case 'DEAL_MESSAGE':
    case 'P2P_PAY_FINAL':
    case 'P2P_RECEIPT_LATE':
      return dealDraft(kind, facts);
    case 'P2P_PAY_NOW':
    case 'P2P_PAYMENT_SENT':
      return handoffDraft(kind, facts);
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
  const href = trader ? (ref ? (p.deskDeal ? `/desk/deals/${ref}` : facts.personal ? `/deals/${ref}` : `/traders/orders/${ref}`) : '/traders') : ref ? `/trades/${ref}` : '/trades';
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

/** `14:35 IST`: a deadline as an Indian bank customer reads it, whatever the reader's device says. */
const ist = (d: Date): string => `${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }).format(d)} IST`;

/**
 * A P2P deal's chat and its clock (ADR 0023), told to either side: a new message (never its words — those stay in the
 * chat), the buyer's time to pay running out, and rupees said to be sent that the payee has not confirmed in time.
 */
function dealDraft(kind: 'DEAL_MESSAGE' | 'P2P_PAY_FINAL' | 'P2P_RECEIPT_LATE', facts: NotificationFacts): NotificationDraft {
  const p = facts.p2p ?? { audience: 'CLIENT' as const, payee: false };
  const trader = p.audience === 'TRADER';
  const ref = (trader ? facts.orderRef : facts.tradeRef) ?? null;
  const href = trader ? (ref ? (p.deskDeal ? `/desk/deals/${ref}` : facts.personal ? `/deals/${ref}` : `/traders/orders/${ref}`) : '/traders') : ref ? `/trades/${ref}` : '/trades';
  const inrAmount = facts.inr ? inr(facts.inr) : 'the rupees';
  const usdtAmount = facts.base ? usdt(facts.base) : 'the USDT';
  const on = ref ? `${ref}: ` : '';
  const deal = trader ? 'deal' : 'trade';
  const by = p.rail ? ` by ${p.rail}` : '';
  switch (kind) {
    case 'DEAL_MESSAGE':
      return p.from === 'INRP2P'
        ? { kind, title: 'INRP2P support wrote to you', body: `${on}open the ${deal} to read it and reply.`, subjectRef: ref, href }
        : { kind, title: `New message from the ${p.from === 'SELLER' ? 'seller' : 'buyer'}`, body: `${on}open the ${deal} to read it and reply.`, subjectRef: ref, href };
    case 'P2P_PAY_FINAL': {
      const until = p.until ? ` by ${ist(p.until)}` : ' in the next few minutes';
      return p.payee
        ? {
            kind,
            title: 'The buyer has not said they paid',
            body: `${on}the time to pay ${inrAmount} is up. If the buyer does not file their payment${until}, the ${deal} is cancelled and ${trader ? 'your USDT goes back to your registered wallet' : `your ${usdtAmount} goes back to the wallet you sent it from`}.`,
            subjectRef: ref,
            href,
          }
        : {
            kind,
            title: 'Your time to pay is up',
            body: `${on}if you have sent ${inrAmount}, say so with the bank’s reference${until}. After that the ${deal} is cancelled and the seller’s USDT goes back to them. If you have not paid, do not pay now.`,
            subjectRef: ref,
            href,
          };
    }
    default:
      return p.payee
        ? { kind, title: 'Has the payment arrived?', body: `${on}the buyer says they sent ${inrAmount}${by}. Check your bank app, then confirm it — or say it has not arrived. INRP2P is following it up.`, subjectRef: ref, href }
        : {
            kind,
            title: 'The seller is still checking your payment',
            body: `${on}your ${inrAmount}${by} is not confirmed yet. Bank transfers can take longer; INRP2P is checking it with the seller. Nothing is cancelled for a delay — the USDT stays locked for you.`,
            subjectRef: ref,
            href,
          };
  }
}

/**
 * A P2P deal changing hands (migration 0049): the step that has just become this side's, said the moment it does — not
 * when its time is nearly up. The buyer is told the seller's USDT is locked and until when it pays; the seller is told the
 * buyer says it paid, and to look in its own bank before it releases anything.
 */
function handoffDraft(kind: 'P2P_PAY_NOW' | 'P2P_PAYMENT_SENT', facts: NotificationFacts): NotificationDraft {
  const p = facts.p2p ?? { audience: 'CLIENT' as const, payee: false };
  const trader = p.audience === 'TRADER';
  const ref = (trader ? facts.orderRef : facts.tradeRef) ?? null;
  const href = trader ? (ref ? (p.deskDeal ? `/desk/deals/${ref}` : facts.personal ? `/deals/${ref}` : `/traders/orders/${ref}`) : '/traders') : ref ? `/trades/${ref}` : '/trades';
  const inrAmount = facts.inr ? inr(facts.inr) : 'the rupees';
  const usdtAmount = facts.base ? usdt(facts.base) : 'the USDT';
  const on = ref ? `${ref}: ` : '';
  const deal = trader ? 'order' : 'trade';
  if (kind === 'P2P_PAY_NOW') {
    const by = p.until ? ` by ${ist(p.until)}` : ' now';
    return {
      kind,
      title: 'Pay now — the seller’s USDT is locked',
      body: `${on}${usdtAmount} is locked in escrow for you. Pay ${inrAmount}${by}: the seller’s account is on the ${deal}. Pay from your own registered account, then say you paid.`,
      subjectRef: ref,
      href,
    };
  }
  const by = p.rail ? ` by ${p.rail}` : '';
  return {
    kind,
    title: 'The buyer says they paid',
    body: `${on}the buyer says they sent ${inrAmount}${by}. Check your bank app, then confirm it on the ${deal} — or say it has not arrived. Confirm only once the money is in your account.`,
    subjectRef: ref,
    href,
  };
}

const sideWords = (side: NotificationFacts['side']): string => (side === 'SELL_USDT' ? 'Sell' : 'Buy');
const orderHref = (facts: NotificationFacts): string | null => (facts.orderRef ? (facts.personal ? `/deals/${facts.orderRef}` : `/traders/orders/${facts.orderRef}`) : '/traders');

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
      // On a P2P deal the seller of the USDT moves first: its escrow clock runs from the moment the trade opens.
      if (facts.escrow && facts.side === 'SELL_USDT') {
        return {
          kind,
          title: ref ? `Your move: put ${usdtAmount} in escrow for ${ref}` : `Your move: put ${usdtAmount} in escrow`,
          body: `The buyer accepted your price. Send ${usdtAmount} from your registered wallet to the order’s escrow address within ${facts.escrow.minutes} minutes — the buyer pays you only once it is locked. Late, and the order is cancelled.`,
          subjectRef: ref,
          href: orderHref(facts),
        };
      }
      if (facts.escrow) {
        return {
          kind,
          title: ref ? `Order ${ref} is confirmed` : 'Your order is confirmed',
          body: `The seller locks ${usdtAmount} in escrow first. You are told the moment it is locked — then you pay ${inrAmount}.`,
          subjectRef: ref,
          href: orderHref(facts),
        };
      }
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
      // A P2P seller's USDT is locked, not yet paid for: the buyer's rupees come next, and the seller confirms them.
      if (facts.escrow && facts.side === 'SELL_USDT') {
        return {
          kind,
          title: `Your USDT is locked for ${ref ?? 'your order'}`,
          body: `${usdtAmount} is in escrow. The buyer now pays you ${inrAmount}; you are asked to confirm it the moment they say they paid.`,
          subjectRef: ref,
          href: orderHref(facts),
        };
      }
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
        body: 'Settled in full.',
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
    case 'TRADER_PRICE_REQUEST': {
      const ask = facts.priceAsk;
      const amount = ask ? (ask.currency === 'USDT' ? usdt(ask.amount) : `USDT for ${inr(ask.amount)}`) : 'USDT';
      const until = ask ? ` before ${ask.closesAt.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })} IST` : '';
      return {
        kind,
        title: 'Your price is asked for',
        body: `${sideWords(facts.side)} ${amount}: name your rate on Traders${until}. The best price gets the order.`,
        subjectRef: ask?.ref ?? null,
        href: '/traders',
      };
    }
    case 'TRADER_SETTLEMENT_CHANGE': {
      const c = facts.settlementChange ?? { action: 'PROPOSED' as const, what: 'BOTH' as const };
      const what = c.what === 'BANK' ? 'bank account' : c.what === 'WALLET' ? 'wallet' : 'bank account and wallet';
      const when = c.effectiveAt
        ? `${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(c.effectiveAt)}, ${ist(c.effectiveAt)}`
        : null;
      const said: Record<typeof c.action, [string, string]> = {
        PROPOSED: [
          `A new ${what} was submitted for your trader account`,
          `It can take effect from ${when ?? 'the end of the waiting period'}; until then your registered details keep settling every order. If this was not you, stop it on Traders → Settlement details now.`,
        ],
        CANCELLED: [`The change of your ${what} was stopped`, 'Your registered details stay as they are.'],
        APPLIED: [`Your new ${what} is now registered`, 'New orders settle with it; orders already finished are unchanged.'],
      };
      const [title, body] = said[c.action];
      return { kind, title, body: short(body, 400), subjectRef: null, href: '/traders/settlement' };
    }
    case 'TRADER_SIDE_EMPTY': {
      const buy = facts.side === 'BUY_USDT';
      const left = facts.sideEmpty ? (facts.sideEmpty.currency === 'INR' ? inr(facts.sideEmpty.left) : usdt(facts.sideEmpty.left)) : 'nothing';
      return {
        kind,
        title: `Your ${sideWords(facts.side)} USDT side is out of capacity`,
        body: `Completed orders used it up: ${left} is left, less than your smallest order. You get no new ${buy ? 'buy' : 'sell'} orders until you add ${buy ? 'INR' : 'USDT'} capacity on Traders.`,
        subjectRef: null,
        href: '/traders',
      };
    }
    case 'TRADER_CLIENTS_WAITING': {
      // ADR 0032: a client asked and no trader had a price for it. The trader's side in its own words; never who asks.
      const w = facts.waiting;
      const amount = w ? (w.currency === 'USDT' ? usdt(w.amount) : `USDT for ${inr(w.amount)}`) : 'USDT';
      const others = w?.clients && w.clients > 1 ? ` ${w.clients - 1} more ${w.clients === 2 ? 'client is' : 'clients are'} waiting on your side too.` : '';
      const theirs = facts.side === 'SELL_USDT' ? 'buy' : 'sell';
      return {
        kind,
        title: 'A client is waiting for your price',
        body: `Someone wants to ${theirs} ${amount} and no trader has a price for it.${others} Turn your ${sideWords(facts.side)} USDT price on in Traders and the deal comes to you.`,
        subjectRef: null,
        href: '/traders',
      };
    }
    case 'PEER_MATCH_OFFERED': {
      // ADR 0033: the maker — another client said yes to its price. What it gives and gets, and until when it can start.
      const m = facts.peer!;
      const sells = m.direction === 'SELL_USDT';
      return {
        kind,
        title: sells ? 'A buyer took your price' : 'A seller took your price',
        body: sells
          ? `Another INRP2P client buys ${usdt(m.base)} from you for ${inr(m.inr)} at ₹${m.rate}, network ${usdt(m.network)} included. Start the deal${m.until ? ` by ${ist(m.until)}` : ''} — they pay only after your USDT is in escrow.`
          : `Another INRP2P client sells you ${usdt(m.base)} for ${inr(m.inr)} at ₹${m.rate}, network ${usdt(m.network)} included. Start the deal${m.until ? ` by ${ist(m.until)}` : ''} — you pay only after their USDT is in escrow.`,
        subjectRef: null,
        href: '/exchange',
      };
    }
    case 'PEER_MATCH_WAITING': {
      // ADR 0033: the taker — its yes stands while the other client starts.
      const m = facts.peer!;
      const buys = m.direction === 'BUY_USDT';
      return {
        kind,
        title: buys ? 'We asked the seller to start' : 'We asked the buyer to start',
        body: `Your price ₹${m.rate} for ${usdt(m.base)} is held for you${m.until ? ` until ${ist(m.until)}` : ''}. The deal starts the moment they say yes, and we tell you here. You can close the page.`,
        subjectRef: null,
        href: '/exchange',
      };
    }
    case 'PEER_MATCH_ENDED': {
      const m = facts.peer!;
      const other = m.direction === 'BUY_USDT' ? 'seller' : 'buyer';
      const said: Record<string, [string, string]> = {
        MAKER_SILENT: m.role === 'MAKER'
          ? ['You did not start the deal in time', 'The client who took your price moved on. Your request is paused — tap “Still looking” on the Exchange and it is a price for others again.']
          : [`The ${other} did not start in time`, 'Your request keeps looking, and your place in line is kept.'],
        MAKER_DECLINED: [`The ${other} did not take this one`, 'Your request keeps looking, and your place in line is kept.'],
        MAKER_WITHDREW: [`The ${other} stopped looking`, 'Your request keeps looking, and your place in line is kept.'],
        TAKER_WITHDREW: [`The ${other} stopped looking`, 'Your request keeps looking. Nothing was committed.'],
      };
      const [title, body] = said[m.reason ?? ''] ?? ['This meeting is over', 'Your request keeps looking. Nothing was committed.'];
      return { kind, title, body, subjectRef: null, href: '/exchange' };
    }
    case 'PEER_DEAL_STARTED': {
      const m = facts.peer!;
      const sells = m.direction === 'SELL_USDT';
      return {
        kind,
        title: 'Your deal started',
        body: sells
          ? `Send ${usdt(m.base)} to the deal’s escrow now — the buyer pays ${inr(m.inr)} to your account only after it lands.`
          : `The seller is locking ${usdt(m.base)} in escrow. We tell you the moment it is your turn to pay ${inr(m.inr)}.`,
        subjectRef: m.orderRef ?? null,
        href: m.orderRef ? `/deals/${m.orderRef}` : '/exchange',
      };
    }
    case 'PEER_NEARBY': {
      const m = facts.peer!;
      const buys = m.direction === 'BUY_USDT';
      const other = buys ? 'seller' : 'buyer';
      const own = m.ownRate ? ` — you asked ₹${m.ownRate}` : '';
      return {
        kind,
        title: m.near === 'READY' ? `A ${other} is ready at ₹${m.rate}` : `A ${other} is close to your price`,
        body: m.near === 'READY'
          ? `Another INRP2P client ${buys ? 'sells' : 'buys'} at ₹${m.rate}${own}. Meet it in one tap; the deal starts when they say yes.`
          : `Another INRP2P client ${buys ? 'sells' : 'buys'} at ₹${m.rate}${own}. Meet it in one tap, or keep yours and we keep looking.`,
        subjectRef: null,
        href: '/exchange',
      };
    }
    case 'WAITING_RESUMED':
      return {
        kind,
        title: 'Still looking for you',
        body: `The price we held for you ran out. We kept your place and keep looking${facts.expiresAt ? ` until ${ist(facts.expiresAt)}` : ''}.`,
        subjectRef: null,
        href: '/exchange',
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
