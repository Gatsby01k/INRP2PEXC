import { sql } from 'kysely';
import { DomainError, optionalText, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import { type TxContext, isUniqueViolation } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type OperatorActor, operatorCommand } from '@inrp2p/identity';
import { closeOrdersForRequests, normalizeDeskHandle } from '@inrp2p/trader-core';
import { lockRow } from './actors.ts';
import { cancelSentQuoteOfRequest, closeRequest } from './requests.ts';

/**
 * INRP2P's desk over the desks (block 11, ADR 0020 §2.17). A desk is a trader's own exchange, but on INRP2P's platform and
 * under its name: INRP2P can stop one from taking new deals (suspend), take down a page whose name or words do not belong
 * (hide), and give it another name (rename) — each with the reason, which the desk's people are told. Its open deals are
 * never touched: what a client already accepted settles. The platform's fee changes only when one person proposes it and
 * another approves it.
 */

const reasonOf = (v: unknown) => {
  const r = requireText(v, 'reason', 500);
  if (r.length < 10) throw new DomainError('INVALID_ARGUMENT', 'say why, in words the desk will read (at least 10 characters)', { field: 'reason' });
  return r;
};

async function lockDesk(ctx: TxContext, deskId: string) {
  const r = await sql<{ id: string; trader_id: string; handle: string; display_name: string; status: string; page_hidden_reason: string | null; version: number }>`
    select id, trader_id, handle, display_name, status, page_hidden_reason, version from desk where id = ${requireUuid(deskId, 'deskId')} for update`.execute(ctx.tx);
  const d = r.rows[0];
  if (!d) throw new DomainError('NOT_FOUND', 'desk not found');
  return d;
}

async function tellDesk(ctx: TxContext, d: { id: string; trader_id: string }, action: 'SUSPENDED' | 'RESUMED' | 'PAGE_HIDDEN' | 'PAGE_SHOWN' | 'RENAMED', reason: string | null) {
  await enqueueOutbox(ctx, { type: 'trader.desk_moderated', aggregateType: 'desk', aggregateId: d.id, payload: { traderId: d.trader_id, deskId: d.id, action, ...(reason ? { reason } : {}) } });
}

/**
 * `desk.suspend` — `desks:moderate` (⧗), with the reason. No new deal on the desk: what its clients are asking now is
 * withdrawn (their requests, a live price, the capacity it holds), its links cannot be taken, its page reads as paused.
 * Deals already accepted settle as they would. Only INRP2P lifts it.
 */
export function suspendDesk(actor: OperatorActor) {
  return operatorCommand(actor, 'desks:moderate', async (ctx, p: { deskId: string; reason: string }) => {
    const reason = reasonOf(p.reason);
    // Locks: the desk's open requests, their quotes, the orders behind them — then the desk itself.
    const open = await ctx.tx.selectFrom('trade_request').select(['id', 'version']).where('desk_id', '=', requireUuid(p.deskId, 'deskId')).where('status', 'in', ['OPEN', 'QUOTED']).orderBy('id').execute();
    for (const r of open) await lockRow(ctx.tx, 'trade_request', 'trade_request', r.id);
    for (const r of open) await cancelSentQuoteOfRequest(ctx, r.id, 'WITHDRAWN');
    await closeOrdersForRequests(ctx, open.map((r) => r.id));
    for (const r of open) await closeRequest(ctx.tx, r.id, 'WITHDRAWN', 'the desk is not taking deals right now', r.version);
    const d = await lockDesk(ctx, p.deskId);
    if (d.status === 'SUSPENDED') throw new DomainError('INVALID_TRANSITION', 'this desk is suspended already');
    await ctx.tx.updateTable('desk')
      .set({ status: 'SUSPENDED', suspension_reason: reason, suspended_at: sql<Date>`inrp2p_now()`, updated_at: sql<Date>`inrp2p_now()`, version: d.version + 1 })
      .where('id', '=', d.id).execute();
    await appendAudit(ctx, { action: 'desk.suspended', entityType: 'desk', entityId: d.id, before: { status: d.status }, after: { status: 'SUSPENDED', reason, withdrawn_requests: open.length } });
    await tellDesk(ctx, d, 'SUSPENDED', reason);
    return { status: 'SUSPENDED' as const, withdrawnRequests: open.length };
  });
}

/** `desk.resume` — `desks:moderate` (⧗). The suspension ends; the desk is paused, for its people to take live again. */
export function resumeDesk(actor: OperatorActor) {
  return operatorCommand(actor, 'desks:moderate', async (ctx, p: { deskId: string; note?: string | null }) => {
    const note = optionalText(p.note, 'note', 500);
    const d = await lockDesk(ctx, p.deskId);
    if (d.status !== 'SUSPENDED') throw new DomainError('INVALID_TRANSITION', 'this desk is not suspended');
    await ctx.tx.updateTable('desk')
      .set({ status: 'PAUSED', suspension_reason: null, suspended_at: null, updated_at: sql<Date>`inrp2p_now()`, version: d.version + 1 })
      .where('id', '=', d.id).execute();
    await appendAudit(ctx, { action: 'desk.resumed', entityType: 'desk', entityId: d.id, before: { status: 'SUSPENDED' }, after: { status: 'PAUSED', note } });
    await tellDesk(ctx, d, 'RESUMED', note);
    return { status: 'PAUSED' as const };
  });
}

