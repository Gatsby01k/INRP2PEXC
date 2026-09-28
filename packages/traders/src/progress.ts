import type { TraderOrderStatus, TraderSide } from '@inrp2p/db';

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
