import type { TraderOrderStatus, TraderSide } from '@inrp2p/db';
import type { P2pStep } from '@inrp2p/settlement';

/**
 * Where one order stands, from the trader's side, as pure functions of facts of record. The screen, the robot and
 * the notifications all read this, so "what is happening" and "what do I do now" have one answer.
 *
 * - `OFFER`: offered, waiting for the trader to accept or decline.
 * - `HELD`: accepted; capacity held while the trade is confirmed with the other side.
 * - `AWAITING_FUNDING`: the trade is open; the other side's funds are not confirmed yet.
 * - `YOUR_TURN`: the other side is funded; the trader sends its INR (Buy USDT) or USDT (Sell USDT).
 * - `CHECKING_YOURS`: the trader's payment is recorded or seen on chain and being confirmed.
 * - `INRP2P_SENDING`: the trader's side is confirmed; INRP2P is sending the other asset.
 * - `CHECKING_INRP2P`: INRP2P's payment to the trader is recorded and being confirmed.
 * - `REVIEW`: something reached the order that the desk has to look at (a transfer from another wallet).
 * - `COMPLETED` / `CLOSED`: finished; closed covers declined, expired, withdrawn, released and cancelled.
 */
export type OrderStage = 'OFFER' | 'HELD' | 'AWAITING_FUNDING' | 'YOUR_TURN' | 'CHECKING_YOURS' | 'INRP2P_SENDING' | 'CHECKING_INRP2P' | 'REVIEW' | 'COMPLETED' | 'CLOSED';

export interface StageFacts {
  readonly status: TraderOrderStatus;
  /** The other side's funds are confirmed (the client trade is past its first leg). */
  readonly counterpartyFunded: boolean;
  /** What the trader still owes on its own side, in minor units; 0 once confirmed in full. */
  readonly traderOwedMinor: bigint;
  /** A payment of the trader's is recorded or detected but not yet confirmed. */
  readonly traderPaymentPending: boolean;
  /** What INRP2P still owes the trader, in minor units. */
  readonly inrp2pOwedMinor: bigint;
  /** A payment of INRP2P's to the trader is recorded but not yet confirmed. */
  readonly inrp2pPaymentPending: boolean;
  /** A transfer reached this order's address that could not be counted (another wallet, too much). */
  readonly needsReview: boolean;
}

export function orderStage(f: StageFacts): OrderStage {
  switch (f.status) {
    case 'OFFERED':
      return 'OFFER';
    case 'ACCEPTED':
      return 'HELD';
    case 'COMPLETED':
      return 'COMPLETED';
    case 'IN_PROGRESS':
      break;
    default:
      return 'CLOSED';
  }
  if (f.needsReview) return 'REVIEW';
  if (!f.counterpartyFunded) return 'AWAITING_FUNDING';
  if (f.traderOwedMinor > 0n) return f.traderPaymentPending ? 'CHECKING_YOURS' : 'YOUR_TURN';
  if (f.inrp2pOwedMinor > 0n) return f.inrp2pPaymentPending ? 'CHECKING_INRP2P' : 'INRP2P_SENDING';
  // Both sides are allocated; the order completes on the next reconciliation.
  return 'CHECKING_INRP2P';
}

export type StepStatus = 'done' | 'current' | 'pending' | 'exception';

export interface OrderStep {
  readonly label: string;
  readonly status: StepStatus;
  readonly detail?: string;
}

