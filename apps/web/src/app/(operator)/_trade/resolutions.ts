import type { ExceptionType } from '@inrp2p/db';
import type { NON_FINANCIAL_RESOLUTIONS } from '@inrp2p/settlement';

export type Resolution = (typeof NON_FINANCIAL_RESOLUTIONS)[number];

export interface ResolutionOption {
  readonly value: Resolution;
  readonly label: string;
}

export interface ResolutionChoices {
  /** Resolutions that close the case as it stands. Never empty: every case type must have a way out. */
  readonly resolutions: readonly ResolutionOption[];
  /** True when the spec's way out is that the case should not have been opened (`void`). */
  readonly voidable: boolean;
  /**
   * What the desk must do elsewhere when the honest answer moves money. Stated rather than offered, because a
   * refund or a cancellation is its own command with its own approval — a dropdown that pretended to perform
   * one would be lying about what the click does (FI-31).
   */
  readonly financial: string | null;
}

/**
 * Every exception type's resolutions, exactly as DOMAIN_MODEL §3 lists them.
 *
 * The table is here rather than inside the panel so a test can hold it against `EXCEPTION_TYPES` and fail when
 * the domain grows a case the desk cannot close. A case with no way out is not an edge case — it is a trade
 * frozen on hold with nobody able to release it, which is the worst thing this system can do to a client.
 */
