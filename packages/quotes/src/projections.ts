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
  readonly expiresAt: string | null;
  readonly status: 'SENT' | 'ACCEPTED' | 'EXPIRED' | 'REJECTED' | 'CANCELLED';
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
    .select(['ref', 'direction', 'base_minor', 'quote_inr_minor', 'client_rate_micro', 'network', 'bank_account_id', 'crypto_wallet_id', 'expires_at', 'status'])
    .where('id', '=', quoteId)
    .executeTakeFirst();
  if (!q || q.status === 'DRAFT') throw new DomainError('NOT_FOUND', 'quote not found');
  const view: ClientQuoteView = {
    ref: q.ref,
    direction: q.direction,
    base: Money.ofMinor(q.base_minor, 'USDT').toJSON(),
    inr: Money.ofMinor(q.quote_inr_minor, 'INR').toJSON(),
    clientRate: Rate.ofMicro(q.client_rate_micro, 'CLIENT').toDecimalString(),
    network: q.network,
    destination: await maskedDestination(ex, q),
    expiresAt: q.expires_at ? q.expires_at.toISOString() : null,
    status: q.status as Exclude<QuoteStatus, 'DRAFT'>,
  };
  return view;
}
