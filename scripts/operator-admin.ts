import { hostname, userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { type Db, type Executor, type TxContext, createDb, createPool } from '@inrp2p/db';
import { executeCommand } from '@inrp2p/commands';
import { appendAudit } from '@inrp2p/audit';
import { DomainError, requireText } from '@inrp2p/kernel';
import { createOperatorAuth, provisionOperator } from '@inrp2p/identity';

/**
 * The protected operator procedures (production task C2, SECURITY §3, RUNBOOKS `operator-access`).
 *
 * Two things the application deliberately cannot do, so that no session — however privileged — can do them silently:
 *
 * - `bootstrap-owner`: create the first OWNER. Allowed only while no OWNER is active; the account must enrol TOTP at
 *   its first sign-in before it can do anything (the operator guard refuses an un-enrolled session).
 * - `disable-operator`: end an operator's access — every session revoked, the account disabled. Removing the last
 *   active OWNER needs `--allow-last-owner`, and is how a lost or compromised sole OWNER is recovered: disable it,
 *   then bootstrap a new one.
 *
 * Both run with the infrastructure database credential (`INRP2P_ADMIN_DATABASE_URL`, the role that runs migrations),
 * never the application's: the database refuses the application role an OWNER row it did not get through the
 * in-app rules (IX091). Both write an audit event naming the procedure, the machine and the OS user that ran it, and
 * the reason. Without `--yes` they only say what they would do. Secrets come from the environment (a secret manager),
 * never from the command line.
 */

export interface ProcedureContext {
  readonly host: string;
  readonly osUser: string;
}

function audited<R>(db: Db, name: string, payload: Record<string, unknown>, handle: (ctx: TxContext) => Promise<R>): Promise<R> {
  return executeCommand(db, { authorize: async () => {}, handle }, {
    name, actor: { type: 'SYSTEM', id: null, surface: 'SYSTEM' }, payload, idempotencyKey: randomUUID(), financial: false,
  }).then((o) => o.result);
}

async function activeOwnerCount(ex: Executor): Promise<number> {
  const r = await sql<{ n: string }>`
    select count(*)::text as n from operator_user_role r join auth_user u on u.id = r.user_id
     where r.role_code = 'OWNER' and u.status = 'ACTIVE'`.execute(ex);
  return Number.parseInt(r.rows[0]!.n, 10);
}

/** Creates the first OWNER. Refused while any OWNER is active. */
export async function bootstrapOwner(
  db: Db,
  auth: ReturnType<typeof createOperatorAuth>,
  input: { email: string; name: string; password: string; reason: string },
  who: ProcedureContext,
): Promise<{ userId: string }> {
  const reason = requireText(input.reason, 'reason', 500);
  if (reason.length < 10) throw new DomainError('INVALID_ARGUMENT', 'say why (at least 10 characters)');
  if (input.password.length < 16) throw new DomainError('INVALID_ARGUMENT', 'the initial password must be at least 16 characters');
  const refuse = () => new DomainError('INVALID_TRANSITION', 'an OWNER is already active: further OWNERs are granted in the desk, with a second OWNER’s approval');
  if ((await activeOwnerCount(db)) > 0) throw refuse();
  // The account first (Better Auth hashes the password), the role after, under the role lock with the count checked
  // again — two procedures racing cannot both make a "first" OWNER.
  const userId = await provisionOperator(auth, db, { email: input.email, name: input.name, password: input.password, roles: [] });
  try {
    await audited(db, 'identity.bootstrap_owner', { email: input.email.toLowerCase() }, async (ctx) => {
      await sql`select pg_advisory_xact_lock(hashtext('inrp2p.operator_roles'))`.execute(ctx.tx);
      if ((await activeOwnerCount(ctx.tx)) > 0) throw refuse();
      await ctx.tx.insertInto('operator_user_role').values({ user_id: userId, role_code: 'OWNER', granted_by: null }).execute();
      await appendAudit(ctx, {
        action: 'identity.owner_bootstrapped', entityType: 'auth_user', entityId: userId,
        after: { email: input.email.toLowerCase(), reason, procedure: 'scripts/operator-admin.ts bootstrap-owner', host: who.host, os_user: who.osUser },
      });
    });
  } catch (e) {
    // The account must not linger without its role as a sign-in that can do nothing: it is disabled, on the record.
    await db.updateTable('auth_user').set({ status: 'DISABLED', updated_at: sql`statement_timestamp()` }).where('id', '=', userId).execute();
    throw e;
  }
  return { userId };
}

/** Revokes every session of an operator and disables the account. The last active OWNER only with `allowLastOwner`. */
export async function disableOperator(
  db: Db,
  input: { email: string; reason: string; allowLastOwner?: boolean },
  who: ProcedureContext,
): Promise<{ userId: string; sessionsRevoked: number; wasOwner: boolean }> {
  const reason = requireText(input.reason, 'reason', 500);
  if (reason.length < 10) throw new DomainError('INVALID_ARGUMENT', 'say why (at least 10 characters)');
  return audited(db, 'identity.disable_operator', { email: input.email.toLowerCase() }, async (ctx) => {
    await sql`select pg_advisory_xact_lock(hashtext('inrp2p.operator_roles'))`.execute(ctx.tx);
    const user = await ctx.tx.selectFrom('auth_user').select(['id', 'kind', 'status']).where('email', '=', input.email.toLowerCase()).executeTakeFirst();
    if (!user || user.kind !== 'OPERATOR') throw new DomainError('NOT_FOUND', 'no operator account with that email');
    const owner = await ctx.tx.selectFrom('operator_user_role').select('user_id').where('user_id', '=', user.id).where('role_code', '=', 'OWNER').executeTakeFirst();
    if (owner && user.status === 'ACTIVE' && (await activeOwnerCount(ctx.tx)) <= 1 && !input.allowLastOwner) {
      throw new DomainError('INVALID_TRANSITION', 'this is the last active OWNER: pass --allow-last-owner to recover it, then bootstrap a new OWNER');
    }
    const revoked = await ctx.tx.deleteFrom('auth_session').where('user_id', '=', user.id).executeTakeFirst();
    await ctx.tx.updateTable('auth_user').set({ status: 'DISABLED', updated_at: sql`statement_timestamp()` }).where('id', '=', user.id).execute();
    const sessionsRevoked = Number(revoked.numDeletedRows);
    await appendAudit(ctx, {
      action: 'identity.operator_disabled', entityType: 'auth_user', entityId: user.id,
      before: { status: user.status }, after: { status: 'DISABLED', sessions_revoked: sessionsRevoked, was_owner: Boolean(owner), reason, procedure: 'scripts/operator-admin.ts disable-operator', host: who.host, os_user: who.osUser },
    });
    return { userId: user.id, sessionsRevoked, wasOwner: Boolean(owner) };
  });
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function need(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const yes = process.argv.includes('--yes');
  const who: ProcedureContext = { host: hostname(), osUser: userInfo().username };
  const url = need('INRP2P_ADMIN_DATABASE_URL', process.env.INRP2P_ADMIN_DATABASE_URL);
  const email = need('--email', arg('email'));
  const reason = need('--reason', arg('reason'));
  if (command !== 'bootstrap-owner' && command !== 'disable-operator') {
    throw new Error('usage: operator-admin.ts bootstrap-owner|disable-operator --email <e> --reason <text> [--name <n>] [--allow-last-owner] [--yes]');
  }
  if (!yes) {
    console.log(`dry run: would ${command === 'bootstrap-owner' ? 'create the first OWNER' : 'revoke every session of and disable'} ${email}. Re-run with --yes.`);
    return;
  }
  const db = createDb(createPool({ connectionString: url, applicationName: 'inrp2p-operator-admin' }));
  try {
    if (command === 'bootstrap-owner') {
      const authDb = createDb(createPool({ connectionString: url, applicationName: 'inrp2p-operator-admin-auth', int8: 'number' }));
      try {
        const auth = createOperatorAuth({
          authDb, appDb: db, secret: need('OPERATOR_AUTH_SECRET', process.env.OPERATOR_AUTH_SECRET),
          baseURL: need('OPERATOR_BASE_URL', process.env.OPERATOR_BASE_URL), useSecureCookies: true,
        });
        const out = await bootstrapOwner(db, auth, { email, name: arg('name') ?? email.split('@')[0]!, password: need('INRP2P_BOOTSTRAP_PASSWORD', process.env.INRP2P_BOOTSTRAP_PASSWORD), reason }, who);
        console.log(`OWNER created (${out.userId}). They enrol TOTP at first sign-in; nothing works before that.`);
      } finally {
        await authDb.destroy();
      }
    } else {
      const out = await disableOperator(db, { email, reason, allowLastOwner: process.argv.includes('--allow-last-owner') }, who);
      console.log(`disabled ${out.userId}: ${out.sessionsRevoked} session(s) revoked${out.wasOwner ? '; it held OWNER' : ''}.`);
    }
  } finally {
    await db.destroy();
  }
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
