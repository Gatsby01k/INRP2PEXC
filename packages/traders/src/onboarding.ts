import { sql } from 'kysely';
import {
  DomainError, Money, last4, normalizeIfsc, normalizeIndianAccountNumber, normalizePhone, optionalText, parseTronAddress, requireOneOf, requireText, requireUuid,
} from '@inrp2p/kernel';
import { type P2pExperience, type Rail, type Tx, type TxContext, isUniqueViolation } from '@inrp2p/db';
import type { FieldProtector } from '@inrp2p/adapters';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { BANK_ACCOUNT_HMAC_CONTEXT, bankAccountSealContext } from '@inrp2p/clients';
import { type ClientActor, type DomainCommand, type OperatorActor, actorLabel, operatorCommand } from '@inrp2p/identity';
import { updateTraderRouteRegistration } from '@inrp2p/routes';
import { type TraderApplicant, type TraderMember, assertAuthority, lockTrader, lockTraderOfClient, traderApplicant, traderClientCommand } from '@inrp2p/trader-core';
import { assertNoOpenOrders, payoutIdentityOf, positiveOrNull, requireVerifiedBank, requireVerifiedWallet } from './profile.ts';

/**
 * Trader self-onboarding (docs/TRADERS.md §3): a person applies with their own details, submits their own bank
 * account and TRC20 wallet, and the desk reviews each of them. Nothing a trader types is usable until an operator
 * has verified it — a submitted destination is PENDING_REVIEW, and everything that moves money asks for ACTIVE.
 */

/** AAD context for a trader's contact phone, bound to its client like every other sealed value (SECURITY §5). */
export const traderPhoneSealContext = (clientId: string) => `trader_profile.phone:${clientId}`;

const RAILS = ['IMPS', 'NEFT', 'RTGS'] as const;
const EXPERIENCE: readonly P2pExperience[] = ['BINANCE', 'BYBIT', 'OTHER', 'NONE'];

export interface BankDetails {
  readonly holderName: string;
  readonly bankName: string;
  readonly accountNumber: string;
  readonly ifsc: string;
  readonly rails?: readonly Rail[];
}

export interface WalletDetails {
  readonly address: string;
  readonly label?: string | null;
}

export type DestinationKind = 'BANK' | 'WALLET';

interface Submitted {
  readonly id: string;
  readonly status: 'ACTIVE' | 'PENDING_REVIEW';
  /** Already on file for this client (verified, or waiting for review) — nothing new was created. */
  readonly reused: boolean;
  readonly label: string;
}

const bankLabel = (bankName: string, digits: string) => `${bankName} ••••${digits}`;
const walletLabel = (address: string) => `TRC20 ${address.slice(0, 4)}…${address.slice(-4)}`;

/**
 * A bank account the client submitted. The same account already on the client's file — verified or still waiting —
 * is used as it is rather than registered twice; anything new waits for the desk.
 */
