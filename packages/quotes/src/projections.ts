import { DomainError, Money, Rate } from '@inrp2p/kernel';
import type { Executor, QuoteStatus } from '@inrp2p/db';

/**
 * The ONLY quote shape client APIs and the link page may serialize (DOMAIN_MODEL §2.5, SECURITY S5): ref, direction,
 * base, INR amount, client rate, network, masked destination, expiry and status. Route, route rate, snapshot, margin,
 * dealer, provider and internal ids do not exist on this type.
 */
export interface ClientQuoteView {
  readonly ref: string;
  readonly direction: 'SELL_USDT' | 'BUY_USDT';
  readonly base: { readonly amount: string; readonly currency: 'USDT' };
  readonly inr: { readonly amount: string; readonly currency: 'INR' };
  readonly clientRate: string;
  readonly network: 'TRON';
  readonly destination: string;
  /** When the desk sent it: with `expiresAt`, how long it is held in all — what a countdown is drawn against. */
  readonly sentAt: string | null;
  readonly expiresAt: string | null;
  readonly status: 'SENT' | 'ACCEPTED' | 'EXPIRED' | 'REJECTED' | 'CANCELLED';
  /**
   * The TRC20 network fee the rate already includes (ADR 0017) — said so the client knows nothing is deducted on top:
   * what it receives is exactly the quoted amount. Null for a quote priced before network fees existed.
   */
  readonly networkFeeIncluded: { readonly amount: string; readonly currency: 'INR' } | null;
  /**
   * ADR 0028: the network the client pays as its own line — the TRON cost of the deal's escrow and its transfers. A client
   * buying pays for its USDT and this together and receives its USDT in full; a client selling sends its USDT and is paid
   * for it less this. Null when the rate includes the network, as before.
   */
  readonly networkFee: { readonly amount: string; readonly currency: 'USDT' } | null;
}

/** Keys that must never appear anywhere in client-facing JSON (checked by tests on every client response). */
export const FORBIDDEN_CLIENT_KEY = /route|margin|snapshot|provider|custody|dealer|obligation|execution|reference_rate|referenceRate|operator|created_by|sent_by|hmac|enc$|sealed|code_hash|salt/i;

export function assertClientSafe(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertClientSafe(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_CLIENT_KEY.test(k)) throw new Error(`client projection leaks key ${path}.${k}`);
    assertClientSafe(v, `${path}.${k}`);
  }
}

export async function maskedDestination(ex: Executor, q: { bank_account_id: string | null; crypto_wallet_id: string | null }): Promise<string> {
  if (q.bank_account_id) {
    const b = await ex.selectFrom('bank_account').select(['bank_name', 'account_last4']).where('id', '=', q.bank_account_id).executeTakeFirstOrThrow();
    return `${b.bank_name} •••• ${b.account_last4}`;
  }
  if (q.crypto_wallet_id) {
    const w = await ex.selectFrom('crypto_wallet').select(['address']).where('id', '=', q.crypto_wallet_id).executeTakeFirstOrThrow();
    return `TRC20 · ${w.address.slice(0, 3)}…${w.address.slice(-4)}`;
  }
  throw new DomainError('DESTINATION_INVALID', 'quote has no destination');
}

export async function toClientQuoteView(ex: Executor, quoteId: string): Promise<ClientQuoteView> {
  const q = await ex
    .selectFrom('quote')
    .select(['ref', 'direction', 'base_minor', 'quote_inr_minor', 'client_rate_micro', 'network', 'bank_account_id', 'crypto_wallet_id', 'sent_at', 'expires_at', 'status', 'client_network_base_minor'])
    .where('id', '=', quoteId)
    .executeTakeFirst();
  if (!q || q.status === 'DRAFT') throw new DomainError('NOT_FOUND', 'quote not found');
  // The destination's mask and the network fee need only the quote, not each other.
  const [destination, fee] = await Promise.all([
    maskedDestination(ex, q),
    ex.selectFrom('quote_network_fee').select('fee_inr_minor').where('quote_id', '=', quoteId).executeTakeFirst(),
  ]);
  const view: ClientQuoteView = {
    ref: q.ref,
    direction: q.direction,
    base: Money.ofMinor(q.base_minor, 'USDT').toJSON(),
    inr: Money.ofMinor(q.quote_inr_minor, 'INR').toJSON(),
    clientRate: Rate.ofMicro(q.client_rate_micro, 'CLIENT').toDecimalString(),
    network: q.network,
    destination,
    sentAt: q.sent_at ? q.sent_at.toISOString() : null,
    expiresAt: q.expires_at ? q.expires_at.toISOString() : null,
    status: q.status as Exclude<QuoteStatus, 'DRAFT'>,
    networkFeeIncluded: fee && q.client_network_base_minor === null ? Money.ofMinor(fee.fee_inr_minor, 'INR').toJSON() : null,
    networkFee: q.client_network_base_minor === null ? null : Money.ofMinor(q.client_network_base_minor, 'USDT').toJSON(),
  };
  return view;
}
