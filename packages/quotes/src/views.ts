import { sql } from 'kysely';
import { DomainError, requireUuid } from '@inrp2p/kernel';
import type { Db, Executor } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { executeCommand } from '@inrp2p/commands';
import type { ClientActor } from '@inrp2p/identity';
import { listAuthorizedAcceptors } from '@inrp2p/clients';
import { clientMembership } from './actors.ts';
import { resolveLink } from './challenges.ts';
import { type QuoteDeps, policyOf } from './policy.ts';
import { type ClientQuoteView, assertClientSafe, toClientQuoteView } from './projections.ts';
import { businessNow, hitRateLimit } from './security.ts';

/** A recipient the link holder may ask for a code; only the masked destination leaves the server. */
export interface LinkRecipient {
  readonly clientUserId: string;
  readonly destination: string;
}

export interface QuoteLinkView {
  readonly quote: ClientQuoteView;
  readonly recipients: readonly LinkRecipient[];
  /** Database time the view was rendered at, so the page counts down against the server, not the browser. */
  readonly serverTime: string;
  /** The page can never accept or reject without a code (D-01); stated here so the UI cannot assume otherwise. */
  readonly codeRequired: true;
}

/** Authorized recipients of an acceptance code (the client module owns the rule and the masking). */
export async function linkRecipients(ex: Executor, clientId: string): Promise<LinkRecipient[]> {
  const rows = await listAuthorizedAcceptors(ex, clientId);
  return rows.map((r) => ({ clientUserId: r.clientUserId, destination: r.maskedEmail }));
}

/**
 * `quote_link.view` (SECURITY §2.3, S2). Unauthenticated, view-only: it reads the quote, never changes it. The only
 * write is link telemetry (`open_count`, first open) plus the audit event. Lookup is by token hash with constant-time
 * confirmation and is rate limited per IP, so the page cannot be used to probe for live links.
 */
export async function viewQuoteLink(db: Db, deps: Pick<QuoteDeps, 'policy'>, input: { token: string; ipHash: string }): Promise<QuoteLinkView> {
  const policy = policyOf(deps);
  if (!/^[0-9a-f]{64}$/.test(input.ipHash)) throw new DomainError('INVALID_ARGUMENT', 'ipHash must be sha256 hex');
  await hitRateLimit(db, { bucket: 'link_open_ip', subject: input.ipHash, limit: policy.linkOpensPerIpPerMinute, windowSeconds: 60 });
  const link = await resolveLink(db, input.token);

  const out = await executeCommand(db, {
    authorize: async () => {},
    handle: async (ctx) => {
      const quote = await ctx.tx.selectFrom('quote').select(['id', 'client_id', 'status', 'expires_at']).where('id', '=', link.quoteId).executeTakeFirstOrThrow();
      const now = await businessNow(ctx.tx);
      const view = await toClientQuoteView(ctx.tx, quote.id);
      // A quote whose validity has run out reads as EXPIRED here; the state change itself belongs to the expiry job.
      const expired = quote.status === 'SENT' && (!quote.expires_at || now >= quote.expires_at);
      const recipients = quote.status === 'SENT' && !expired ? await linkRecipients(ctx.tx, quote.client_id) : [];
      await ctx.tx
        .updateTable('quote_link')
        .set({ open_count: sql<number>`open_count + 1`, first_opened_at: sql<Date | null>`coalesce(first_opened_at, inrp2p_now())` })
        .where('id', '=', link.linkId)
        .execute();
      await appendAudit(ctx, { action: 'quote_link.opened', entityType: 'quote_link', entityId: link.linkId, after: { quote_id: quote.id, quote_status: expired ? 'EXPIRED' : quote.status } });
      const result: QuoteLinkView = {
        quote: expired ? { ...view, status: 'EXPIRED' } : view,
        recipients,
        serverTime: now.toISOString(),
        codeRequired: true,
      };
      assertClientSafe(result);
      return result;
    },
  }, { name: 'quote_link.view', actor: { type: 'CLIENT_LINK', id: link.linkId, surface: 'PUBLIC' }, payload: { link: link.tokenHash }, financial: false });
  return out.result;
}

/** In-app quote view for an authenticated client user: same projection, membership instead of a token. */
export async function viewQuoteForClient(ex: Executor, actor: ClientActor, quoteId: string): Promise<ClientQuoteView> {
  const id = requireUuid(quoteId, 'quoteId');
  const q = await ex.selectFrom('quote').select(['client_id', 'status', 'expires_at']).where('id', '=', id).executeTakeFirst();
  if (!q || q.status === 'DRAFT') throw new DomainError('NOT_FOUND', 'quote not found');
  const member = await clientMembership(ex, actor.userId, q.client_id);
  if (!member) throw new DomainError('FORBIDDEN', 'not a user of this client');
  const now = await businessNow(ex);
  const view = await toClientQuoteView(ex, id);
  const result = q.status === 'SENT' && (!q.expires_at || now >= q.expires_at) ? { ...view, status: 'EXPIRED' as const } : view;
  assertClientSafe(result);
  return result;
}