async function submitBank(ctx: TxContext, protector: FieldProtector, clientId: string, d: BankDetails): Promise<Submitted> {
  if (!d || typeof d !== 'object') throw new DomainError('INVALID_ARGUMENT', 'enter your bank account', { field: 'bank' });
  const accountNumber = normalizeIndianAccountNumber(d.accountNumber);
  const hmac = protector.lookupHash(accountNumber, BANK_ACCOUNT_HMAC_CONTEXT);
  const onFile = async () =>
    ctx.tx
      .selectFrom('bank_account')
      .select(['id', 'status', 'bank_name', 'account_last4'])
      .where('client_id', '=', clientId)
      .where('account_hmac', '=', hmac)
      .where('status', 'in', ['ACTIVE', 'PENDING_REVIEW'])
      .orderBy(sql`status = 'ACTIVE'`, 'desc')
      .executeTakeFirst();
  const existing = await onFile();
  if (existing) return { id: existing.id, status: existing.status as Submitted['status'], reused: true, label: bankLabel(existing.bank_name, existing.account_last4) };
  const rails = [...new Set((d.rails && d.rails.length > 0 ? d.rails : RAILS).map((r) => requireOneOf(r, 'rails', RAILS)))];
  const bankName = requireText(d.bankName, 'bankName', 140);
  try {
    const row = await ctx.tx
      .insertInto('bank_account')
      .values({
        client_id: clientId,
        holder_name: requireText(d.holderName, 'holderName', 140),
        bank_name: bankName,
        ifsc: normalizeIfsc(d.ifsc),
        account_number_enc: await protector.seal(accountNumber, bankAccountSealContext(clientId)),
        account_last4: last4(accountNumber),
        account_hmac: hmac,
        rail_preferences: rails,
        status: 'PENDING_REVIEW',
        created_by: actorLabel(ctx),
      })
      .returning(['id', 'account_last4'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, { action: 'client_bank.submitted', entityType: 'bank_account', entityId: row.id, after: { client_id: clientId, bank_name: bankName, account_last4: row.account_last4, rails, status: 'PENDING_REVIEW' } });
    return { id: row.id, status: 'PENDING_REVIEW', reused: false, label: bankLabel(bankName, row.account_last4) };
  } catch (e) {
    if (isUniqueViolation(e, 'bank_account_pending_unique')) {
      const raced = await onFile();
      if (raced) return { id: raced.id, status: raced.status as Submitted['status'], reused: true, label: bankLabel(raced.bank_name, raced.account_last4) };
    }
    throw e;
  }
}

/** A TRC20 wallet the client submitted, registered for sending and receiving, waiting for the desk. */
async function submitWallet(ctx: TxContext, clientId: string, d: WalletDetails): Promise<Submitted> {
  if (!d || typeof d !== 'object') throw new DomainError('INVALID_ARGUMENT', 'enter your TRC20 wallet', { field: 'wallet' });
  const address = parseTronAddress(typeof d.address === 'string' ? d.address.trim() : '');
  const onFile = async () =>
    ctx.tx
      .selectFrom('crypto_wallet')
      .select(['id', 'status', 'purpose'])
      .where('client_id', '=', clientId)
      .where('network', '=', 'TRON')
      .where('address', '=', address)
      .where('status', 'in', ['ACTIVE', 'PENDING_REVIEW'])
      .orderBy(sql`status = 'ACTIVE'`, 'desc')
      .executeTakeFirst();
  const existing = await onFile();
  if (existing) {
    if (existing.purpose !== 'BOTH') {
      throw new DomainError('TRADER_DESTINATION_INVALID', 'this wallet is registered with INRP2P for one direction only; a trader wallet sends and receives, so submit another wallet');
    }
    return { id: existing.id, status: existing.status as Submitted['status'], reused: true, label: walletLabel(address) };
  }
  const label = optionalText(d.label, 'walletLabel', 80) ?? 'Trader wallet';
  try {
    const row = await ctx.tx
      .insertInto('crypto_wallet')
      .values({ client_id: clientId, network: 'TRON', address, label, purpose: 'BOTH', status: 'PENDING_REVIEW', created_by: actorLabel(ctx) })
      .returning('id')
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, { action: 'client_wallet.submitted', entityType: 'crypto_wallet', entityId: row.id, after: { client_id: clientId, network: 'TRON', address, label, purpose: 'BOTH', status: 'PENDING_REVIEW' } });
    return { id: row.id, status: 'PENDING_REVIEW', reused: false, label: walletLabel(address) };
  } catch (e) {
    if (isUniqueViolation(e, 'crypto_wallet_pending_unique')) {
      const raced = await onFile();
      if (raced) return { id: raced.id, status: raced.status as Submitted['status'], reused: true, label: walletLabel(address) };
    }
    throw e;
  }
}

/** A submitted destination that nothing points at any more is withdrawn, so it never waits for a review nobody needs. */
async function withdrawIfPending(ctx: TxContext, kind: DestinationKind, id: string | null, reason: string): Promise<void> {
  if (!id) return;
  const table = kind === 'BANK' ? 'bank_account' : 'crypto_wallet';
  const updated = await ctx.tx
    .updateTable(table)
    .set({ status: 'ARCHIVED', archived_by: actorLabel(ctx), archived_at: sql<Date>`statement_timestamp()`, archive_reason: reason })
    .where('id', '=', id)
    .where('status', '=', 'PENDING_REVIEW')
    .returning('id')
    .executeTakeFirst();
  if (updated) await appendAudit(ctx, { action: kind === 'BANK' ? 'client_bank.withdrawn' : 'client_wallet.withdrawn', entityType: table, entityId: id, before: { status: 'PENDING_REVIEW' }, after: { status: 'ARCHIVED', reason } });
}

function requireConfirmation(value: unknown): void {
  if (value !== true) throw new DomainError('OWNERSHIP_NOT_CONFIRMED', 'confirm that the bank account and wallet belong to you or your company', { field: 'confirmOwnership' });
}

