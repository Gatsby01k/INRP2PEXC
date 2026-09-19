import type { OutboxHandler } from '@inrp2p/outbox';

/**
 * Events the system emits on purpose and nothing consumes yet.
 *
 * The dispatcher refuses to mark an event dispatched when no handler claims it — "an event nobody handles is a
 * wiring bug" — which is the right default and is how this gap was found: the desk's own signals and the receipt
 * trigger had no handler at all, so every one of them retried ten times and failed for good.
 *
 * The honest fix is not a catch-all. It is this list: each type named, with what it is waiting for. Acknowledging
 * a type here says "we know, and here is why nothing happens"; an event that is not on the list still fails
 * loudly, which is the behaviour worth keeping. Nothing here reads or writes anything — the desk's queue is
 * derived from the rows themselves, so these events cost nothing when they are finally consumed.
 */
export const ACKNOWLEDGED_SIGNALS: Readonly<Record<string, string>> = Object.freeze({
  'desk.new_request': 'the desk queue is derived from the rows; a push channel for operators is not built',
  'desk.request_needs_action': 'same as desk.new_request',
  'desk.quote_rejected': 'same as desk.new_request',
  'desk.acceptance_failed': 'the failure is already an audit event the desk can see',
  'desk.exception_opened': 'exceptions appear in the desk queue the moment the row exists',
  'desk.leg_failed': 'same as desk.exception_opened',
  'desk.payout_actionable': 'same as desk.exception_opened',
  'desk.adjustment_requested': 'same as desk.exception_opened',
  'desk.route_settlement_failed': 'same as desk.exception_opened',
  'capacity.over_committed': 'the INR screen reads capacity from the rows; an operator alert is not built',
  'receipt.generate': 'client receipts are Phase 8 (finance outputs)',
});

export function acknowledgedSignalHandler(): OutboxHandler {
  return {
    name: 'acknowledged_signal',
    handles: (type) => type in ACKNOWLEDGED_SIGNALS,
    run: async () => {},
  };
}
