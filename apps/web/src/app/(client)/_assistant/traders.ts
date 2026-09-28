import { Money } from '@inrp2p/kernel';
import type { OrderSummary, TraderHome, TraderOrderDetail } from '@inrp2p/traders';
import { formatInr, formatUsdtHeadline } from '@inrp2p/ui/format';
import type { AssistantState } from './model.ts';

/**
 * What the robot reports on the Traders screens — derived from the trader's own projection and nothing else, like
 * the rest of the workspace (`model.ts`). The moods are the ones the robot already has:
 *
 * - `ready` — online and waiting for orders (or offline, standing by);
 * - `focused` — a new order is offered and the trader can take it;
 * - `waiting` — the other side, or INRP2P, has the next move;
 * - `verifying` — a payment is being checked (bank or chain);
 * - `success` — an order completed;
 * - `alert` — the trader has to act, or something stops orders.
 *
 * One short sentence each, and never a promise the backend has not made.
 */
const usdt = (amount: string) => formatUsdtHeadline(Money.parse(amount, 'USDT'));
const inr = (amount: string) => formatInr(Money.parse(amount, 'INR'));
const owed = (o: Pick<OrderSummary, 'side' | 'youOwe'>) => (o.youOwe ? (o.side === 'BUY_USDT' ? inr(o.youOwe) : usdt(o.youOwe)) : null);
const sideName = (side: OrderSummary['side']) => (side === 'BUY_USDT' ? 'Buy USDT' : 'Sell USDT');

/** One started or held order, in the robot's words: whose move it is, and what it is. */
function orderState(o: OrderSummary): AssistantState | null {
  switch (o.stage) {
    case 'OFFER':
      return { mood: 'focused', label: 'New order', title: `New order ${o.ref}`, body: 'A new order matches your available capacity.' };
    case 'YOUR_TURN':
      return {
        mood: 'alert',
        label: 'Your turn',
        title: `Send ${owed(o) ?? (o.side === 'BUY_USDT' ? 'your INR' : 'your USDT')} for ${o.ref}`,
        body: o.side === 'BUY_USDT' ? 'The other side is funded. INRP2P’s account details are on the order.' : 'The other side is funded. The order’s own address is on the order.',
      };
    case 'REVIEW':
      return { mood: 'alert', label: 'Needs review', title: `${o.ref} needs the desk`, body: 'A transfer reached this order from a wallet that is not yours. The desk is reviewing it.' };
    case 'CHECKING_YOURS':
      return {
        mood: 'verifying',
        label: 'Verifying',
        title: `Checking your ${o.side === 'BUY_USDT' ? 'payment' : 'USDT'}`,
        body: o.side === 'BUY_USDT' ? 'Payment confirmation is still pending.' : 'Your USDT is on-chain and becoming final.',
      };
    case 'CHECKING_INRP2P':
      return { mood: 'verifying', label: 'Verifying', title: `INRP2P’s payment for ${o.ref}`, body: `Your ${o.side === 'BUY_USDT' ? 'USDT' : 'INR'} is being confirmed.` };
    case 'INRP2P_SENDING':
      return { mood: 'waiting', label: 'In progress', title: `Your side of ${o.ref} is confirmed`, body: `INRP2P is sending your ${o.side === 'BUY_USDT' ? 'USDT' : 'INR'}.` };
    case 'AWAITING_FUNDING':
      return { mood: 'waiting', label: 'Waiting', title: `${o.ref} is waiting for the other side`, body: 'You will be told the moment it is your turn to send.' };
    case 'HELD':
      return { mood: 'waiting', label: 'Held', title: `${o.ref} is held for you`, body: 'Your capacity is held while the trade is confirmed.' };
    default:
      return null;
  }
}

/** Which order state speaks first when several are open: an offer (it expires), then the trader's turn, then checks. */
const STAGE_ORDER: Readonly<Record<string, number>> = { OFFER: 0, YOUR_TURN: 1, REVIEW: 2, CHECKING_YOURS: 3, CHECKING_INRP2P: 4, INRP2P_SENDING: 5, AWAITING_FUNDING: 6, HELD: 7 };

