import type { DeskTraderRow } from '@inrp2p/traders';
import { Chip } from '../_desk/ui.tsx';

/**
 * The desk's words for a trader, shared by the list and the trader's page (server and client alike — no hooks here).
 */

export const ISSUE: Record<string, string> = {
  NOT_APPROVED: 'not approved',
  PAUSED: 'paused',
  RESERVE_NOT_SET: 'reserve not set',
  RESERVE_SHORT: 'reserve short',
  DESTINATIONS_INACTIVE: 'settlement details inactive',
  ASSIGNMENTS_DISABLED: 'assignments off',
  OFFLINE: 'offline',
};

/** ADR 0024: why the programme's rules left an application or a change for a person, in the desk's words. */
export const AUTO_FLAG: Record<string, string> = {
  BANK_NAME_MISMATCH: 'bank holder is not the applicant',
  BANK_ON_FILE_ELSEWHERE: 'bank account on another client’s file',
  BANK_REJECTED_BEFORE: 'bank account rejected before',
  WALLET_NOT_PROVEN: 'no USDT from the wallet yet',
  WALLET_ON_FILE_ELSEWHERE: 'wallet on another client’s file',
  WALLET_REJECTED_BEFORE: 'wallet rejected before',
  RESERVE_SHORT: 'reserve not funded yet',
  NO_DEFAULT_RESERVE: 'programme reserve not set',
  REJECTED_BEFORE: 'rejected before: a person decides',
  ORDERS_OPEN: 'waits for open orders',
};

/** Flags a person must act on; the rest are the trader's own move. */
export const DESK_FLAGS = new Set(['BANK_NAME_MISMATCH', 'BANK_ON_FILE_ELSEWHERE', 'BANK_REJECTED_BEFORE', 'WALLET_ON_FILE_ELSEWHERE', 'WALLET_REJECTED_BEFORE', 'REJECTED_BEFORE', 'NO_DEFAULT_RESERVE']);

export const TIER_WORD: Record<string, string> = { NEW: 'New', PROVEN: 'Proven', TRUSTED: 'Trusted' };

export function StatusChip({ t }: { t: Pick<DeskTraderRow, 'status' | 'available'> }) {
  if (t.status === 'APPROVED') return t.available ? <Chip tone="success" glyph="done">Online</Chip> : <Chip glyph="pending">Offline</Chip>;
  if (t.status === 'UNDER_REVIEW') return <Chip tone="brand" glyph="partial">Under review</Chip>;
  if (t.status === 'PAUSED') return <Chip tone="warning" icon="pause">Paused</Chip>;
  if (t.status === 'REJECTED') return <Chip tone="danger" glyph="closed">Rejected</Chip>;
  return <Chip tone="muted">{String(t.status).toLowerCase().replace('_', ' ')}</Chip>;
}

/** What a trader provides the desk, as the currency it brings: a Buy USDT side is its INR, a Sell USDT side its USDT. */
export const provides = (sides: readonly string[]): string => sides.map((s) => (s === 'BUY_USDT' ? 'INR' : 'USDT')).join(' · ') || '—';

/** ADR 0028: a market rate's margin in basis points, as the trader set it: +0.30%, −0.25%. */
export const offset = (bps: number) => `${bps >= 0 ? '+' : '−'}${Math.trunc(Math.abs(bps) / 100)}.${String(Math.abs(bps) % 100).padStart(2, '0')}%`;

export interface TraderPerms {
  readonly configure: boolean;
  readonly pause: boolean;
  readonly assign: boolean;
  readonly record: boolean;
  readonly confirm: boolean;
  readonly routeRecord: boolean;
  readonly routeConfirm: boolean;
  readonly reveal: boolean;
  /** TD-21: ask to apply the trader's reserve to an order's undelivered USDT, and approve it (someone else). */
  readonly applyReserve: boolean;
  readonly approveReserve: boolean;
  readonly meId: string;
}