function telegramHandle(value: unknown): string | null {
  const raw = optionalText(value, 'telegram', 64);
  if (!raw) return null;
  const handle = raw.replace(/^https?:\/\/(www\.)?t\.me\//i, '').replace(/^t\.me\//i, '').replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{5,32}$/.test(handle)) throw new DomainError('INVALID_ARGUMENT', 'a Telegram username is 5–32 letters, digits or underscores', { field: 'telegram' });
  return `@${handle}`;
}

function capacityPair(offers: boolean, typical: string | null | undefined, daily: string | null | undefined, currency: 'INR' | 'USDT') {
  if (!offers) return { typical: null, daily: null };
  const t = positiveOrNull(typical, currency, currency === 'INR' ? 'typicalInr' : 'typicalUsdt');
  const d = positiveOrNull(daily, currency, currency === 'INR' ? 'dailyInr' : 'dailyUsdt');
  if (t === null) throw new DomainError('INVALID_AMOUNT', `enter your typical order size in ${currency}`, { field: currency === 'INR' ? 'typicalInr' : 'typicalUsdt' });
  if (d === null) throw new DomainError('INVALID_AMOUNT', `enter the ${currency} you can provide in a day`, { field: currency === 'INR' ? 'dailyInr' : 'dailyUsdt' });
  if (d < t) throw new DomainError('INVALID_AMOUNT', `your daily ${currency} capacity must be at least your typical order`, { field: currency === 'INR' ? 'dailyInr' : 'dailyUsdt' });
  return { typical: t, daily: d };
}

export interface ApplyPayload {
  /** About you. Used when this person has no client yet; an existing client's name and type are its record with the desk. */
  readonly fullName?: string | null;
  readonly entityType?: 'INDIVIDUAL' | 'COMPANY' | null;
  /** How the desk reaches the trader: at least one. */
  readonly telegram?: string | null;
  readonly phone?: string | null;
  readonly experience: P2pExperience;
  readonly profileLink?: string | null;
  readonly offersBuy: boolean;
  readonly offersSell: boolean;
  /** Typical order and daily capacity, decimal INR (Buy USDT side) and USDT (Sell USDT side). */
  readonly typicalInr?: string | null;
  readonly dailyInr?: string | null;
  readonly typicalUsdt?: string | null;
  readonly dailyUsdt?: string | null;
  /** Settlement details: a destination already verified on this client's file, or new details for the desk to review. */
  readonly bankAccountId?: string | null;
  readonly bank?: BankDetails | null;
  readonly walletId?: string | null;
  readonly wallet?: WalletDetails | null;
  /** "I confirm this bank account and wallet belong to me or my company." */
  readonly confirmOwnership: boolean;
}

export interface ApplyResult {
  readonly traderId: string;
  readonly ref: string;
  readonly status: 'UNDER_REVIEW';
  readonly bankStatus: 'ACTIVE' | 'PENDING_REVIEW';
  readonly walletStatus: 'ACTIVE' | 'PENDING_REVIEW';
}

/**
 * `trader.apply` — the signed-in person, for themselves or for the client they administer.
 *
 * - Someone with no client yet (they verified their email through "Become a trader"): the application creates their
 *   client — with no Exchange access — and makes them its administrator, without permission to commit to anything.
 * - A client's `CLIENT_ADMIN`: the application is that client's, under the name and type the desk holds for it.
 *
 * The application is recorded UNDER_REVIEW. Nothing can be traded until an operator has verified the bank account
 * and the wallet and approved the trader. A rejected application may be made again; a pending or approved one may not.
 */
export function applyAsTrader(actor: ClientActor, deps: { protector: FieldProtector }): DomainCommand<ApplyPayload, ApplyResult> {
  let applicant: TraderApplicant | undefined;
  return {
    authorize: async (ctx) => {
      if (ctx.actor.surface !== 'CLIENT') throw new DomainError('SESSION_SURFACE_MISMATCH');
      applicant = await traderApplicant(ctx.tx, actor.userId);
      if (applicant.member) assertAuthority(applicant.member, 'ADMIN');
    },
    handle: async (ctx, p) => {
      if (!applicant) throw new Error('trader.apply executed without authorization');
      // One application per person at a time: two submissions of a new applicant must not create two clients.
      await sql`select pg_advisory_xact_lock(hashtext(${`trader.apply:${actor.userId}`}))`.execute(ctx.tx);
      const offersBuy = p.offersBuy === true;
      const offersSell = p.offersSell === true;
      if (!offersBuy && !offersSell) throw new DomainError('INVALID_ARGUMENT', 'choose INR, USDT or both', { field: 'offers' });
      const inrSide = capacityPair(offersBuy, p.typicalInr, p.dailyInr, 'INR');
      const usdtSide = capacityPair(offersSell, p.typicalUsdt, p.dailyUsdt, 'USDT');
      const experience = requireOneOf(p.experience, 'experience', EXPERIENCE);
      const profileLink = optionalText(p.profileLink, 'profileLink', 300);
      const telegram = telegramHandle(p.telegram);
      const phone = p.phone ? normalizePhone(p.phone) : null;
      if (!telegram && !phone) throw new DomainError('INVALID_ARGUMENT', 'enter a Telegram username or a phone number, so the desk can reach you', { field: 'contact' });
      requireConfirmation(p.confirmOwnership);

      // Re-read under the lock: a concurrent submission may have created the client already.
      const current = await traderApplicant(ctx.tx, actor.userId);
      const member = current.member ?? (await registerClient(ctx, actor.userId, p));
      if (current.member) assertAuthority(current.member, 'ADMIN');
      await renameTraderOnlyClient(ctx, member.clientId, p.fullName);
      const clientId = member.clientId;

      const existing = await ctx.tx
        .selectFrom('trader_profile')
        .select(['id', 'status', 'version', 'bank_account_id', 'wallet_id'])
        .where('client_id', '=', clientId)
        .forUpdate()
        .executeTakeFirst();
      if (existing && existing.status !== 'REJECTED') {
        throw new DomainError('TRADER_EXISTS', existing.status === 'UNDER_REVIEW' ? 'your application is already under review' : 'this account is already a trader');
      }

      const bank = p.bankAccountId
        ? { ...(await requireVerifiedBank(ctx.tx, clientId, p.bankAccountId)), status: 'ACTIVE' as const }
        : await submitBank(ctx, deps.protector, clientId, p.bank as BankDetails);
      const wallet = p.walletId
        ? { ...(await requireVerifiedWallet(ctx.tx, clientId, p.walletId)), status: 'ACTIVE' as const }
        : await submitWallet(ctx, clientId, p.wallet as WalletDetails);

      const values = {
        offers_buy: offersBuy,
        offers_sell: offersSell,
        typical_inr_minor: inrSide.typical,
        typical_usdt_minor: usdtSide.typical,
        daily_capacity_inr_minor: inrSide.daily,
        daily_capacity_usdt_minor: usdtSide.daily,
        bank_account_id: bank.id,
        wallet_id: wallet.id,
        applied_by: actor.userId,
        p2p_experience: experience,
        profile_link: profileLink,
        telegram_handle: telegram,
        phone_enc: phone ? await deps.protector.seal(phone, traderPhoneSealContext(clientId)) : null,
        phone_last4: phone ? last4(phone) : null,
        ownership_confirmed_at: sql<Date>`inrp2p_now()`,
      };
      let traderId: string;
      let ref: string;
      if (existing) {
        const row = await ctx.tx
          .updateTable('trader_profile')
          .set({
            ...values, status: 'UNDER_REVIEW', applied_at: sql<Date>`inrp2p_now()`, reviewed_by: null, reviewed_at: null, review_note: null,
            proposed_bank_account_id: null, proposed_wallet_id: null, updated_at: sql<Date>`inrp2p_now()`, version: existing.version + 1,
          })
          .where('id', '=', existing.id)
          .returning(['id', 'ref'])
          .executeTakeFirstOrThrow();
        traderId = row.id;
        ref = row.ref;
        if (existing.bank_account_id !== bank.id) await withdrawIfPending(ctx, 'BANK', existing.bank_account_id, 'replaced by a new trader application');
        if (existing.wallet_id !== wallet.id) await withdrawIfPending(ctx, 'WALLET', existing.wallet_id, 'replaced by a new trader application');
      } else {
        const row = await ctx.tx.insertInto('trader_profile').values({ client_id: clientId, ...values }).returning(['id', 'ref']).executeTakeFirstOrThrow();
        traderId = row.id;
        ref = row.ref;
      }
      await appendAudit(ctx, {
        action: 'trader.applied', entityType: 'trader_profile', entityId: traderId,
        after: {
          ref, offers_buy: offersBuy, offers_sell: offersSell, typical_inr_minor: inrSide.typical, typical_usdt_minor: usdtSide.typical,
          daily_capacity_inr_minor: inrSide.daily, daily_capacity_usdt_minor: usdtSide.daily, experience, profile_link: profileLink,
          telegram, phone_last4: values.phone_last4, bank_account_id: bank.id, bank_status: bank.status, wallet_id: wallet.id, wallet_status: wallet.status,
          ownership_confirmed: true, self_registered: current.member === null, reapplied: Boolean(existing),
        },
      });
      await enqueueOutbox(ctx, { type: 'trader.applied', aggregateType: 'trader_profile', aggregateId: traderId, payload: { traderId, clientId } });
      return { traderId, ref, status: 'UNDER_REVIEW' as const, bankStatus: bank.status, walletStatus: wallet.status };
    },
  };
}

/**
 * A new applicant's client: their name and type, no Exchange access, and themselves as its administrator — who may
 * not commit to anything until the desk approves the trader. The desk sees it as a trader application.
 */
async function registerClient(ctx: TxContext, userId: string, p: ApplyPayload): Promise<TraderMember> {
  const fullName = requireText(p.fullName, 'fullName', 120);
  const type = requireOneOf(p.entityType, 'entityType', ['INDIVIDUAL', 'COMPANY'] as const);
  const client = await ctx.tx
    .insertInto('client')
    .values({ legal_name: fullName, display_name: fullName, type, exchange_access: false, created_by: actorLabel(ctx) })
    .returning(['id', 'ref'])
    .executeTakeFirstOrThrow();
  let cu;
  try {
    cu = await ctx.tx
      .insertInto('client_user')
      .values({ client_id: client.id, user_id: userId, role: 'CLIENT_ADMIN', created_by: actorLabel(ctx) })
      .returning('id')
      .executeTakeFirstOrThrow();
  } catch (e) {
    if (isUniqueViolation(e)) throw new DomainError('IDEMPOTENCY_IN_PROGRESS', 'your application is already being submitted');
    throw e;
  }
  await appendAudit(ctx, { action: 'client.self_registered', entityType: 'client', entityId: client.id, after: { ref: client.ref, type, exchange_access: false, via: 'trader.apply', client_user_id: cu.id } });
  return { userId, clientUserId: cu.id, clientId: client.id, role: 'CLIENT_ADMIN', canCommit: false };
}

/** A client that exists only as a trader carries the applicant's own name, so re-applying may correct it. */
async function renameTraderOnlyClient(ctx: TxContext, clientId: string, fullName: string | null | undefined): Promise<void> {
  const name = optionalText(fullName, 'fullName', 120);
  if (!name) return;
  const client = await ctx.tx.selectFrom('client').select(['exchange_access', 'legal_name', 'display_name', 'version']).where('id', '=', clientId).forUpdate().executeTakeFirstOrThrow();
  if (client.exchange_access || (client.legal_name === name && client.display_name === name)) return;
  await ctx.tx.updateTable('client').set({ legal_name: name, display_name: name, version: client.version + 1, updated_at: sql<Date>`statement_timestamp()` }).where('id', '=', clientId).execute();
  await appendAudit(ctx, { action: 'client.updated', entityType: 'client', entityId: clientId, before: { legal_name: client.legal_name, display_name: client.display_name }, after: { legal_name: name, display_name: name, via: 'trader.apply' } });
}

export interface ReviewDestinationPayload {
  readonly traderId: string;
  readonly destination: DestinationKind;
  readonly decision: 'VERIFY' | 'REJECT';
  /** Required to reject; the applicant sees it. */
  readonly note?: string | null;
}

async function lockDestination(tx: Tx, kind: DestinationKind, id: string) {
  if (kind === 'BANK') {
    const r = await tx.selectFrom('bank_account').select(['id', 'client_id', 'status', 'bank_name', 'account_last4']).where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
    return { id: r.id, clientId: r.client_id, status: r.status, label: bankLabel(r.bank_name, r.account_last4), last4: r.account_last4 };
  }
  const r = await tx.selectFrom('crypto_wallet').select(['id', 'client_id', 'status', 'address']).where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
  return { id: r.id, clientId: r.client_id, status: r.status, label: walletLabel(r.address), last4: null };
}

/** PENDING_REVIEW → ACTIVE (verified) or REJECTED, recorded as the operator's own decision. */
async function decide(ctx: TxContext, kind: DestinationKind, id: string, decision: 'VERIFY' | 'REJECT', note: string | null): Promise<void> {
  const table = kind === 'BANK' ? 'bank_account' : 'crypto_wallet';
  try {
    if (decision === 'VERIFY') {
      await ctx.tx
        .updateTable(table)
        .set({ status: 'ACTIVE', reviewed_by: actorLabel(ctx), reviewed_at: sql<Date>`statement_timestamp()`, review_note: note, ...(kind === 'BANK' ? { verified_at: sql<Date>`statement_timestamp()` } : {}) })
        .where('id', '=', id)
        .execute();
    } else {
      await ctx.tx
        .updateTable(table)
        .set({ status: 'REJECTED', reviewed_by: actorLabel(ctx), reviewed_at: sql<Date>`statement_timestamp()`, review_note: note })
        .where('id', '=', id)
        .execute();
    }
  } catch (e) {
    if (isUniqueViolation(e)) throw new DomainError('DUPLICATE_DESTINATION', 'the same account is already verified for this client');
    throw e;
  }
}

function reviewNote(decision: 'VERIFY' | 'REJECT', note: unknown): string | null {
  return decision === 'REJECT' ? requireText(note, 'note', 500) : optionalText(note, 'note', 500);
}

async function notifyVerified(ctx: TxContext, kind: DestinationKind, d: { id: string; clientId: string; label: string; last4: string | null }): Promise<void> {
  await enqueueOutbox(ctx, {
    type: 'client.destination_added', aggregateType: 'client', aggregateId: d.clientId,
    payload: { clientId: d.clientId, destination: kind === 'BANK' ? 'BANK_ACCOUNT' : 'WALLET', id: d.id, label: d.label, ...(d.last4 ? { last4: d.last4 } : {}) },
  });
}

/**
 * `trader.review_destination` — `traders:configure` (⧗). Verifies or rejects the bank account or wallet an
 * application names, one at a time, without the operator retyping anything. A verified destination becomes usable
 * (and the client is told, as for any destination added to its account); a rejected one never is, and the applicant
 * sees the note and may submit another.
 */
export function reviewTraderDestination(actor: OperatorActor) {
  return operatorCommand(actor, 'traders:configure', async (ctx, p: ReviewDestinationPayload) => {
    const kind = requireOneOf(p.destination, 'destination', ['BANK', 'WALLET'] as const);
    const decision = requireOneOf(p.decision, 'decision', ['VERIFY', 'REJECT'] as const);
    const note = reviewNote(decision, p.note);
    const trader = await lockTrader(ctx, p.traderId);
    if (trader.status !== 'UNDER_REVIEW') throw new DomainError('INVALID_TRANSITION', `the trader is ${trader.status}; review a change it submits instead`);
    const d = await lockDestination(ctx.tx, kind, kind === 'BANK' ? trader.bank_account_id : trader.wallet_id);
    if (d.status !== 'PENDING_REVIEW') throw new DomainError('INVALID_TRANSITION', `the ${kind === 'BANK' ? 'bank account' : 'wallet'} is ${d.status === 'ACTIVE' ? 'already verified' : d.status.toLowerCase()}`);
    await decide(ctx, kind, d.id, decision, note);
    await appendAudit(ctx, {
      action: decision === 'VERIFY' ? 'trader.destination_verified' : 'trader.destination_rejected', entityType: 'trader_profile', entityId: trader.id,
      after: { destination: kind, id: d.id, label: d.label, note },
    });
    if (decision === 'VERIFY') await notifyVerified(ctx, kind, d);
    return { status: decision === 'VERIFY' ? ('ACTIVE' as const) : ('REJECTED' as const) };
  });
}

export interface ProposeSettlementPayload {
  readonly bank?: BankDetails | null;
  readonly wallet?: WalletDetails | null;
  readonly confirmOwnership: boolean;
}

/**
 * `trader.propose_settlement_change` — the trader's `CLIENT_ADMIN` (TD-24). A new bank account, a new TRC20 wallet, or
 * both, for the desk to review.
 *
 * - Approved (or paused) trader: the proposal waits beside the registered details, which keep settling every order
 *   until the desk approves the change (`trader.review_settlement_change`). A later proposal replaces an earlier
 *   one still waiting.
 * - Application under review: the submitted detail simply replaces the one the application named — nothing about
 *   it was usable yet.
 */
export function proposeSettlementChange(actor: ClientActor, deps: { protector: FieldProtector }) {
  return traderClientCommand(actor, 'ADMIN', async (ctx, p: ProposeSettlementPayload, member) => {
    if (!p.bank && !p.wallet) throw new DomainError('INVALID_ARGUMENT', 'enter a new bank account or a new wallet', { field: 'bank' });
    requireConfirmation(p.confirmOwnership);
    const trader = await lockTraderOfClient(ctx, member.clientId);
    if (trader.status === 'REJECTED') throw new DomainError('INVALID_TRANSITION', 'apply again to submit new details');
    const profile = await ctx.tx.selectFrom('trader_profile').select(['proposed_bank_account_id', 'proposed_wallet_id']).where('id', '=', trader.id).executeTakeFirstOrThrow();
    const bank = p.bank ? await submitBank(ctx, deps.protector, member.clientId, p.bank) : null;
    const wallet = p.wallet ? await submitWallet(ctx, member.clientId, p.wallet) : null;
    const underReview = trader.status === 'UNDER_REVIEW';
    if (!underReview) {
      if (bank?.id === trader.bank_account_id) throw new DomainError('TRADER_DESTINATION_INVALID', 'that is already your registered bank account', { field: 'bank' });
      if (wallet?.id === trader.wallet_id) throw new DomainError('TRADER_DESTINATION_INVALID', 'that is already your registered wallet', { field: 'wallet' });
    }
    const changes = underReview
      ? { ...(bank ? { bank_account_id: bank.id } : {}), ...(wallet ? { wallet_id: wallet.id } : {}) }
      : { ...(bank ? { proposed_bank_account_id: bank.id } : {}), ...(wallet ? { proposed_wallet_id: wallet.id } : {}) };
    await ctx.tx.updateTable('trader_profile').set({ ...changes, updated_at: sql<Date>`inrp2p_now()`, version: trader.version + 1 }).where('id', '=', trader.id).execute();
    const replaced = (before: string | null, now: Submitted | null) => (now && before && before !== now.id ? before : null);
    const reason = underReview ? 'replaced by the applicant before review' : 'replaced by a newer proposal';
    await withdrawIfPending(ctx, 'BANK', replaced(underReview ? trader.bank_account_id : profile.proposed_bank_account_id, bank), reason);
    await withdrawIfPending(ctx, 'WALLET', replaced(underReview ? trader.wallet_id : profile.proposed_wallet_id, wallet), reason);
    await appendAudit(ctx, {
      action: underReview ? 'trader.settlement_details_resubmitted' : 'trader.settlement_change_proposed', entityType: 'trader_profile', entityId: trader.id,
      after: {
        ...(bank ? { bank_account_id: bank.id, bank: bank.label, bank_status: bank.status } : {}),
        ...(wallet ? { wallet_id: wallet.id, wallet: wallet.label, wallet_status: wallet.status } : {}),
        ownership_confirmed: true,
      },
    });
    return { bankStatus: bank?.status ?? null, walletStatus: wallet?.status ?? null };
  });
}

export interface ReviewSettlementChangePayload {
  readonly traderId: string;
  readonly destination: DestinationKind;
  readonly decision: 'APPROVE' | 'REJECT';
  readonly note?: string | null;
}

/**
 * `trader.review_settlement_change` — `traders:configure` (⧗). Decides a change an approved trader proposed.
 *
 * Approving verifies the new destination when it was waiting, makes it the registered one and moves the trader's
 * routes to it. It is refused while an order is accepted or in progress: those settle with the details they were
 * accepted under. The previous destination stays on the client's file as it was — nothing else that uses it moves.
 * Rejecting leaves the registered details as they are; the trader sees the note.
 */
export function reviewSettlementChange(actor: OperatorActor) {
  return operatorCommand(actor, 'traders:configure', async (ctx, p: ReviewSettlementChangePayload) => {
    const kind = requireOneOf(p.destination, 'destination', ['BANK', 'WALLET'] as const);
    const decision = requireOneOf(p.decision, 'decision', ['APPROVE', 'REJECT'] as const);
    const note = reviewNote(decision === 'APPROVE' ? 'VERIFY' : 'REJECT', p.note);
    const trader = await lockTrader(ctx, p.traderId);
    if (trader.status !== 'APPROVED' && trader.status !== 'PAUSED') throw new DomainError('INVALID_TRANSITION', `the trader is ${trader.status}`);
    const profile = await ctx.tx.selectFrom('trader_profile').select(['proposed_bank_account_id', 'proposed_wallet_id']).where('id', '=', trader.id).executeTakeFirstOrThrow();
    const proposedId = kind === 'BANK' ? profile.proposed_bank_account_id : profile.proposed_wallet_id;
    if (!proposedId) throw new DomainError('NOT_FOUND', `no ${kind === 'BANK' ? 'bank account' : 'wallet'} change is waiting`);
    const d = await lockDestination(ctx.tx, kind, proposedId);
    const clearProposal = kind === 'BANK' ? { proposed_bank_account_id: null } : { proposed_wallet_id: null };

    if (decision === 'REJECT') {
      if (d.status !== 'PENDING_REVIEW' && d.status !== 'ACTIVE') throw new DomainError('INVALID_TRANSITION', `the proposed ${kind === 'BANK' ? 'bank account' : 'wallet'} is ${d.status.toLowerCase()}`);
      // A new detail is rejected for good, and stays named so the trader sees the note; a verified one the client
      // already had stays verified — only the switch is refused.
      if (d.status === 'PENDING_REVIEW') await decide(ctx, kind, d.id, 'REJECT', note);
      else await ctx.tx.updateTable('trader_profile').set({ ...clearProposal, updated_at: sql<Date>`inrp2p_now()`, version: trader.version + 1 }).where('id', '=', trader.id).execute();
      await appendAudit(ctx, { action: 'trader.settlement_change_rejected', entityType: 'trader_profile', entityId: trader.id, after: { destination: kind, id: d.id, label: d.label, note } });
      return { status: 'REJECTED' as const };
    }

    if (d.status !== 'PENDING_REVIEW' && d.status !== 'ACTIVE') throw new DomainError('INVALID_TRANSITION', `the proposed ${kind === 'BANK' ? 'bank account' : 'wallet'} is ${d.status.toLowerCase()}`);
    await assertNoOpenOrders(ctx.tx, trader.id);
    const wasPending = d.status === 'PENDING_REVIEW';
    if (wasPending) await decide(ctx, kind, d.id, 'VERIFY', note);
    const next = {
      bankAccountId: kind === 'BANK' ? d.id : trader.bank_account_id,
      walletId: kind === 'WALLET' ? d.id : trader.wallet_id,
    };
    const bank = await requireVerifiedBank(ctx.tx, trader.client_id, next.bankAccountId);
    const wallet = await requireVerifiedWallet(ctx.tx, trader.client_id, next.walletId);
    await ctx.tx
      .updateTable('trader_profile')
      .set({ bank_account_id: bank.id, wallet_id: wallet.id, ...clearProposal, updated_at: sql<Date>`inrp2p_now()`, version: trader.version + 1 })
      .where('id', '=', trader.id)
      .execute();
    const reason = note ?? 'trader-proposed change approved';
    await updateTraderRouteRegistration(ctx, { traderId: trader.id, registeredRouteAddress: wallet.address, registeredPayoutIdentity: payoutIdentityOf(bank), reason });
    await appendAudit(ctx, {
      action: 'trader.settlement_details_changed', entityType: 'trader_profile', entityId: trader.id,
      before: { bank_account_id: trader.bank_account_id, wallet_id: trader.wallet_id },
      after: { bank_account_id: bank.id, wallet_id: wallet.id, reason, via: 'trader proposal', verified_now: wasPending },
    });
    if (wasPending) await notifyVerified(ctx, kind, d);
    return { status: 'APPROVED' as const };
  });
}

/**
 * `trader.reveal_phone` — `traders:configure` (⧗), audited: the reviewer calling an applicant. Like the bank account
 * reveal, it must run without an idempotency key, so the number is never stored in a command result.
 */
export function revealTraderPhone(actor: OperatorActor, protector: FieldProtector) {
  return operatorCommand(actor, 'traders:configure', async (ctx, p: { traderId: string }) => {
    if (ctx.idempotencyKey) throw new DomainError('INVALID_ARGUMENT', 'trader.reveal_phone must not use an idempotency key (the result is sensitive)');
    const row = await ctx.tx.selectFrom('trader_profile').select(['id', 'client_id', 'phone_enc', 'phone_last4']).where('id', '=', requireUuid(p.traderId, 'traderId')).executeTakeFirst();
    if (!row) throw new DomainError('NOT_FOUND', 'trader not found');
    if (!row.phone_enc) throw new DomainError('NOT_FOUND', 'the trader gave no phone number');
    const phone = await protector.open(row.phone_enc, traderPhoneSealContext(row.client_id));
    await appendAudit(ctx, { action: 'trader.phone_revealed', entityType: 'trader_profile', entityId: row.id, after: { phone_last4: row.phone_last4 } });
    return { phone };
  });
}

/** Typical order sizes shown back in decimal form. */
export const minorToDecimal = (minor: bigint | null, currency: 'INR' | 'USDT'): string | null => (minor === null ? null : Money.ofMinor(minor, currency).toDecimalString());
