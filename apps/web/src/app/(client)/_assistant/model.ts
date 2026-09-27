import { Money, Rate } from '@inrp2p/kernel';
import type { ClientDestinations, ExchangeView, HistoryRow, PortalTrade } from '@inrp2p/portal';
import { formatInr, formatIstDateTime, formatIstTime, formatRate, formatUsdtHeadline } from '@inrp2p/ui/format';
import type { RobotMood } from '../../(public)/_landing/robot/cues.ts';

/**
 * What the workspace's robot reports on each page, derived from what the server returned for it and nothing else.
 *
 * The robot is an execution assistant, not a conversation (PRODUCT: "not an AI assistant"): it says what state the
 * client's business with the desk is in, and what — if anything — is theirs to do next. So every function here is
 * pure over the page's own projection. A mood can only be one the backend is in, and every sentence is a fact of
 * record or a step the product actually takes. No rate, estimate or promise appears that the desk has not made.
 */
export interface AssistantState {
  /** The robot's held state (`cues.ts` `RobotMood`). */
  readonly mood: RobotMood;
  /** The chip beside the robot: a word or two. */
  readonly label: string;
  readonly title: string;
  readonly body: string;
}

export type StepStatus = 'done' | 'current' | 'pending' | 'exception';

export interface Step {
  readonly label: string;
  readonly status: StepStatus;
  readonly detail?: string;
}

type Direction = 'SELL_USDT' | 'BUY_USDT';

const usdt = (amount: string) => formatUsdtHeadline(Money.parse(amount, 'USDT'));
const inr = (amount: string) => formatInr(Money.parse(amount, 'INR'));
const rate = (value: string) => formatRate(Rate.parse(value, 'CLIENT'));

/** Whether a quote the server still calls SENT has in fact run out — the expiry job may not have caught up yet. */
export function quoteLive(quote: { status: string; expiresAt: string | null }, now: number): boolean {
  return quote.status === 'SENT' && quote.expiresAt !== null && Date.parse(quote.expiresAt) > now;
}

/** The request's own amount, in the currency its fixed side is in. */
export function requestAmount(request: { amount: string; currency: 'USDT' | 'INR' }): string {
  return request.currency === 'USDT' ? usdt(request.amount) : inr(request.amount);
}

/** Request → quote → acceptance → trade, as far as this client's latest request has gone. */
export function requestSteps(view: ExchangeView, now: number): readonly Step[] {
  const request = view.request;
  const quote = view.quote;
  const sent: Step = { label: 'Request sent', status: 'done', ...(request ? { detail: formatIstTime(new Date(request.createdAt)) } : {}) };
  if (quote && quoteLive(quote, now)) {
    return [sent, { label: 'Desk priced it', status: 'done' }, { label: 'You accept or decline', status: 'current' }, { label: 'Trade opens', status: 'pending' }];
  }
  return [sent, { label: 'Desk prices it', status: 'current' }, { label: 'You accept or decline', status: 'pending' }, { label: 'Trade opens', status: 'pending' }];
}

export function exchangeAssistant(view: ExchangeView, opts: { canAccept: boolean; now: number }): AssistantState {
  const { request, quote } = view;
  const withDesk = request !== null && (request.status === 'OPEN' || request.status === 'QUOTED');
  if (withDesk && quote && quoteLive(quote, opts.now)) {
    const until = formatIstTime(new Date(quote.expiresAt!));
    return {
      mood: 'focused',
      label: 'Quote ready',
      title: `Firm quote ${quote.ref}`,
      body: opts.canAccept
        ? `${rate(quote.clientRate)} per USDT, held until ${until}. Accepting opens the trade at this rate.`
        : `Held until ${until}. Someone with acceptance rights on your account has to accept it.`,
    };
  }
  if (withDesk && quote) {
    return {
      mood: 'alert',
      label: 'Quote expired',
      title: `${quote.ref} is no longer held`,
      body: `Its price ran out before it was accepted. Request ${request.ref} goes back to the desk, which may send a new quote.`,
    };
  }
  if (withDesk) {
    return {
      mood: 'waiting',
      label: 'Desk pricing',
      title: `The desk is pricing ${request.ref}`,
      body: 'The firm quote appears here, and in Notifications, as soon as it is sent. Nothing is committed until you accept it.',
    };
  }
  const { banks, wallets } = view.destinations;
  if (banks.length === 0 && wallets.filter((w) => w.purpose !== 'SOURCE').length === 0) {
    return {
      mood: 'alert',
      label: 'Setup needed',
      title: 'No destination on file',
      body: 'A request needs somewhere to pay you. The desk adds bank accounts and wallets to your account — see Destinations.',
    };
  }
  if (request?.status === 'DECLINED') {
    return {
      mood: 'alert',
      label: 'Declined',
      title: `The desk declined ${request.ref}`,
      body: `${request.statusReason ? `“${request.statusReason}”` : 'No reason was given.'} You can send a new request.`,
    };
  }
  return {
    mood: 'none',
    label: 'Ready',
    title: 'Ready for your request',
    body: 'Choose a direction and an amount. The desk prices it and sends you a firm quote to accept or decline.',
  };
}

