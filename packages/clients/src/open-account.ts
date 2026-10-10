import { sql } from 'kysely';
import { DomainError, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import { isUniqueViolation } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { type ClientActor, type DomainCommand, actorLabel } from '@inrp2p/identity';

export interface OpenAccountPayload {
  /** The person's own name, or the company's. */
  readonly name: string;
  readonly entityType: 'INDIVIDUAL' | 'COMPANY';
}

export interface OpenAccountResult {
  readonly clientId: string;
  readonly ref: string;
}

/**
 * `client.open_account` — a person who verified their email with the workspace code and has no account yet (owner
 * decision D-17, 2026-10-10: clients open their own accounts, no operator admits them).
 *
 * It creates their client with the Exchange open, and makes them its administrator, able to accept quotes — the
 * same standing a desk-created client's first user has. Everything after that is unchanged: a destination needs the
 * administrator's authenticator (step-up), every request is priced by a person on the desk, and nothing settles
 * without the usual checks. What the client was not given is a review: `kyc_status` stays `NOT_STARTED`, as for every
 * client until the compliance workflow exists (D-07), and the desk sees who opened the account in its audit trail.
 *
 * One account per person: someone already linked to a client — or who applied as a trader and so has one — is refused,
 * and two submissions at once create one client.
 */
export function openExchangeAccount(actor: ClientActor): DomainCommand<OpenAccountPayload, OpenAccountResult> {
  return {
    authorize: async (ctx) => {
      if (ctx.actor.surface !== 'CLIENT') throw new DomainError('SESSION_SURFACE_MISMATCH');
      const user = await ctx.tx.selectFrom('auth_user').select(['kind', 'status']).where('id', '=', requireUuid(actor.userId, 'userId')).executeTakeFirst();
      if (!user || user.kind !== 'CLIENT' || user.status !== 'ACTIVE') throw new DomainError('FORBIDDEN', 'this account cannot open a client account');
    },
    handle: async (ctx, p) => {
      const name = requireText(p.name, 'name', 120);
      const type = requireOneOf(p.entityType, 'entityType', ['INDIVIDUAL', 'COMPANY'] as const);
      await sql`select pg_advisory_xact_lock(hashtext(${`client.open_account:${actor.userId}`}))`.execute(ctx.tx);
      const linked = await ctx.tx.selectFrom('client_user').select('client_id').where('user_id', '=', actor.userId).executeTakeFirst();
      if (linked) throw new DomainError('ACCOUNT_EXISTS', 'this email already has an account; sign in to it');

      const client = await ctx.tx
        .insertInto('client')
        .values({ legal_name: name, display_name: name, type, exchange_access: true, created_by: actorLabel(ctx) })
        .returning(['id', 'ref'])
        .executeTakeFirstOrThrow();
      let member;
      try {
        member = await ctx.tx
          .insertInto('client_user')
          .values({ client_id: client.id, user_id: actor.userId, role: 'CLIENT_ADMIN', can_accept_quotes: true, created_by: actorLabel(ctx) })
          .returning('id')
          .executeTakeFirstOrThrow();
      } catch (e) {
        if (isUniqueViolation(e)) throw new DomainError('ACCOUNT_EXISTS', 'this email already has an account; sign in to it');
        throw e;
      }
      await appendAudit(ctx, {
        action: 'client.self_registered', entityType: 'client', entityId: client.id,
        after: { ref: client.ref, type, exchange_access: true, via: 'client.open_account', client_user_id: member.id, role: 'CLIENT_ADMIN', can_accept_quotes: true },
      });
      return { clientId: client.id, ref: client.ref };
    },
  };
}