export function traderHomeAssistant(home: TraderHome): AssistantState {
  switch (home.state) {
    case 'NONE':
      return { mood: 'ready', label: 'Traders', title: 'Provide liquidity', body: 'Set how much INR or USDT you can provide. INRP2P sends matching orders to you.' };
    case 'UNDER_REVIEW':
      return { mood: 'waiting', label: 'Under review', title: 'Your application is under review', body: 'The desk checks your registered bank account and wallet. You will be told here and in Notifications.' };
    case 'REJECTED':
      return { mood: 'alert', label: 'Not approved', title: 'Your application was not approved', body: home.application?.reviewNote ?? 'You can apply again.' };
    case 'PAUSED':
      return { mood: 'alert', label: 'Paused', title: 'Your trader account is paused', body: `No new orders are assigned. Orders in progress continue.${home.controlNote ? ` Reason: ${home.controlNote}` : ''}` };
    default:
      break;
  }
  const open = [...home.offers, ...home.active].map((o) => ({ o, s: orderState(o) })).filter((x): x is { o: OrderSummary; s: AssistantState } => x.s !== null);
  open.sort((a, b) => (STAGE_ORDER[a.o.stage] ?? 9) - (STAGE_ORDER[b.o.stage] ?? 9));
  const first = open[0];
  if (first && (first.o.stage === 'OFFER' || first.o.stage === 'YOUR_TURN' || first.o.stage === 'REVIEW')) return first.s;

  if (home.issues.includes('RESERVE_SHORT') && home.reserve) {
    return { mood: 'alert', label: 'Reserve', title: 'Top up your Security Reserve', body: `${usdt(home.reserve.shortfall)} more is needed before new orders can be assigned.` };
  }
  if (home.issues.includes('DESTINATIONS_INACTIVE')) {
    return { mood: 'alert', label: 'Settlement details', title: 'Your registered details changed', body: 'Your registered bank account or wallet is no longer active. Ask the desk to review them.' };
  }
  if (home.issues.includes('ASSIGNMENTS_DISABLED')) {
    return { mood: 'alert', label: 'On hold', title: 'New orders are paused by INRP2P', body: home.controlNote ?? 'Orders in progress continue.' };
  }
  if (first) return first.s;
  if (home.recentlyCompleted) {
    const r = home.recentlyCompleted;
    return { mood: 'success', label: 'Completed', title: `${r.ref} completed`, body: `Order completed. Nothing is held for it any more.${r.reward ? ` Reward earned: ${inr(r.reward)}.` : ''}` };
  }
  if (!home.available) return { mood: 'ready', label: 'Offline', title: 'You’re offline', body: 'No new orders are assigned. Switch on when you are ready.' };
  if (!home.blocks.some((b) => b.status === 'ACTIVE')) {
    return { mood: 'ready', label: 'Online', title: 'You’re online', body: 'Make a side active, with a rate and an order size, to receive orders.' };
  }
  return { mood: 'ready', label: 'Online', title: 'You’re online', body: 'New matching orders can be assigned to you.' };
}

export function traderOrderAssistant(detail: TraderOrderDetail): AssistantState {
  const o = detail.order;
  const live = orderState(o);
  if (live) return live;
  if (o.status === 'COMPLETED') {
    return { mood: 'success', label: 'Completed', title: `${o.ref} completed`, body: `Order completed. Nothing is held for it any more.${o.reward ? ` Reward earned: ${inr(o.reward)}.` : ''}` };
  }
  return { mood: 'ready', label: STATUS_WORDS[o.status] ?? 'Closed', title: `${o.ref} is closed`, body: o.closeNote ?? 'Nothing is held for it any more.' };
}

/** `rows` are the trader's open orders (whichever tab is on screen); `counts` cover both tabs. */
export function traderOrdersAssistant(rows: readonly OrderSummary[], counts: { active: number; completed: number }): AssistantState {
  const open = rows.map((o) => ({ o, s: orderState(o) })).filter((x): x is { o: OrderSummary; s: AssistantState } => x.s !== null);
  open.sort((a, b) => (STAGE_ORDER[a.o.stage] ?? 9) - (STAGE_ORDER[b.o.stage] ?? 9));
  if (open[0]) return open[0].s;
  if (counts.active > 0) return { mood: 'waiting', label: 'In progress', title: counts.active === 1 ? 'One order in progress' : `${counts.active} orders in progress`, body: 'Nothing is needed from you right now.' };
  if (counts.completed === 0) return { mood: 'ready', label: 'No orders yet', title: 'Nothing here yet', body: 'An order appears here the moment INRP2P offers you one.' };
  return { mood: 'ready', label: 'All settled', title: 'Nothing in progress', body: `${counts.completed === 1 ? 'One order' : `${counts.completed} orders`} finished.` };
}

export const STATUS_WORDS: Readonly<Record<string, string>> = {
  OFFERED: 'New order',
  ACCEPTED: 'Held',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  DECLINED: 'Declined',
  EXPIRED: 'Expired',
  WITHDRAWN: 'Withdrawn',
  RELEASED: 'Released',
  CANCELLED: 'Cancelled',
};

export { sideName };