/** Lifecycle states in which the client's own leg has not yet been confirmed. */
const AWAITING_CLIENT = new Set(['AWAITING_FIRST_LEG', 'FIRST_LEG_DETECTED']);
const OPEN = new Set(['AWAITING_FIRST_LEG', 'FIRST_LEG_DETECTED', 'FIRST_LEG_CONFIRMED', 'SETTLING', 'PARTIALLY_SETTLED']);

export const isOpenTrade = (status: string): boolean => OPEN.has(status);

/**
 * The four stages of a trade from its lifecycle state alone — the stages the trade screen shows, for a row that
 * has only its status. Null for a cancelled trade: how far it had got is not in its status, and a stepper that
 * guessed would be telling the client something the record does not.
 */
export function lifecycleSteps(direction: Direction, status: string): readonly Step[] | null {
  if (status === 'CANCELLED') return null;
  const sell = direction === 'SELL_USDT';
  const labels = sell ? ['Quote accepted', 'USDT received', 'INR payout', 'Completed'] : ['Quote accepted', 'INR received', 'USDT sent', 'Completed'];
  const current = status === 'COMPLETED' ? labels.length : AWAITING_CLIENT.has(status) ? 1 : 2;
  const detail =
    current === 1
      ? status === 'FIRST_LEG_DETECTED'
        ? 'seen, waiting to be final'
        : sell
          ? 'waiting for your USDT'
          : 'waiting for your INR'
      : status === 'FIRST_LEG_CONFIRMED'
        ? 'preparing your payment'
        : 'paying out';
  return labels.map((label, i) =>
    i < current ? { label, status: 'done' as const } : i === current ? { label, status: 'current' as const, detail } : { label, status: 'pending' as const },
  );
}

export function tradeAssistant(view: PortalTrade): AssistantState {
  const { trade, settlement } = view;
  const sell = trade.direction === 'SELL_USDT';
  if (trade.status === 'CANCELLED') {
    return {
      mood: 'alert',
      label: 'Cancelled',
      title: `${trade.ref} was cancelled`,
      body: 'Nothing further moves on this trade. The reason is in your notifications.',
    };
  }
  if (view.onHold) {
    return {
      mood: 'alert',
      label: 'On hold',
      title: 'Paused while the desk checks something',
      body: 'Nothing is lost. The trade moves on as soon as the check is done, and you will see it here.',
    };
  }
  if (trade.status === 'COMPLETED') {
    const paid = sell ? inr(trade.inr.amount) : usdt(trade.base.amount);
    return {
      mood: 'success',
      label: 'Completed',
      title: `${trade.ref} is settled`,
      body: `${paid} paid in full to ${view.destination}. ${view.receipt ? 'The settlement receipt is ready.' : 'The settlement receipt follows shortly.'}`,
    };
  }
  if (AWAITING_CLIENT.has(trade.status)) {
    if (sell && view.incoming && view.incoming.state === 'DETECTED') {
      return {
        mood: 'verifying',
        label: 'Verifying',
        title: 'Your USDT is on-chain',
        body: 'Waiting for the transfer to be final on TRON. Nothing more is needed from you.',
      };
    }
    return sell
      ? {
          mood: 'waiting',
          label: 'Awaiting USDT',
          title: `Send ${usdt(trade.depositInstructions?.amount ?? trade.base.amount)}`,
          body: 'Exactly that amount, to this trade’s own deposit address on TRC20. The transfer is picked up on-chain.',
        }
      : {
          mood: 'waiting',
          label: 'Awaiting INR',
          title: `Waiting for your ${inr(trade.inr.amount)}`,
          body: 'The desk confirms your payment by its bank reference (UTR), then sends your USDT.',
        };
  }
  const confirming = settlement.payments.some((p) => p.status === 'PROCESSING' || p.status === 'SENT' || p.status === 'EVIDENCE_RECORDED');
  if (confirming) {
    return {
      mood: 'verifying',
      label: 'Confirming payout',
      title: sell ? 'A payment is on its way' : 'Your USDT is on its way',
      body: 'It shows here as completed, with its reference, as soon as it lands.',
    };
  }
  const remaining = settlement.remaining.currency === 'INR' ? inr(settlement.remaining.amount) : usdt(settlement.remaining.amount);
  return {
    mood: 'waiting',
    label: 'Paying out',
    title: `${remaining} still to come`,
    body: sell
      ? 'Your USDT is final on-chain. The desk pays the INR in one or more transfers, each shown here with its reference.'
      : 'The desk has your INR, and sends the USDT to your wallet.',
  };
}