/** The five steps of a started order, in the order money moves, labelled for the trader's side. */
export function orderSteps(side: TraderSide, stage: OrderStage): OrderStep[] {
  const buy = side === 'BUY_USDT';
  const labels = ['Order accepted', 'Other side funded', buy ? 'You pay INR' : 'You send USDT', buy ? 'You receive USDT' : 'You receive INR', 'Completed'];
  const at: Record<OrderStage, number> = {
    OFFER: 0,
    HELD: 1,
    AWAITING_FUNDING: 1,
    YOUR_TURN: 2,
    CHECKING_YOURS: 2,
    REVIEW: 2,
    INRP2P_SENDING: 3,
    CHECKING_INRP2P: 3,
    COMPLETED: 5,
    CLOSED: -1,
  };
  const detail: Partial<Record<OrderStage, string>> = {
    OFFER: 'waiting for you',
    HELD: 'the trade is being confirmed',
    AWAITING_FUNDING: 'waiting for their funds',
    YOUR_TURN: 'your turn',
    CHECKING_YOURS: 'being checked',
    REVIEW: 'the desk is reviewing a transfer',
    INRP2P_SENDING: buy ? 'INRP2P is sending your USDT' : 'INRP2P is paying your INR',
    CHECKING_INRP2P: 'being confirmed',
  };
  const current = at[stage];
  return labels.map((label, i) => {
    if (stage === 'CLOSED') return { label, status: 'pending' as const };
    if (i < current) return { label, status: 'done' as const };
    if (i === current) {
      const d = detail[stage];
      return { label, status: stage === 'REVIEW' ? ('exception' as const) : ('current' as const), ...(d ? { detail: d } : {}) };
    }
    return { label, status: 'pending' as const };
  });
}

/** The stages in which the trader itself has something to do. */
export const TRADER_ACTION_STAGES: ReadonlySet<OrderStage> = new Set(['OFFER', 'YOUR_TURN']);

/**
 * A P2P order (ADR 0019), from the trader's side: the rupees go straight between it and the client, the USDT through
 * the deal's escrow. Selling USDT, the trader funds the escrow first and later confirms the client's rupees; buying,
 * it pays the client once the client's USDT is in escrow, and the client confirms.
 */
export function p2pOrderStage(side: TraderSide, status: TraderOrderStatus, step: P2pStep): OrderStage {
  if (status !== 'IN_PROGRESS') return orderStage({ status, counterpartyFunded: false, traderOwedMinor: 0n, traderPaymentPending: false, inrp2pOwedMinor: 0n, inrp2pPaymentPending: false, needsReview: false });
  const sells = side === 'SELL_USDT';
  switch (step) {
    case 'ESCROW':
      return sells ? 'YOUR_TURN' : 'AWAITING_FUNDING';
    case 'PAY':
      return sells ? 'AWAITING_FUNDING' : 'YOUR_TURN';
    case 'CONFIRM':
      return sells ? 'YOUR_TURN' : 'CHECKING_YOURS';
    case 'RELEASE':
      return 'INRP2P_SENDING';
    case 'DONE':
      return 'CHECKING_INRP2P';
    case 'REFUND':
      // The client's USDT goes back from a deal the trader did not pay: nothing is the trader's to do.
      return 'REVIEW';
    default:
      return 'CLOSED';
  }
}

/** The five steps of a started P2P order, labelled for the trader's side. */
export function p2pOrderSteps(side: TraderSide, status: TraderOrderStatus, step: P2pStep, disputed = false): OrderStep[] {
  const sells = side === 'SELL_USDT';
  const labels = sells
    ? ['Order accepted', 'You put USDT in escrow', 'Buyer pays you INR', 'You confirm the INR', 'Escrow released']
    : ['Order accepted', 'Seller’s USDT in escrow', 'You pay INR', 'Seller confirms your INR', 'You receive USDT'];
  // A refund happens only on a trader's Buy order (a client's SELL it did not pay): it stops at the trader's payment.
  const at: Record<P2pStep, number> = { ESCROW: 1, PAY: 2, CONFIRM: 3, RELEASE: 4, REFUND: 2, DONE: 4, CANCELLED: -1 };
  const yours = sells ? new Set<P2pStep>(['ESCROW', 'CONFIRM']) : new Set<P2pStep>(['PAY']);
  const current = status === 'COMPLETED' ? 5 : status === 'IN_PROGRESS' ? at[step] : -1;
  return labels.map((label, i) => {
    if (current < 0) return { label, status: 'pending' as const };
    if (i < current) return { label, status: 'done' as const };
    if (i === current && step === 'REFUND') return { label, status: 'exception' as const, detail: 'not paid — the seller’s USDT goes back' };
    if (i === current && disputed) return { label, status: 'exception' as const, detail: 'INRP2P is checking the payment' };
    if (i === current) return { label, status: 'current' as const, detail: yours.has(step) ? 'your turn' : step === 'RELEASE' ? 'INRP2P is releasing it' : 'waiting for the other side' };
    return { label, status: 'pending' as const };
  });
}