export const RESOLUTIONS: Record<ExceptionType, ResolutionChoices> = {
  USDT_WRONG_AMOUNT: {
    resolutions: [
      { value: 'await_top_up', label: 'Wait for the client to top up' },
      { value: 'escalate', label: 'Escalate' },
    ],
    voidable: false,
    financial: 'Adjusting the trade to what arrived, or refunding and cancelling, is a financial resolution and needs a second approver.',
  },
  USDT_OVERPAYMENT: {
    resolutions: [
      { value: 'hold_in_suspense', label: 'Hold the excess in suspense' },
      { value: 'escalate', label: 'Escalate' },
    ],
    voidable: false,
    financial: 'Refunding the excess, or re-pricing the trade to what arrived, is a financial resolution and needs a second approver.',
  },
  USDT_UNEXPECTED_SENDER: {
    resolutions: [
      { value: 'accept_sender', label: 'Accept this sender' },
      { value: 'escalate', label: 'Escalate' },
    ],
    voidable: false,
    financial: 'Refunding the sender is a financial resolution and needs a second approver.',
  },
  WRONG_NETWORK: {
    resolutions: [
      { value: 'record_recovery_outcome', label: 'Record what recovery found' },
      { value: 'escalate', label: 'Escalate' },
    ],
    voidable: false,
    financial: 'Cancelling the trade is its own command on the trade.',
  },
  TX_NOT_FINAL: {
    resolutions: [
      { value: 'escalate', label: 'Escalate' },
    ],
    voidable: true,
    financial: 'This case closes itself when the chain solidifies the transaction. Void it only if it never will.',
  },
  ROUTE_DIRECT_PAYOUT_MISMATCH: {
    resolutions: [
      { value: 'record_correct_route', label: 'Record the correct route' },
      { value: 'escalate', label: 'Escalate' },
    ],
    voidable: false,
    financial: 'Reclassifying the payer, or correcting the amounts, is a financial resolution and needs a second approver.',
  },
  FUNDS_AFTER_TRADE_CLOSED: {
    resolutions: [
      { value: 'hold_in_suspense', label: 'Hold in suspense' },
      { value: 'escalate', label: 'Escalate' },
    ],
    voidable: false,
    financial: 'Re-quoting for the same client, or refunding, is its own command and needs two people.',
  },
  UNALLOCATED_DEPOSIT: {
    resolutions: [
      { value: 'hold_in_suspense', label: 'Hold in suspense' },
      { value: 'escalate', label: 'Escalate' },
    ],
    voidable: false,
    financial: 'A refund needs two people and a destination verified out of band. Funds are never attributed to a trade by amount or sender.',
  },
  DEPOSIT_POOL_LOW: {
    resolutions: [
      { value: 'record_recovery_outcome', label: 'Record that the pool was replenished' },
      { value: 'escalate', label: 'Escalate' },
    ],
    voidable: true,
    financial: 'The pool itself is replenished in the custody provider, not here.',
  },
  ROUTE_SETTLEMENT_MISMATCH: {
    resolutions: [
      { value: 'reallocate_reservations', label: 'Reallocate the settlement' },
      { value: 'escalate', label: 'Escalate' },
    ],
    voidable: false,
    financial: 'Correcting the amounts is a financial adjustment and needs a second approver.',
  },
  ROUTE_OBLIGATION_OVERDUE: {
    resolutions: [
      { value: 'record_route_settlement', label: 'Record the route settlement' },
      { value: 'escalate', label: 'Escalate' },
    ],
    voidable: false,
    financial: null,
  },
  DUPLICATE_TX_HASH: {
    resolutions: [
      { value: 'reallocate_reservations', label: 'Reallocate the transfer' },
      { value: 'escalate', label: 'Escalate' },
    ],
    voidable: true,
    financial: null,
  },
  DUPLICATE_UTR: {
    resolutions: [
      { value: 'correct_utr', label: 'Correct the reference' },
      { value: 'escalate', label: 'Escalate' },
    ],
    voidable: true,
    financial: null,
  },
  PARTIAL_INR_PAYOUT: {
    resolutions: [
      { value: 'create_remaining_leg', label: 'Create the remaining leg' },
      { value: 'escalate', label: 'Escalate' },
    ],
    voidable: false,
    financial: null,
  },
  INR_PAYOUT_DELAYED: {
    resolutions: [
      { value: 'escalate', label: 'Escalate' },
    ],
    voidable: true,
    financial: 'Confirming the payment, or marking it failed, is done on the leg itself in the settlement panel.',
  },
  BANK_TRANSFER_FAILED: {
    resolutions: [
      { value: 'create_replacement_leg', label: 'Create a replacement leg' },
      { value: 'escalate', label: 'Escalate' },
    ],
    voidable: false,
    financial: null,
  },
  CLIENT_BANK_CHANGED: {
    resolutions: [
      { value: 'confirm_new_destination', label: 'Confirm the new destination' },
      { value: 'keep_original', label: 'Keep the original destination' },
    ],
    voidable: false,
    financial: null,
  },
  ROUTE_CAPACITY_CHANGED: {
    resolutions: [
      { value: 'reallocate_reservations', label: 'Reallocate the reservations' },
      { value: 'escalate', label: 'Escalate' },
    ],
    voidable: true,
    financial: null,
  },
  TRADE_CANCELLATION: {
    resolutions: [
      { value: 'escalate', label: 'Escalate' },
    ],
    voidable: true,
    financial: 'Cancelling — with a refund if funds have been confirmed — is its own command on the trade.',
  },
  OPERATOR_MISTAKE: {
    resolutions: [
      { value: 'attach_evidence_and_void', label: 'Attach the evidence and close it' },
      { value: 'escalate', label: 'Escalate' },
    ],
    voidable: true,
    financial: 'Correcting the money is a financial adjustment and needs a second approver.',
  },
  RECONCILIATION_MISMATCH: {
    resolutions: [
      { value: 'attach_evidence_and_void', label: 'Attach the evidence and close it' },
      { value: 'escalate', label: 'Escalate' },
    ],
    voidable: true,
    financial: 'If the desk’s record is the one that is wrong, correcting it is a financial adjustment and needs a second approver.',
  },
};

/** The fallback exists so an unknown type is still closable; the test makes sure it is never the live path. */
export const FALLBACK: ResolutionChoices = { resolutions: [{ value: 'escalate', label: 'Escalate' }], voidable: true, financial: null };

export const resolutionsFor = (type: string): ResolutionChoices => RESOLUTIONS[type as ExceptionType] ?? FALLBACK;
