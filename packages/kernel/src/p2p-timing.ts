import { DomainError } from './errors.ts';
import type { InrRail } from './inr-payments.ts';

/**
 * How long each step of a P2P deal may take (ADR 0023), read from the trader programme — a person sets it; no number
 * here decides a running deal. The buyer's time to send the rupees depends on how it sends them: a UPI or IMPS payment
 * is done in a minute, a NEFT one goes in the next half-hourly batch. So does the payee's time to see them arrive.
 */
export interface P2pTiming {
  /** A client's BUY: the trader's time to put its USDT in escrow, from the trade's opening. */
  readonly escrowMinutes: number;
  /** After the buyer's time is up: the short final period in which it can still say it paid. */
  readonly finalMinutes: number;
  /** The buyer's time to send the rupees and say so, by rail, from the escrow being final. */
  readonly pay: Readonly<Record<InrRail, number>>;
  /** The payee's time to confirm rupees said to be sent, by rail; past it INRP2P checks — nothing is cancelled. */
  readonly receipt: Readonly<Record<InrRail, number>>;
}

export const P2P_RAIL_ORDER: readonly InrRail[] = Object.freeze(['UPI', 'IMPS', 'NEFT', 'RTGS']);

/** What migration 0042 sets — the starting point an operator changes, never a fallback for a missing setting. */
export const DEFAULT_P2P_TIMING: P2pTiming = Object.freeze({
  escrowMinutes: 30,
  finalMinutes: 5,
  pay: Object.freeze({ UPI: 15, IMPS: 30, NEFT: 60, RTGS: 45 }),
  receipt: Object.freeze({ UPI: 30, IMPS: 30, NEFT: 180, RTGS: 90 }),
});

/** The ranges `inrp2p_valid_p2p_timing` holds them to. */
export const P2P_TIMING_BOUNDS = Object.freeze({ escrowMinutes: [10, 120], finalMinutes: [2, 30], pay: [5, 240], receipt: [10, 1440] } as const);

const minutes = (value: unknown, field: string, [lo, hi]: readonly [number, number]): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < lo || value > hi) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be a whole number of minutes between ${lo} and ${hi}`, { field });
  }
  return value;
};

/** A timing a person typed, checked field by field — the same ranges the database holds it to. */
export function requireP2pTiming(value: unknown): P2pTiming {
  if (typeof value !== 'object' || value === null) throw new DomainError('INVALID_ARGUMENT', 'p2pTiming must be an object', { field: 'p2pTiming' });
  const v = value as Record<string, unknown>;
  const byRail = (key: 'pay' | 'receipt'): Record<InrRail, number> => {
    const r = (typeof v[key] === 'object' && v[key] !== null ? v[key] : {}) as Record<string, unknown>;
    return Object.freeze(Object.fromEntries(P2P_RAIL_ORDER.map((rail) => [rail, minutes(r[rail], `p2pTiming.${key}.${rail}`, P2P_TIMING_BOUNDS[key])]))) as Record<InrRail, number>;
  };
  return Object.freeze({
    escrowMinutes: minutes(v.escrowMinutes, 'p2pTiming.escrowMinutes', P2P_TIMING_BOUNDS.escrowMinutes),
    finalMinutes: minutes(v.finalMinutes, 'p2pTiming.finalMinutes', P2P_TIMING_BOUNDS.finalMinutes),
    pay: byRail('pay'),
    receipt: byRail('receipt'),
  });
}