/**
 * `desk.hide_page` — `desks:moderate` (⧗), with the reason. The page is gone for everyone (its address answers "not found",
 * the sitemap drops it) until INRP2P shows it again; the desk is told why, and may change its name and words meanwhile.
 * Its clients and links are untouched.
 */
export function hideDeskPage(actor: OperatorActor) {
  return operatorCommand(actor, 'desks:moderate', async (ctx, p: { deskId: string; reason: string }) => {
    const reason = reasonOf(p.reason);
    const d = await lockDesk(ctx, p.deskId);
    if (d.page_hidden_reason !== null) throw new DomainError('INVALID_TRANSITION', 'this desk\'s page is hidden already');
    await ctx.tx.updateTable('desk')
      .set({ page_hidden_reason: reason, page_hidden_at: sql<Date>`inrp2p_now()`, updated_at: sql<Date>`inrp2p_now()`, version: d.version + 1 })
      .where('id', '=', d.id).execute();
    await appendAudit(ctx, { action: 'desk.page_hidden', entityType: 'desk', entityId: d.id, after: { reason, handle: d.handle, display_name: d.display_name } });
    await tellDesk(ctx, d, 'PAGE_HIDDEN', reason);
    return { hidden: true as const };
  });
}

/** `desk.show_page` — `desks:moderate` (⧗): the page is back, as the desk now has it. */
export function showDeskPage(actor: OperatorActor) {
  return operatorCommand(actor, 'desks:moderate', async (ctx, p: { deskId: string; note?: string | null }) => {
    const note = optionalText(p.note, 'note', 500);
    const d = await lockDesk(ctx, p.deskId);
    if (d.page_hidden_reason === null) throw new DomainError('INVALID_TRANSITION', 'this desk\'s page is not hidden');
    await ctx.tx.updateTable('desk')
      .set({ page_hidden_reason: null, page_hidden_at: null, updated_at: sql<Date>`inrp2p_now()`, version: d.version + 1 })
      .where('id', '=', d.id).execute();
    await appendAudit(ctx, { action: 'desk.page_shown', entityType: 'desk', entityId: d.id, before: { reason: d.page_hidden_reason }, after: { note, handle: d.handle, display_name: d.display_name } });
    await tellDesk(ctx, d, 'PAGE_SHOWN', note);
    return { hidden: false as const };
  });
}

/**
 * `desk.rename` — `desks:moderate` (⧗), with the reason: a new name and, when the old address itself does not belong, a
 * new address — the one way a live desk's address changes (links to the old one stop working, IX121).
 */
export function renameDesk(actor: OperatorActor) {
  return operatorCommand(actor, 'desks:moderate', async (ctx, p: { deskId: string; displayName?: string | null; handle?: string | null; reason: string }) => {
    const reason = reasonOf(p.reason);
    const d = await lockDesk(ctx, p.deskId);
    const displayName = p.displayName ? requireText(p.displayName, 'displayName', 60) : d.display_name;
    if (displayName.length < 2) throw new DomainError('INVALID_ARGUMENT', 'a name is at least 2 characters', { field: 'displayName' });
    const handle = p.handle ? normalizeDeskHandle(p.handle) : d.handle;
    if (handle === d.handle && displayName === d.display_name) throw new DomainError('INVALID_ARGUMENT', 'nothing to change');
    try {
      await ctx.tx.updateTable('desk')
        .set({
          display_name: displayName, handle,
          ...(handle !== d.handle ? { handle_moderated_at: sql<Date>`inrp2p_now()` } : {}),
          updated_at: sql<Date>`inrp2p_now()`, version: d.version + 1,
        })
        .where('id', '=', d.id).execute();
    } catch (e) {
      if (isUniqueViolation(e)) throw new DomainError('DESK_HANDLE_TAKEN', 'another desk has this address', { field: 'handle' });
      throw e;
    }
    await appendAudit(ctx, { action: 'desk.renamed', entityType: 'desk', entityId: d.id, before: { handle: d.handle, display_name: d.display_name }, after: { handle, display_name: displayName, reason } });
    await tellDesk(ctx, d, 'RENAMED', reason);
    return { handle, displayName };
  });
}

// ---- the platform's fee ------------------------------------------------------------------------------------------

const bpsOf = (v: unknown, field: string) => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1000) throw new DomainError('INVALID_ARGUMENT', `${field} is a whole number of basis points from 0 to 1000`, { field });
  return v;
};

/**
 * `fee_policy.propose` — `fees:propose` (⧗). A new fee, with why: nothing changes until someone else approves it. One open
 * proposal at a time.
 */
