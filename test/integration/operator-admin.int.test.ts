import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { createOperatorAuth } from '@inrp2p/identity';
import { bootstrapOwner, disableOperator } from '../../scripts/operator-admin.ts';

/**
 * The protected operator procedures (production task C2): the first OWNER and the recovery of a lost sole OWNER exist
 * only here, run with the infrastructure credential, on the record — the application can do neither (IX091).
 */
let t: TestDatabase;
let auth: ReturnType<typeof createOperatorAuth>;
const who = { host: 'ops-laptop', osUser: 'infra' };
const password = 'a long initial password from the vault';

beforeAll(async () => {
  t = await createTestDatabase('operator_admin');
  auth = createOperatorAuth({ authDb: t.auth, appDb: t.app, secret: 'x'.repeat(32), baseURL: 'https://desk.inrp2p.test', rateLimit: { enabled: false } });
});
afterAll(async () => t.close());

const ownerRows = () => t.owner.selectFrom('operator_user_role as r').innerJoin('auth_user as u', 'u.id', 'r.user_id').select(['u.email', 'u.status']).where('r.role_code', '=', 'OWNER').orderBy('u.email').execute();

describe('bootstrap and recovery of the OWNER', () => {
  it('creates the first OWNER only while none is active, on the record, and refuses a second', async () => {
    const first = await bootstrapOwner(t.owner, auth, { email: 'Founder@inrp2p.test', name: 'Founder', password, reason: 'first OWNER of the production desk' }, who);
    expect(await ownerRows()).toEqual([{ email: 'founder@inrp2p.test', status: 'ACTIVE' }]);
    const audit = await t.owner.selectFrom('audit_event').select(['action', 'after']).where('entity_id', '=', first.userId).executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ action: 'identity.owner_bootstrapped', after: { host: 'ops-laptop', os_user: 'infra', reason: 'first OWNER of the production desk' } });

    await expect(bootstrapOwner(t.owner, auth, { email: 'another@inrp2p.test', name: 'Another', password, reason: 'a second first owner' }, who))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(await t.owner.selectFrom('auth_user').select('id').where('email', '=', 'another@inrp2p.test').execute()).toEqual([]);
    await expect(bootstrapOwner(t.owner, auth, { email: 'weak@inrp2p.test', name: 'Weak', password: 'short', reason: 'too short a password' }, who))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('recovers a lost sole OWNER only on purpose: disable it with --allow-last-owner, then bootstrap a new one', async () => {
    const sessions = await t.owner.selectFrom('auth_user').select('id').where('email', '=', 'founder@inrp2p.test').executeTakeFirstOrThrow();
    await t.owner.insertInto('auth_session').values({ expires_at: new Date(Date.now() + 3_600_000), token: randomUUID(), created_at: new Date(), updated_at: new Date(), user_id: sessions.id, surface: 'OPERATOR' }).execute();

    await expect(disableOperator(t.owner, { email: 'founder@inrp2p.test', reason: 'authenticator lost with the phone' }, who)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    const out = await disableOperator(t.owner, { email: 'founder@inrp2p.test', reason: 'authenticator lost with the phone', allowLastOwner: true }, who);
    expect(out).toMatchObject({ sessionsRevoked: 1, wasOwner: true });
    expect(await ownerRows()).toEqual([{ email: 'founder@inrp2p.test', status: 'DISABLED' }]);
    expect(await t.owner.selectFrom('auth_session').select('id').where('user_id', '=', out.userId).execute()).toEqual([]);

    await bootstrapOwner(t.owner, auth, { email: 'cofounder@inrp2p.test', name: 'Co-founder', password, reason: 'recovery after the founder lost access' }, who);
    expect(await ownerRows()).toEqual([{ email: 'cofounder@inrp2p.test', status: 'ACTIVE' }, { email: 'founder@inrp2p.test', status: 'DISABLED' }]);
    const actions = await t.owner.selectFrom('audit_event').select('action').where('action', 'in', ['identity.owner_bootstrapped', 'identity.operator_disabled']).orderBy('seq').execute();
    expect(actions.map((a) => a.action)).toEqual(['identity.owner_bootstrapped', 'identity.operator_disabled', 'identity.owner_bootstrapped']);
  });

  it('the application connection can do neither', async () => {
    const code = (e: unknown) => (e as { code?: string }).code;
    const cofounder = await t.owner.selectFrom('auth_user').select('id').where('email', '=', 'cofounder@inrp2p.test').executeTakeFirstOrThrow();
    await expect(t.app.deleteFrom('operator_user_role').where('user_id', '=', cofounder.id).execute()).rejects.toSatisfy((e) => code(e) === 'IX091');
  });
});
