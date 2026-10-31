'use client';

import { type ConfirmFactor, type ConfirmPurpose, confirmFactorsOf } from '../../../components/ConfirmIdentity.tsx';

/**
 * Linking or disconnecting the person's Telegram (ADR 0026), through Better Auth's own endpoints. Either is a change of
 * how they sign in: the server may first ask for a confirmation (`STEP_UP_REQUIRED` with the factors that would do), and
 * the caller shows it, then asks again. Linking itself is Telegram's: the browser goes there and comes back to `returnTo`.
 */
export type TelegramStep =
  | { readonly kind: 'REDIRECT'; readonly url: string }
  | { readonly kind: 'DONE' }
  | { readonly kind: 'CONFIRM'; readonly factors: ConfirmFactor[]; readonly purpose: ConfirmPurpose }
  | { readonly kind: 'NEEDS_FACTOR' }
  | { readonly kind: 'FAILED'; readonly message: string };

async function post(path: string, body: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown> | null } | null> {
  try {
    const res = await fetch(`/api/auth${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { ok: res.ok, status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  } catch {
    return null;
  }
}

function refused(res: Awaited<ReturnType<typeof post>>, failed: string): TelegramStep {
  const factors = confirmFactorsOf(res?.json ?? undefined);
  if (res?.json?.code === 'STEP_UP_REQUIRED' && factors && factors.length > 0) return { kind: 'CONFIRM', factors, purpose: 'SECURITY' };
  if (res?.json?.code === 'MFA_ENROLLMENT_REQUIRED') return { kind: 'NEEDS_FACTOR' };
  if (res?.status === 429) return { kind: 'FAILED', message: 'Too many tries in a short time. Wait a few minutes.' };
  return { kind: 'FAILED', message: failed };
}

/** Where Telegram sends the person back: the same page, with `?telegram=linked` or `?telegram=failed&error=…`. */
export async function startTelegramLink(returnTo: string): Promise<TelegramStep> {
  const back = (state: string) => `${returnTo}${returnTo.includes('?') ? '&' : '?'}telegram=${state}`;
  const res = await post('/link-social', { provider: 'telegram', callbackURL: back('linked'), errorCallbackURL: back('failed'), disableRedirect: true });
  if (res?.ok && typeof res.json?.url === 'string') return { kind: 'REDIRECT', url: res.json.url };
  return refused(res, 'Telegram isn’t answering just now. Try again in a moment.');
}

export async function disconnectTelegram(accountId: string): Promise<TelegramStep> {
  const res = await post('/unlink-account', { accountId });
  if (res?.ok) return { kind: 'DONE' };
  return refused(res, 'Telegram could not be disconnected just now. Try again in a moment.');
}

/** What Telegram's answer on the way back means, in words. */
export function telegramLinkProblem(error: string | null): string {
  if (error === 'account_already_linked_to_different_user') return 'This Telegram is already connected to another INRP2P account. Disconnect it there first, or use another Telegram.';
  if (error === 'access_denied') return 'Connecting Telegram was cancelled.';
  return 'Telegram didn’t finish connecting. Try again.';
}
