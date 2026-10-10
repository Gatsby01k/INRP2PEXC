'use server';

import { randomUUID } from 'node:crypto';
import { appendAuditDirect } from '@inrp2p/audit';
import { hitRateLimit } from '@inrp2p/commands';
import { ensureClientIdentity } from '@inrp2p/identity';
import { isDomainError } from '@inrp2p/kernel';
import { callerIpHash } from '../link.ts';
import { getRuntime } from '../runtime.ts';

const ADDRESS = /^[^\s@<>"'()]+@[^\s@<>"'()]+\.[^\s@<>"'()]+$/;

export type TraderAccessResult = { readonly ok: true } | { readonly ok: false; readonly code: 'INVALID_EMAIL' | 'RATE_LIMITED' | 'UNAVAILABLE' };

/**
 * Step one of either way in — the workspace sign-in or "Become a trader": make sure the address has a client sign-in
 * identity, so the ordinary email code can sign it in. The code itself is Better Auth's own, sent by the page.
 *
 * What this may create is an identity and nothing more — no client, no role, no permission (identity
 * `ensureClientIdentity`). An address that already has one keeps it. Since D-17 (2026-10-10) a client opens their own
 * account: the identity signs in, and the account is opened on `/open-account` (`client.open_account`), or a trader
 * applies. The answer is the same whether the address was new, known, or not a client's at all: the page never tells
 * a stranger which addresses exist. Counted per caller and per address (SECURITY §7), whatever the outcome.
 */
async function startAccess(input: { email: string }, via: 'become_a_trader' | 'workspace_sign_in', buckets: { ip: string; email: string }): Promise<TraderAccessResult> {
  const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (email.length > 254 || !ADDRESS.test(email)) return { ok: false, code: 'INVALID_EMAIL' };
  const rt = getRuntime();
  try {
    await hitRateLimit(rt.appDb, { bucket: buckets.ip, subject: await callerIpHash(), limit: 10, windowSeconds: 600 });
    await hitRateLimit(rt.appDb, { bucket: buckets.email, subject: email, limit: 5, windowSeconds: 600 });
    const out = await ensureClientIdentity(rt.clientAuth, rt.appDb, { email });
    if ('userId' in out && out.created) {
      await appendAuditDirect(rt.appDb, {
        actorType: 'SYSTEM', actorId: null, surface: 'CLIENT', correlationId: randomUUID(),
        action: 'client_user.identity_created', entityType: 'auth_user', entityId: out.userId, after: { via },
      });
    }
    return { ok: true };
  } catch (e) {
    if (isDomainError(e, 'RATE_LIMITED')) return { ok: false, code: 'RATE_LIMITED' };
    const err = e instanceof Error ? e : new Error(String(e));
    console.error(JSON.stringify({ level: 'error', event: `${via}.unexpected_error`, name: err.name, message: err.message, stack: err.stack }));
    return { ok: false, code: 'UNAVAILABLE' };
  }
}

/** "Become a trader": the identity behind the trader application (docs/TRADERS.md §3). */
export async function startTraderAccessAction(input: { email: string }): Promise<TraderAccessResult> {
  return startAccess(input, 'become_a_trader', { ip: 'trader_access_ip', email: 'trader_access_email' });
}

/** The workspace sign-in: an existing client signs in, and a new one gets the identity to open an account with (D-17). */
export async function startClientAccessAction(input: { email: string }): Promise<TraderAccessResult> {
  return startAccess(input, 'workspace_sign_in', { ip: 'client_access_ip', email: 'client_access_email' });
}
