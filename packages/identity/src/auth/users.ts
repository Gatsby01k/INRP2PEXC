import type { Db } from '@inrp2p/db';
import type { ClientAuth, OperatorAuth } from './config.ts';
import type { OperatorRole } from '../rbac/matrix.ts';

/**
 * Provisioning primitives (no self sign-up exists). Phase 2 wraps these in audited commands;
 * Phase 1 uses them for bootstrap and tests.
 */
export async function provisionOperator(auth: OperatorAuth, appDb: Db, input: { email: string; name: string; password: string; roles: readonly OperatorRole[]; grantedBy?: string | null }): Promise<string> {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ email: input.email.toLowerCase(), name: input.name, emailVerified: true, kind: 'OPERATOR', status: 'ACTIVE' }, { method: 'admin' });
  const hash = await ctx.password.hash(input.password);
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', accountId: user.id, password: hash });
  if (input.roles.length) {
    await appDb.insertInto('operator_user_role').values(input.roles.map((role_code) => ({ user_id: user.id, role_code, granted_by: input.grantedBy ?? null }))).execute();
  }
  return user.id;
}

export async function provisionClientUser(auth: ClientAuth, input: { email: string; name: string }): Promise<string> {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ email: input.email.toLowerCase(), name: input.name, emailVerified: false, kind: 'CLIENT', status: 'ACTIVE' }, { method: 'admin' });
  return user.id;
}

/**
 * The sign-in identity behind "Become a trader" (docs/TRADERS.md §3).
 *
 * Client sign-up stays closed in Better Auth: the workspace sign-in never creates anyone. This is the one door that
 * may, and what it creates is only an identity — a CLIENT user with no client, no role and no permission. Signing
 * in with it reaches the trader application and nothing else; a client, and everything that comes with one, exists
 * only once an application is submitted, and the Exchange only once the desk opens it.
 *
 * An address that already has an identity keeps it: an existing client applying to be a trader signs in as
 * themselves, so nobody is ever duplicated. An operator's address, or a disabled one, is not a client identity and
 * is reported as `unavailable` — the caller says the same thing to the visitor either way.
 */
export async function ensureClientIdentity(auth: ClientAuth, appDb: Db, input: { email: string }): Promise<{ userId: string; created: boolean } | { unavailable: true }> {
  const email = input.email.trim().toLowerCase();
  const existing = await appDb.selectFrom('auth_user').select(['id', 'kind', 'status']).where('email', '=', email).executeTakeFirst();
  if (existing) {
    return existing.kind === 'CLIENT' && existing.status === 'ACTIVE' ? { userId: existing.id, created: false } : { unavailable: true };
  }
  const local = email.split('@')[0] ?? '';
  try {
    const userId = await provisionClientUser(auth, { email, name: local.slice(0, 80) || email });
    return { userId, created: true };
  } catch (e) {
    // Two starts for one address at once: the other one created it, and it is the same person's identity.
    const raced = await appDb.selectFrom('auth_user').select(['id', 'kind', 'status']).where('email', '=', email).executeTakeFirst();
    if (raced) return raced.kind === 'CLIENT' && raced.status === 'ACTIVE' ? { userId: raced.id, created: false } : { unavailable: true };
    throw e;
  }
}
