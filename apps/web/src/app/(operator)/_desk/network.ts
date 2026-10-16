/** The desk's words for the exchange's own rails (ADR 0017), shared by the network page and a trade's workspace. */

/** TRX for reading, grouped and to the hundredth (truncated — a display, never a computation). */
export const trx = (v: string) => {
  const negative = v.startsWith('-');
  const [whole = '0', frac = ''] = (negative ? v.slice(1) : v).split('.');
  const cents = frac.slice(0, 2).padEnd(2, '0');
  return `${negative ? '−' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${cents === '00' ? '' : `.${cents}`} TRX`;
};
export const isPositiveDecimal = (v: string) => /^\d+(\.\d{1,6})?$/.test(v) && /[1-9]/.test(v);

export const PURPOSE: Record<string, string> = {
  CLIENT_PAYOUT: 'Client payout',
  REFUND: 'Refund',
  ROUTE_PAYMENT: 'To counterparty',
  TOPUP: 'TRX top-up',
  DEPOSIT_WITHDRAWAL: 'Deposit withdrawal',
};

export const STATUS: Record<string, { label: string; tone: 'success' | 'brand' | 'danger' | 'warning' | 'neutral' }> = {
  AWAITING_APPROVAL: { label: 'Needs approval', tone: 'warning' },
  PLANNED: { label: 'Queued', tone: 'neutral' },
  AWAITING_RESOURCES: { label: 'Topping up TRX', tone: 'brand' },
  BLOCKED: { label: 'Blocked', tone: 'danger' },
  SENDING: { label: 'On chain', tone: 'brand' },
  CONFIRMED: { label: 'Final', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

export const ATTEMPT: Record<string, 'success' | 'brand' | 'danger' | 'warning' | 'neutral'> = { SIGNED: 'warning', BROADCAST: 'brand', CONFIRMED: 'success', FAILED: 'danger', EXPIRED: 'neutral' };