export function historyAssistant(rows: readonly HistoryRow[], counts: { readonly all: number; readonly open: number; readonly completed: number }): AssistantState {
  const held = rows.filter((r) => r.onHold && isOpenTrade(r.status));
  if (held.length > 0) {
    return {
      mood: 'alert',
      label: 'On hold',
      title: held.length === 1 ? `${held[0]!.ref} is paused` : `${held.length} trades are paused`,
      body: 'The desk is checking something. Nothing is lost, and each trade moves on as soon as the check is done.',
    };
  }
  const yours = rows.filter((r) => r.status === 'AWAITING_FIRST_LEG');
  if (yours.length > 0) {
    const first = yours.at(-1)!;
    return {
      mood: 'focused',
      label: 'Needs you',
      title: yours.length === 1 ? `${first.ref} is waiting for your ${first.direction === 'SELL_USDT' ? 'USDT' : 'INR'}` : `${yours.length} trades are waiting for your funds`,
      body: 'Open a trade for the exact amount and where it goes.',
    };
  }
  const seen = rows.filter((r) => r.status === 'FIRST_LEG_DETECTED');
  if (seen.length > 0) {
    return {
      mood: 'verifying',
      label: 'Verifying',
      title: seen.length === 1 ? `USDT for ${seen[0]!.ref} is on-chain` : `${seen.length} transfers are on-chain`,
      body: 'Waiting for them to be final on TRON. Nothing more is needed from you.',
    };
  }
  if (counts.open > 0) {
    return {
      mood: 'waiting',
      label: 'In progress',
      title: counts.open === 1 ? 'One trade is paying out' : `${counts.open} trades are paying out`,
      body: 'Each payment appears on its trade with its reference as it lands.',
    };
  }
  if (counts.all === 0) {
    return { mood: 'none', label: 'No trades yet', title: 'Nothing here yet', body: 'A trade appears here the moment a quote is accepted.' };
  }
  return {
    mood: 'none',
    label: 'All settled',
    title: 'Nothing in progress',
    body: `${counts.completed === 1 ? 'One trade' : `${counts.completed} trades`} settled. A receipt is issued for each one.`,
  };
}

export interface Readiness {
  readonly sell: boolean;
  readonly buy: boolean;
}

/** Which directions this client can ask for: each needs an active destination of its own kind (`request.create`). */
export function readiness(destinations: ClientDestinations): Readiness {
  return {
    sell: destinations.banks.some((b) => b.status === 'ACTIVE'),
    buy: destinations.wallets.some((w) => w.status === 'ACTIVE' && w.purpose !== 'SOURCE'),
  };
}

export function destinationsAssistant(destinations: ClientDestinations): AssistantState {
  const ready = readiness(destinations);
  if (ready.sell && ready.buy) {
    return {
      mood: 'none',
      label: 'Ready',
      title: 'Ready for both directions',
      body: 'Selling pays INR to your bank account; buying delivers USDT to your wallet.',
    };
  }
  if (ready.sell) {
    return { mood: 'none', label: 'Ready to sell', title: 'Buying USDT needs a wallet', body: 'Ask the desk to add a TRC20 wallet for deliveries. Selling is ready now.' };
  }
  if (ready.buy) {
    return { mood: 'none', label: 'Ready to buy', title: 'Selling USDT needs a bank account', body: 'Ask the desk to add an account for INR payouts. Buying is ready now.' };
  }
  return {
    mood: 'alert',
    label: 'Setup needed',
    title: 'No destinations yet',
    body: 'The desk adds bank accounts and wallets to your account after checking them. Ask on your usual channel.',
  };
}

/** "20 Sep 2026, 22:35 IST" for a timestamp of record. */
export const at = (iso: string): string => formatIstDateTime(new Date(iso));
