import { sql } from 'kysely';
import { DomainError, requireUuid } from '@inrp2p/kernel';
import type { Db, Executor, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { executeCommand } from '@inrp2p/commands';
import { requireQuoteDecider } from './actors.ts';
import { type QuoteDeps, policyOf } from './policy.ts';
import { businessNow, hashesEqual, hitRateLimit, linkTokenHash, maskEmailAddress, newOtpCode, newOtpSalt } from './security.ts';

export const otpSealContext = (challengeId: string) => `acceptance_challenge.code:${challengeId}`;
const codeHash = (deps: Pick<QuoteDeps, 'protector'>, code: string, salt: string) => deps.protector.lookupHash(code, `acceptance_challenge:${salt}`);

/** Erases undelivered codes of closed challenges so a code never outlives its challenge. */
async function eraseDeliveries(ctx: TxContext, challengeIds: readonly string[]): Promise<void> {
  if (challengeIds.length === 0) return;
  await ctx.tx.updateTable('otp_delivery').set({ code_sealed: null, erased_reason: 'CHALLENGE_CLOSED' }).where('challenge_id', 'in', challengeIds).where('code_sealed', 'is not', null).execute();
}

/** Closes every PENDING challenge of a quote (quote decided, cancelled, expired or link revoked). */
export async function closePendingChallenges(ctx: TxContext, quoteId: string, status: 'SUPERSEDED' | 'EXPIRED', opts: { linkId?: string } = {}): Promise<number> {
  let q = ctx.tx.selectFrom('acceptance_challenge').select('id').where('quote_id', '=', quoteId).where('status', '=', 'PENDING');
  if (opts.linkId) q = q.where('quote_link_id', '=', opts.linkId);
  const ids = (await q.orderBy('id').forUpdate().execute()).map((r) => r.id);
  if (ids.length === 0) return 0;
  await ctx.tx.updateTable('acceptance_challenge').set({ status, closed_at: sql<Date>`inrp2p_now()` }).where('id', 'in', ids).execute();
  await eraseDeliveries(ctx, ids);
  for (const id of ids) await appendAudit(ctx, { action: status === 'SUPERSEDED' ? 'acceptance_otp.superseded' : 'acceptance_otp.expired', entityType: 'acceptance_challenge', entityId: id, after: { status } });
  return ids.length;
}

export interface ResolvedLink {
  readonly linkId: string;
  readonly quoteId: string;
  readonly tokenHash: string;
}

/** Link lookup by token hash with constant-time confirmation. Revoked or unknown links are indistinguishable. */
export async function resolveLink(ex: Executor, token: unknown): Promise<ResolvedLink> {
  const tokenHash = linkTokenHash(token);
  const row = await ex.selectFrom('quote_link').select(['id', 'quote_id', 'token_hash', 'revoked_at']).where('token_hash', '=', tokenHash).executeTakeFirst();
  const ok = Boolean(row) && hashesEqual(row?.token_hash ?? '0'.repeat(64), tokenHash) && typeof token === 'string' && /^[0-9A-Za-z]{22}$/.test(token) && !row?.revoked_at;
  if (!ok || !row) throw new DomainError('LINK_NOT_FOUND', 'this link is not valid');
  return { linkId: row.id, quoteId: row.quote_id, tokenHash };
}

export interface RequestOtpInput {
  readonly token: string;
  readonly clientUserId: string;
  /** SHA-256 hex of the caller IP (computed at the HTTP edge). */
  readonly ipHash: string;
}

export interface RequestOtpResult {
  readonly challengeId: string;
  readonly destination: string;
  readonly expiresAt: string;
}

/**
 * `quote_link.request_otp` (STATE_MACHINES §12 create → PENDING). Unauthenticated link holder picks a masked authorized
 * recipient; the code goes only to that user's verified email. Limits: per IP per hour, per quote per window (D-01).
 * A new code supersedes the previous PENDING challenge of the same recipient.
 */
export async function requestLinkOtp(db: Db, deps: QuoteDeps, input: RequestOtpInput): Promise<RequestOtpResult> {
  const policy = policyOf(deps);
  if (!/^[0-9a-f]{64}$/.test(input.ipHash)) throw new DomainError('INVALID_ARGUMENT', 'ipHash must be sha256 hex');
  await hitRateLimit(db, { bucket: 'otp_send_ip', subject: input.ipHash, limit: policy.otpSendsPerIpPerHour, windowSeconds: 3600 });
  const link = await resolveLink(db, input.token);
  const clientUserId = requireUuid(input.clientUserId, 'clientUserId');
  const out = await executeCommand(db, {
    authorize: async () => {},
    handle: async (ctx) => {
      const { lockRow } = await import('./actors.ts');
      const q0 = await ctx.tx.selectFrom('quote').select(['trade_request_id']).where('id', '=', link.quoteId).executeTakeFirstOrThrow();
      await lockRow(ctx.tx, 'trade_request', 'trade_request', q0.trade_request_id);
      await lockRow(ctx.tx, 'quote', 'quote', link.quoteId);
      const quote = await ctx.tx.selectFrom('quote').select(['id', 'ref', 'status', 'client_id', 'expires_at']).where('id', '=', link.quoteId).executeTakeFirstOrThrow();
      const now = await businessNow(ctx.tx);
      if (quote.status !== 'SENT') throw new DomainError('QUOTE_NOT_SENT', `quote is ${quote.status}`);
      if (!quote.expires_at || now >= quote.expires_at) throw new DomainError('QUOTE_EXPIRED', 'quote has expired');

      const cu = await ctx.tx.selectFrom('client_user').select(['user_id', 'client_id']).where('id', '=', clientUserId).executeTakeFirst();
      if (!cu || cu.client_id !== quote.client_id) throw new DomainError('OTP_RECIPIENT_INVALID', 'recipient is not available');
      const member = await requireQuoteDecider(ctx.tx, cu.user_id, quote.client_id, { requireVerifiedEmail: true }).catch(() => {
        throw new DomainError('OTP_RECIPIENT_INVALID', 'recipient is not available');
      });

      const recent = await sql<{ n: string }>`
        select count(*)::text as n from acceptance_challenge
        where quote_id = ${quote.id} and sent_at > inrp2p_now() - make_interval(secs => ${policy.otpSendWindowSeconds})`.execute(ctx.tx);
      if (parseInt(recent.rows[0]!.n, 10) >= policy.otpMaxSendsPerQuoteWindow) throw new DomainError('OTP_SEND_LIMIT', 'too many codes requested for this quote');

      const previous = await ctx.tx.selectFrom('acceptance_challenge').select('id').where('quote_id', '=', quote.id).where('client_user_id', '=', clientUserId).where('status', '=', 'PENDING').forUpdate().execute();
      if (previous.length) {
        await ctx.tx.updateTable('acceptance_challenge').set({ status: 'SUPERSEDED', closed_at: sql<Date>`inrp2p_now()` }).where('id', 'in', previous.map((p) => p.id)).execute();
        await eraseDeliveries(ctx, previous.map((p) => p.id));
        for (const p of previous) await appendAudit(ctx, { action: 'acceptance_otp.superseded', entityType: 'acceptance_challenge', entityId: p.id, after: { status: 'SUPERSEDED' } });
      }

      const otpExpiry = new Date(Math.min(now.getTime() + policy.otpTtlSeconds * 1000, quote.expires_at.getTime()));
      const code = newOtpCode();
      const salt = newOtpSalt();
      const destination = maskEmailAddress(member.email);
      const challenge = await ctx.tx
        .insertInto('acceptance_challenge')
        .values({ quote_id: quote.id, quote_link_id: link.linkId, client_user_id: clientUserId, destination_masked: destination, code_hash: codeHash(deps, code, salt), code_salt: salt, expires_at: otpExpiry, sent_at: now, ip_hash: input.ipHash })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      const delivery = await ctx.tx
        .insertInto('otp_delivery')
        .values({ challenge_id: challenge.id, code_sealed: await deps.protector.seal(code, otpSealContext(challenge.id)) })
        .returning('id')
        .executeTakeFirstOrThrow();
      await appendAudit(ctx, { action: 'acceptance_otp.sent', entityType: 'acceptance_challenge', entityId: challenge.id, after: { quote_id: quote.id, destination, expires_at: otpExpiry, channel: 'EMAIL' } });
      await enqueueOutbox(ctx, { type: 'acceptance_otp.deliver', aggregateType: 'acceptance_challenge', aggregateId: challenge.id, payload: { deliveryId: delivery.id } });
      return { challengeId: challenge.id, destination, expiresAt: otpExpiry.toISOString() };
    },
  }, { name: 'quote_link.request_otp', actor: { type: 'CLIENT_LINK', id: link.linkId, surface: 'PUBLIC' }, payload: { link: link.tokenHash, clientUserId }, financial: false });
  return out.result;
}

export type ChallengeFailure = 'OTP_INVALID' | 'OTP_EXPIRED' | 'OTP_ATTEMPTS_EXCEEDED' | 'QUOTE_EXPIRED' | 'QUOTE_NOT_SENT';

const UNIFORM_OTP_MESSAGE = 'The code is invalid or has expired.';

/**
 * Verification step with committed attempt accounting (STATE_MACHINES §2 "wrong code increments attempts in a separate
 * committed step"). Runs in its own transaction, commits the attempt/expiry change, then reports the outcome; the
 * decision command itself re-verifies under its locks. Messages are uniform for all OTP failures.
 */
export async function verifyChallengeCode(db: Db, deps: QuoteDeps, input: { link: ResolvedLink; challengeId: string; code: string }): Promise<{ clientUserId: string; userId: string }> {
  const challengeId = requireUuid(input.challengeId, 'challengeId');
  const outcome = await db.transaction().execute(async (tx) => {
    const c = await tx.selectFrom('acceptance_challenge').selectAll().where('id', '=', challengeId).forUpdate().executeTakeFirst();
    if (!c || c.quote_id !== input.link.quoteId || c.quote_link_id !== input.link.linkId) return { fail: 'OTP_INVALID' as ChallengeFailure };
    const quote = await tx.selectFrom('quote').select(['status', 'expires_at']).where('id', '=', c.quote_id).executeTakeFirstOrThrow();
    const now = await businessNow(tx);
    if (quote.status === 'SENT' && quote.expires_at && now >= quote.expires_at) return { fail: 'QUOTE_EXPIRED' as ChallengeFailure };
    if (quote.status !== 'SENT') return { fail: (quote.status === 'EXPIRED' ? 'QUOTE_EXPIRED' : 'QUOTE_NOT_SENT') as ChallengeFailure };
    if (c.status === 'FAILED') return { fail: 'OTP_ATTEMPTS_EXCEEDED' as ChallengeFailure };
    if (c.status !== 'PENDING') return { fail: (c.status === 'EXPIRED' ? 'OTP_EXPIRED' : 'OTP_INVALID') as ChallengeFailure };
    if (now >= c.expires_at) {
      await tx.updateTable('acceptance_challenge').set({ status: 'EXPIRED', closed_at: sql<Date>`inrp2p_now()` }).where('id', '=', c.id).execute();
      await tx.updateTable('otp_delivery').set({ code_sealed: null, erased_reason: 'CHALLENGE_CLOSED' }).where('challenge_id', '=', c.id).where('code_sealed', 'is not', null).execute();
      return { fail: 'OTP_EXPIRED' as ChallengeFailure };
    }
    const code = typeof input.code === 'string' && /^[0-9]{6}$/.test(input.code) ? input.code : '';
    if (!hashesEqual(c.code_hash, codeHash(deps, code, c.code_salt))) {
      const attempts = c.attempts + 1;
      const failed = attempts >= c.max_attempts;
      await tx.updateTable('acceptance_challenge').set({ attempts, ...(failed ? { status: 'FAILED' as const, closed_at: sql<Date>`inrp2p_now()` } : {}) }).where('id', '=', c.id).execute();
      if (failed) await tx.updateTable('otp_delivery').set({ code_sealed: null, erased_reason: 'CHALLENGE_CLOSED' }).where('challenge_id', '=', c.id).where('code_sealed', 'is not', null).execute();
      await tx.insertInto('audit_event').values({ actor_type: 'CLIENT_LINK', actor_id: input.link.linkId, surface: 'PUBLIC', action: 'acceptance_otp.failed', entity_type: 'acceptance_challenge', entity_id: c.id, before: null, after: JSON.stringify({ attempts, locked: failed }), correlation_id: `otp-verify-${c.id}-${attempts}`, idempotency_key: null, session_id: null, ip_hash: null }).execute();
      return { fail: (failed ? 'OTP_ATTEMPTS_EXCEEDED' : 'OTP_INVALID') as ChallengeFailure, attemptsRemaining: c.max_attempts - attempts };
    }
    const cu = await tx.selectFrom('client_user').select(['id', 'user_id']).where('id', '=', c.client_user_id).executeTakeFirstOrThrow();
    return { ok: { clientUserId: cu.id, userId: cu.user_id } };
  });
  if ('ok' in outcome && outcome.ok) return outcome.ok;
  const fail = (outcome as { fail: ChallengeFailure; attemptsRemaining?: number }).fail;
  const remaining = (outcome as { attemptsRemaining?: number }).attemptsRemaining;
  if (fail === 'QUOTE_EXPIRED') throw new DomainError('QUOTE_EXPIRED', 'quote has expired');
  if (fail === 'QUOTE_NOT_SENT') throw new DomainError('QUOTE_NOT_SENT', 'quote is no longer open');
  throw new DomainError(fail, UNIFORM_OTP_MESSAGE, remaining === undefined ? {} : { attemptsRemaining: remaining });
}

/** Re-verification under the decision command's locks (no attempt accounting: a mismatch here is a race). */
export async function consumeChallengeInCommand(ctx: TxContext, deps: QuoteDeps, input: { challengeId: string; quoteId: string; linkId: string; code: string; purpose: 'ACCEPT' | 'REJECT' }): Promise<{ clientUserId: string; userId: string }> {
  const c = await ctx.tx.selectFrom('acceptance_challenge').selectAll().where('id', '=', input.challengeId).executeTakeFirst();
  const now = await businessNow(ctx.tx);
  const code = /^[0-9]{6}$/.test(input.code) ? input.code : '';
  if (!c || c.quote_id !== input.quoteId || c.quote_link_id !== input.linkId || c.status !== 'PENDING' || now >= c.expires_at || !hashesEqual(c.code_hash, codeHash(deps, code, c.code_salt))) {
    throw new DomainError('OTP_INVALID', UNIFORM_OTP_MESSAGE);
  }
  const cu = await ctx.tx.selectFrom('client_user').select(['id', 'user_id', 'client_id']).where('id', '=', c.client_user_id).executeTakeFirstOrThrow();
  await ctx.tx.updateTable('acceptance_challenge').set({ status: 'CONSUMED', consumed_for: input.purpose, consumed_at: sql<Date>`inrp2p_now()`, closed_at: sql<Date>`inrp2p_now()` }).where('id', '=', c.id).execute();
  await eraseDeliveries(ctx, [c.id]);
  await appendAudit(ctx, { action: 'acceptance_otp.verified', entityType: 'acceptance_challenge', entityId: c.id, after: { purpose: input.purpose, quote_id: input.quoteId } });
  return { clientUserId: cu.id, userId: cu.user_id };
}

/** Rate limit for accept/reject attempts per link token (SECURITY §7). */
export async function hitDecisionRateLimit(db: Db, deps: Pick<QuoteDeps, 'policy'>, token: unknown): Promise<void> {
  await hitRateLimit(db, { bucket: 'link_decision', subject: linkTokenHash(token), limit: policyOf(deps).decisionsPerTokenPerMinute, windowSeconds: 60 });
}
