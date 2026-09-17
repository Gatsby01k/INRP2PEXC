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