export function proposeFeePolicy(actor: OperatorActor) {
  return operatorCommand(actor, 'fees:propose', async (ctx, p: { ownDealBps: number; networkDealBps: number; reason: string }) => {
    const own = bpsOf(p.ownDealBps, 'ownDealBps');
    const network = bpsOf(p.networkDealBps, 'networkDealBps');
    const reason = reasonOf(p.reason);
    const current = await ctx.tx.selectFrom('fee_policy').select(['own_deal_bps', 'network_deal_bps']).orderBy('set_at', 'desc').orderBy('id', 'desc').executeTakeFirstOrThrow();
    if (current.own_deal_bps === own && current.network_deal_bps === network) throw new DomainError('INVALID_ARGUMENT', 'this is the fee already');
    let row;
    try {
      row = await ctx.tx.insertInto('fee_policy_proposal')
        .values({ own_deal_bps: own, network_deal_bps: network, reason, proposed_by: ctx.actor.id ?? 'SYSTEM' })
        .returning('id').executeTakeFirstOrThrow();
    } catch (e) {
      if (isUniqueViolation(e)) throw new DomainError('INVALID_TRANSITION', 'a change of the fee is waiting for a decision already');
      throw e;
    }
    await appendAudit(ctx, { action: 'fee_policy.proposed', entityType: 'fee_policy_proposal', entityId: row.id, before: current, after: { own_deal_bps: own, network_deal_bps: network, reason } });
    return { proposalId: row.id };
  });
}

/**
 * `fee_policy.decide` — `fees:approve` (⧗✱), never by the proposer. Approved, the proposal becomes the fee for every price
 * from now on (a price already given keeps its own, IX045); rejected, nothing changes.
 */
export function decideFeePolicy(actor: OperatorActor) {
  return operatorCommand(actor, 'fees:approve', async (ctx, p: { proposalId: string; decision: 'APPROVE' | 'REJECT'; note?: string | null }) => {
    const decision = requireOneOf(p.decision, 'decision', ['APPROVE', 'REJECT'] as const);
    const note = optionalText(p.note, 'note', 500);
    const prop = await ctx.tx.selectFrom('fee_policy_proposal').selectAll().where('id', '=', requireUuid(p.proposalId, 'proposalId')).forUpdate().executeTakeFirst();
    if (!prop) throw new DomainError('NOT_FOUND', 'proposal not found');
    if (prop.status !== 'PROPOSED') throw new DomainError('INVALID_TRANSITION', `this proposal is ${prop.status.toLowerCase()}`);
    const me = ctx.actor.id ?? 'SYSTEM';
    if (prop.proposed_by === me) throw new DomainError('SECOND_APPROVER_REQUIRED', 'a change of the fee is decided by someone other than the one who proposed it');
    let policyId: string | null = null;
    if (decision === 'APPROVE') {
      await sql`select pg_advisory_xact_lock(hashtext('inrp2p.fee_policy'))`.execute(ctx.tx);
      const policy = await ctx.tx.insertInto('fee_policy')
        .values({ own_deal_bps: prop.own_deal_bps, network_deal_bps: prop.network_deal_bps, reason: prop.reason, set_by: prop.proposed_by, approved_by: me })
        .returning('id').executeTakeFirstOrThrow();
      policyId = policy.id;
    }
    await ctx.tx.updateTable('fee_policy_proposal')
      .set({ status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', decided_by: me, decided_at: sql<Date>`inrp2p_now()`, decision_note: note, fee_policy_id: policyId })
      .where('id', '=', prop.id).execute();
    await appendAudit(ctx, { action: decision === 'APPROVE' ? 'fee_policy.approved' : 'fee_policy.rejected', entityType: 'fee_policy_proposal', entityId: prop.id, after: { own_deal_bps: prop.own_deal_bps, network_deal_bps: prop.network_deal_bps, note, fee_policy_id: policyId } });
    return { status: decision === 'APPROVE' ? ('APPROVED' as const) : ('REJECTED' as const) };
  });
}

/** `fee_policy.withdraw` — `fees:propose`: the proposer takes its own open proposal back. */
export function withdrawFeePolicy(actor: OperatorActor) {
  return operatorCommand(actor, 'fees:propose', async (ctx, p: { proposalId: string }) => {
    const prop = await ctx.tx.selectFrom('fee_policy_proposal').select(['id', 'status', 'proposed_by']).where('id', '=', requireUuid(p.proposalId, 'proposalId')).forUpdate().executeTakeFirst();
    if (!prop) throw new DomainError('NOT_FOUND', 'proposal not found');
    if (prop.status !== 'PROPOSED') throw new DomainError('INVALID_TRANSITION', `this proposal is ${prop.status.toLowerCase()}`);
    const me = ctx.actor.id ?? 'SYSTEM';
    if (prop.proposed_by !== me) throw new DomainError('FORBIDDEN', 'only the one who proposed it withdraws it');
    await ctx.tx.updateTable('fee_policy_proposal').set({ status: 'WITHDRAWN', decided_by: me, decided_at: sql<Date>`inrp2p_now()` }).where('id', '=', prop.id).execute();
    await appendAudit(ctx, { action: 'fee_policy.withdrawn', entityType: 'fee_policy_proposal', entityId: prop.id, after: { status: 'WITHDRAWN' } });
    return { status: 'WITHDRAWN' as const };
  });
}
