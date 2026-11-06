import { sql } from 'kysely';
import { matchNames, requireUuid } from '@inrp2p/kernel';
import type { AutoReviewFlag, DestinationStatus, Executor, Tx, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { type TraderProgram, type TraderRow, lockTrader, reserveFigures, traderProgram } from '@inrp2p/trader-core';
import { type DestinationKind, applySettlementChangeInTx, decideDestination, lockDestination, notifyVerified } from './onboarding.ts';
import { approveTraderInTx } from './profile.ts';

/**
 * The programme's own review (ADR 0024): what a person on the desk checked by looking, decided by rules over facts of
 * record — and stronger where the record can prove something a person cannot see.
 *
 * - **The wallet is proven, not looked at.** USDT the trader sent from it — its Security Reserve, attributed by the
 *   sending wallet (IX102) — shows the trader holds its key, which no review of an address ever could.
 * - **The bank account is consistent.** Its holder is the applicant (the same words, either way round), the account is on
 *   no other client's file and was never rejected. Who holds an Indian account cannot be learnt without a bank's help
 *   (TD-33), so this is what the desk could check too; every rupee a client then confirms from it is checked again by
 *   name (ADR 0018).
 * - **The collateral is there.** The reserve the programme asks for is already held.
 *
 * Whatever a rule cannot settle is left for a person, with its reasons, and a person may decide anything at any time.
 * An application the desk once rejected is always a person's to approve again.
 */

export interface DestinationFacts {
  readonly status: DestinationStatus;
  /** Registered or waiting on another client's file. */
  readonly onFileElsewhere: boolean;
  /** Rejected before, on any client's file. */
  readonly rejectedBefore: boolean;
}

export interface ReviewFacts {
  readonly applicantName: string;
  readonly bank: DestinationFacts & { readonly holderName: string };
  /** `proven`: a confirmed USDT transfer from this wallet attributed to this trader. */
  readonly wallet: DestinationFacts & { readonly proven: boolean };
  /** The desk rejected this trader's application before. */
  readonly rejectedBefore: boolean;
  /** The programme's reserve, and what the trader holds of it free (less withdrawals on their way). */
  readonly reserveRequiredMinor: bigint | null;
  readonly reserveFreeMinor: bigint;
}

export interface ReviewVerdict {
  readonly verifyBank: boolean;
  readonly verifyWallet: boolean;
  readonly approve: boolean;
  readonly flags: readonly AutoReviewFlag[];
}

/** The account holder is the applicant: every word of one name is the other's, at least two whole words in common. */
export function namesAgree(applicant: string, holder: string): boolean {
  return matchNames(applicant, holder).verdict === 'MATCH' || matchNames(holder, applicant).verdict === 'MATCH';
}

function bankFlags(f: ReviewFacts): AutoReviewFlag[] {
  if (f.bank.status === 'ACTIVE') return [];
  return [
    ...(f.bank.status === 'REJECTED' || f.bank.rejectedBefore ? (['BANK_REJECTED_BEFORE'] as const) : []),
    ...(!namesAgree(f.applicantName, f.bank.holderName) ? (['BANK_NAME_MISMATCH'] as const) : []),
    ...(f.bank.onFileElsewhere ? (['BANK_ON_FILE_ELSEWHERE'] as const) : []),
  ];
}

function walletFlags(f: ReviewFacts): AutoReviewFlag[] {
  // Proof is asked of every wallet, verified or not: a client adds its own wallets with its authenticator, and that
  // shows it typed an address, not that it holds the key.
  return [
    ...(!f.wallet.proven ? (['WALLET_NOT_PROVEN'] as const) : []),
    ...(f.wallet.status !== 'ACTIVE' && (f.wallet.status === 'REJECTED' || f.wallet.rejectedBefore) ? (['WALLET_REJECTED_BEFORE'] as const) : []),
    ...(f.wallet.status !== 'ACTIVE' && f.wallet.onFileElsewhere ? (['WALLET_ON_FILE_ELSEWHERE'] as const) : []),
  ];
}

export function reviewVerdict(f: ReviewFacts): ReviewVerdict {
  const bank = bankFlags(f);
  const wallet = walletFlags(f);
  const approval: AutoReviewFlag[] = [
    ...(f.rejectedBefore ? (['REJECTED_BEFORE'] as const) : []),
    ...(f.reserveRequiredMinor === null ? (['NO_DEFAULT_RESERVE'] as const) : f.reserveFreeMinor < f.reserveRequiredMinor ? (['RESERVE_SHORT'] as const) : []),
  ];
  const verifyBank = f.bank.status === 'PENDING_REVIEW' && bank.length === 0;
  const verifyWallet = f.wallet.status === 'PENDING_REVIEW' && wallet.length === 0;
  const flags = [...bank, ...wallet, ...approval];
  return { verifyBank, verifyWallet, approve: flags.length === 0, flags };
}

/** Whether a wallet sent USDT that was credited to this trader — the proof it holds the key. */
async function walletProven(ex: Executor, traderId: string, address: string): Promise<boolean> {
  const r = await sql<{ proven: boolean }>`
    select exists (select 1 from crypto_transfer c
                    where c.payer_type = 'TRADER' and c.payer_id = ${traderId} and c.network = 'TRON'
                      and c.from_address = ${address} and c.state = 'CONFIRMED') as proven`.execute(ex);
  return r.rows[0]!.proven;
}

async function bankFacts(tx: Tx, id: string): Promise<ReviewFacts['bank']> {
  const b = await tx.selectFrom('bank_account').select(['client_id', 'status', 'holder_name', 'account_hmac']).where('id', '=', id).executeTakeFirstOrThrow();
  const others = await sql<{ elsewhere: boolean; rejected: boolean }>`
    select exists (select 1 from bank_account o where o.account_hmac = ${b.account_hmac} and o.client_id <> ${b.client_id} and o.status in ('ACTIVE', 'PENDING_REVIEW')) as elsewhere,
           exists (select 1 from bank_account o where o.account_hmac = ${b.account_hmac} and o.id <> ${id} and o.status = 'REJECTED') as rejected`.execute(tx);
  return { status: b.status, holderName: b.holder_name, onFileElsewhere: others.rows[0]!.elsewhere, rejectedBefore: others.rows[0]!.rejected };
}

async function walletFacts(tx: Tx, traderId: string, id: string): Promise<ReviewFacts['wallet'] & { readonly address: string }> {
  const w = await tx.selectFrom('crypto_wallet').select(['client_id', 'status', 'address', 'network']).where('id', '=', id).executeTakeFirstOrThrow();
  const others = await sql<{ elsewhere: boolean; rejected: boolean }>`
    select exists (select 1 from crypto_wallet o where o.network = ${w.network} and o.address = ${w.address} and o.client_id <> ${w.client_id} and o.status in ('ACTIVE', 'PENDING_REVIEW')) as elsewhere,
           exists (select 1 from crypto_wallet o where o.network = ${w.network} and o.address = ${w.address} and o.id <> ${id} and o.status = 'REJECTED') as rejected`.execute(tx);
  return { status: w.status, address: w.address, proven: await walletProven(tx, traderId, w.address), onFileElsewhere: others.rows[0]!.elsewhere, rejectedBefore: others.rows[0]!.rejected };
}

async function readReviewFacts(tx: Tx, trader: TraderRow, program: TraderProgram): Promise<ReviewFacts> {
  const client = await tx.selectFrom('client').select('legal_name').where('id', '=', trader.client_id).executeTakeFirstOrThrow();
  const rejected = await tx.selectFrom('audit_event').select('seq').where('entity_type', '=', 'trader_profile').where('entity_id', '=', trader.id).where('action', '=', 'trader.rejected').executeTakeFirst();
  const reserve = await reserveFigures(tx, trader.id);
  return {
    applicantName: client.legal_name,
    bank: await bankFacts(tx, trader.bank_account_id),
    wallet: await walletFacts(tx, trader.id, trader.wallet_id),
    rejectedBefore: rejected !== undefined,
    reserveRequiredMinor: program.defaultRequiredReserve?.minor ?? null,
    reserveFreeMinor: reserve.balance.minor - reserve.pendingRelease.minor - reserve.applying.minor,
  };
}

export type AutoReviewOutcome = 'OFF' | 'NOT_UNDER_REVIEW' | 'WAITING' | 'APPROVED';

/** What the rules left for a person, kept on the profile for the desk and the trader; true when it changed. */
async function recordFlags(ctx: TxContext, traderId: string, flags: readonly AutoReviewFlag[]): Promise<boolean> {
  const before = await ctx.tx.selectFrom('trader_profile').select('auto_review_flags').where('id', '=', traderId).executeTakeFirstOrThrow();
  const same = before.auto_review_flags.length === flags.length && before.auto_review_flags.every((f, i) => f === flags[i]);
  await ctx.tx.updateTable('trader_profile').set({ auto_review_flags: [...flags], auto_reviewed_at: sql<Date>`inrp2p_now()` }).where('id', '=', traderId).execute();
  return !same;
}

/** Flags only a person can clear: a due change carrying one is not looked at again until something about it changes. */
export const PERSON_FLAGS: readonly AutoReviewFlag[] = ['BANK_NAME_MISMATCH', 'BANK_ON_FILE_ELSEWHERE', 'BANK_REJECTED_BEFORE', 'WALLET_ON_FILE_ELSEWHERE', 'WALLET_REJECTED_BEFORE'];

const CHECKED = 'Checked by the programme’s rules';

/**
 * `trader.auto_review` (system step, ADR 0024): one application, as its facts stand now, under the trader lock. Verifies
 * each detail the rules settle, approves when nothing is left, and records what is left otherwise — idempotent, so any
 * event that may have changed the facts simply runs it again.
 */
export async function autoReviewTraderInTx(ctx: TxContext, traderId: string): Promise<{ outcome: AutoReviewOutcome; flags: readonly AutoReviewFlag[] }> {
  const program = await traderProgram(ctx.tx);
  if (!program.autoReview) return { outcome: 'OFF', flags: [] };
  const trader = await lockTrader(ctx, requireUuid(traderId, 'traderId'));
  if (trader.status !== 'UNDER_REVIEW') return { outcome: 'NOT_UNDER_REVIEW', flags: [] };
  const facts = await readReviewFacts(ctx.tx, trader, program);
  const verdict = reviewVerdict(facts);

  for (const [kind, go] of [['BANK', verdict.verifyBank], ['WALLET', verdict.verifyWallet]] as const) {
    if (!go) continue;
    const d = await lockDestination(ctx.tx, kind, kind === 'BANK' ? trader.bank_account_id : trader.wallet_id);
    if (d.status !== 'PENDING_REVIEW') continue;
    const note = kind === 'BANK' ? `${CHECKED}: holder is the applicant, on no other file` : `${CHECKED}: USDT sent from it reached the reserve`;
    await decideDestination(ctx, kind, d.id, 'VERIFY', note);
    await appendAudit(ctx, { action: 'trader.destination_verified', entityType: 'trader_profile', entityId: trader.id, after: { destination: kind, id: d.id, label: d.label, note, via: 'AUTO_REVIEW' } });
    await notifyVerified(ctx, kind, d);
  }

  const changed = await recordFlags(ctx, trader.id, verdict.flags);
  if (!verdict.approve) {
    if (changed) await appendAudit(ctx, { action: 'trader.auto_review_waiting', entityType: 'trader_profile', entityId: trader.id, after: { flags: verdict.flags } });
    return { outcome: 'WAITING', flags: verdict.flags };
  }
  await approveTraderInTx(ctx, trader, {
    reserve: program.defaultRequiredReserve, limits: {}, via: 'AUTO_REVIEW',
    note: `${CHECKED}: wallet proven on chain, bank account consistent, Security Reserve funded`,
  });
  return { outcome: 'APPROVED', flags: [] };
}

/** Applications the rules have something to look at: all of them waiting, when auto-review is switched on. */
export async function applicationsUnderReview(ex: Executor): Promise<string[]> {
  const rows = await ex.selectFrom('trader_profile').select('id').where('status', '=', 'UNDER_REVIEW').orderBy('applied_at').execute();
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------------------------------------------------
// A change of an approved trader's details, after its hold
// ---------------------------------------------------------------------------------------------------------------------

/** Changes whose hold is over and that still wait: the trader sweep offers each to `applyDueSettlementChangeInTx`. */
export async function dueSettlementChanges(ex: Executor): Promise<string[]> {
  const rows = await sql<{ id: string }>`
    select t.id from trader_profile t
     where t.proposal_effective_at is not null and t.proposal_effective_at <= inrp2p_now() and t.status in ('APPROVED', 'PAUSED')
       and not (t.auto_review_flags && ${sql.raw(`array[${PERSON_FLAGS.map((f) => `'${f}'`).join(', ')}]::text[]`)} and t.auto_reviewed_at >= t.proposal_effective_at)
       and (exists (select 1 from bank_account b where b.id = t.proposed_bank_account_id and b.status in ('PENDING_REVIEW', 'ACTIVE'))
            or exists (select 1 from crypto_wallet w where w.id = t.proposed_wallet_id and w.status in ('PENDING_REVIEW', 'ACTIVE')))
     order by t.proposal_effective_at`.execute(ex);
  return rows.rows.map((r) => r.id);
}

export type DueChangeOutcome = 'OFF' | 'NOT_DUE' | 'ORDERS_OPEN' | 'WAITING' | 'APPLIED';

/**
 * `trader.apply_settlement_change` (system step, ADR 0024): a proposal whose hold is over, applied by the same rules as an
 * application's details — a bank account in the trader's own name and on nobody else's file; a wallet on nobody else's
 * file and never rejected. It waits while an order is open (those settle with the details they were accepted under), and
 * for a person when a rule is not met.
 */
export async function applyDueSettlementChangeInTx(ctx: TxContext, traderId: string): Promise<{ outcome: DueChangeOutcome; flags: readonly AutoReviewFlag[] }> {
  const program = await traderProgram(ctx.tx);
  if (!program.autoReview) return { outcome: 'OFF', flags: [] };
  const trader = await lockTrader(ctx, requireUuid(traderId, 'traderId'));
  const p = await sql<{ bank: string | null; wallet: string | null; due: boolean }>`
    select proposed_bank_account_id as bank, proposed_wallet_id as wallet,
           (proposal_effective_at is not null and proposal_effective_at <= inrp2p_now()) as due
      from trader_profile where id = ${trader.id}`.execute(ctx.tx);
  const proposal = p.rows[0]!;
  if ((trader.status !== 'APPROVED' && trader.status !== 'PAUSED') || !proposal.due) return { outcome: 'NOT_DUE', flags: [] };
  const open = await ctx.tx.selectFrom('trader_order').select('id').where('trader_id', '=', trader.id).where('status', 'in', ['ACCEPTED', 'IN_PROGRESS']).executeTakeFirst();
  if (open) {
    // Tried again every minute until the orders finish; written once.
    const current = await ctx.tx.selectFrom('trader_profile').select('auto_review_flags').where('id', '=', trader.id).executeTakeFirstOrThrow();
    if (current.auto_review_flags.length !== 1 || current.auto_review_flags[0] !== 'ORDERS_OPEN') await recordFlags(ctx, trader.id, ['ORDERS_OPEN']);
    return { outcome: 'ORDERS_OPEN', flags: ['ORDERS_OPEN'] };
  }
  const client = await ctx.tx.selectFrom('client').select('legal_name').where('id', '=', trader.client_id).executeTakeFirstOrThrow();
  const flags: AutoReviewFlag[] = [];
  const ready: { kind: DestinationKind; id: string }[] = [];
  if (proposal.bank) {
    const b = await bankFacts(ctx.tx, proposal.bank);
    const own: AutoReviewFlag[] = b.status === 'REJECTED' || b.status === 'ARCHIVED'
      ? []
      : [
          ...(b.status !== 'ACTIVE' && b.rejectedBefore ? (['BANK_REJECTED_BEFORE'] as const) : []),
          ...(!namesAgree(client.legal_name, b.holderName) ? (['BANK_NAME_MISMATCH'] as const) : []),
          ...(b.onFileElsewhere ? (['BANK_ON_FILE_ELSEWHERE'] as const) : []),
        ];
    flags.push(...own);
    if ((b.status === 'PENDING_REVIEW' || b.status === 'ACTIVE') && own.length === 0) ready.push({ kind: 'BANK', id: proposal.bank });
  }
  if (proposal.wallet) {
    const w = await walletFacts(ctx.tx, trader.id, proposal.wallet);
    const own: AutoReviewFlag[] = w.status === 'REJECTED' || w.status === 'ARCHIVED'
      ? []
      : [...(w.status !== 'ACTIVE' && w.rejectedBefore ? (['WALLET_REJECTED_BEFORE'] as const) : []), ...(w.onFileElsewhere ? (['WALLET_ON_FILE_ELSEWHERE'] as const) : [])];
    flags.push(...own);
    if ((w.status === 'PENDING_REVIEW' || w.status === 'ACTIVE') && own.length === 0) ready.push({ kind: 'WALLET', id: proposal.wallet });
  }
  for (const r of ready) {
    const d = await lockDestination(ctx.tx, r.kind, r.id);
    await applySettlementChangeInTx(ctx, trader, r.kind, d, { note: `${CHECKED} after the hold`, via: 'AUTO_REVIEW' });
  }
  const changed = await recordFlags(ctx, trader.id, flags);
  if (flags.length > 0) {
    if (changed || ready.length > 0) await appendAudit(ctx, { action: 'trader.auto_review_waiting', entityType: 'trader_profile', entityId: trader.id, after: { flags, applied: ready.map((r) => r.kind) } });
    return { outcome: ready.length > 0 ? 'APPLIED' : 'WAITING', flags };
  }
  return { outcome: 'APPLIED', flags: [] };
}
