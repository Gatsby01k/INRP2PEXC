import { sql } from 'kysely';
import { DomainError, Money, requireText, requireUuid } from '@inrp2p/kernel';
import type { Tx, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type OperatorActor, actorLabel, operatorCommand } from '@inrp2p/identity';
import { createTraderRoute, updateTraderRouteRegistration } from '@inrp2p/routes';
import { lockTrader, parseRewardBps, traderProgram, withdrawOffers } from '@inrp2p/trader-core';

export interface RegisteredDestinations {
  readonly bank: { id: string; bankName: string; last4: string; holderName: string };
  readonly wallet: { id: string; address: string; label: string };
}

/**
 * The trader's registered settlement details: one bank account and one TRC20 wallet of its own client, both verified
 * (ACTIVE) — details the trader submitted itself count only once an operator has verified them (migration 0023).
 *
 * The wallet must be usable both ways (`BOTH`): a trader's USDT leaves from it (Sell USDT orders, Security Reserve
 * deposits) and comes back to it (Buy USDT orders, reserve withdrawals). The bank account is where the trader's INR
 * comes from and where INR is paid to it.
 */
export async function requireVerifiedBank(tx: Tx, clientId: string, bankAccountId: string): Promise<RegisteredDestinations['bank']> {
  const bank = await tx
    .selectFrom('bank_account')
    .select(['id', 'client_id', 'status', 'bank_name', 'account_last4', 'holder_name'])
    .where('id', '=', requireUuid(bankAccountId, 'bankAccountId'))
    .forShare()
    .executeTakeFirst();
  if (!bank || bank.client_id !== clientId) throw new DomainError('TRADER_DESTINATION_INVALID', 'choose a bank account registered to your account');
  if (bank.status === 'PENDING_REVIEW') throw new DomainError('TRADER_DESTINATION_UNVERIFIED', 'the bank account is waiting for the desk to verify it');
  if (bank.status !== 'ACTIVE') throw new DomainError('TRADER_DESTINATION_INVALID', 'choose an active bank account registered to your account');
  return { id: bank.id, bankName: bank.bank_name, last4: bank.account_last4, holderName: bank.holder_name };
}

export async function requireVerifiedWallet(tx: Tx, clientId: string, walletId: string): Promise<RegisteredDestinations['wallet']> {
  const wallet = await tx
    .selectFrom('crypto_wallet')
    .select(['id', 'client_id', 'status', 'purpose', 'address', 'label', 'network'])
    .where('id', '=', requireUuid(walletId, 'walletId'))
    .forShare()
    .executeTakeFirst();
  if (!wallet || wallet.client_id !== clientId || wallet.network !== 'TRON') throw new DomainError('TRADER_DESTINATION_INVALID', 'choose a TRC20 wallet registered to your account');
  if (wallet.status === 'PENDING_REVIEW') throw new DomainError('TRADER_DESTINATION_UNVERIFIED', 'the wallet is waiting for the desk to verify it');
  if (wallet.status !== 'ACTIVE') throw new DomainError('TRADER_DESTINATION_INVALID', 'choose an active TRC20 wallet registered to your account');
  if (wallet.purpose !== 'BOTH') {
    throw new DomainError('TRADER_DESTINATION_INVALID', 'the wallet must be registered for sending and receiving: your USDT leaves from it and returns to it');
  }
  return { id: wallet.id, address: wallet.address, label: wallet.label };
}

export async function requireRegisteredDestinations(tx: Tx, clientId: string, input: { bankAccountId: string; walletId: string }): Promise<RegisteredDestinations> {
  return { bank: await requireVerifiedBank(tx, clientId, input.bankAccountId), wallet: await requireVerifiedWallet(tx, clientId, input.walletId) };
}

/** The payout identity a trader route carries: the bank, never the full account number. */
export const payoutIdentityOf = (bank: { bankName: string; last4: string }): string => `${bank.bankName} ••••${bank.last4}`;

export const positiveOrNull = (value: string | null | undefined, currency: 'INR' | 'USDT', field: string): bigint | null => {
  if (value === undefined || value === null || value === '') return null;
  const m = Money.parse(value, currency);
  if (!m.isPositive()) throw new DomainError('INVALID_AMOUNT', `${field} must be positive`, { field });
  return m.minor;
};

/**
 * Settlement details change only between orders: an order accepted or in progress settles with the details it was
 * accepted under, so the desk switches them once the trader has none open (TD-24).
 */
export async function assertNoOpenOrders(tx: Tx, traderId: string): Promise<void> {
  const open = await tx.selectFrom('trader_order').select('ref').where('trader_id', '=', traderId).where('status', 'in', ['ACCEPTED', 'IN_PROGRESS']).execute();
  if (open.length > 0) {
    throw new DomainError('TRADER_ORDERS_OPEN', `the trader has ${open.length === 1 ? 'an order' : `${open.length} orders`} in progress (${open.map((o) => o.ref).join(', ')}); change settlement details once they are finished`);
  }
}

export interface LimitsPayload {
  /** Operator ceilings, decimal strings; null removes a ceiling, undefined leaves it as it is. */
  readonly maxOrderInr?: string | null;
  readonly maxOrderUsdt?: string | null;
  readonly maxCapacityInr?: string | null;
  readonly maxCapacityUsdt?: string | null;
}

function limitColumns(p: LimitsPayload) {
  return {
    ...(p.maxOrderInr !== undefined ? { max_order_inr_minor: positiveOrNull(p.maxOrderInr, 'INR', 'maxOrderInr') } : {}),
    ...(p.maxOrderUsdt !== undefined ? { max_order_usdt_minor: positiveOrNull(p.maxOrderUsdt, 'USDT', 'maxOrderUsdt') } : {}),
    ...(p.maxCapacityInr !== undefined ? { max_capacity_inr_minor: positiveOrNull(p.maxCapacityInr, 'INR', 'maxCapacityInr') } : {}),
    ...(p.maxCapacityUsdt !== undefined ? { max_capacity_usdt_minor: positiveOrNull(p.maxCapacityUsdt, 'USDT', 'maxCapacityUsdt') } : {}),
  };
}

export interface ApprovePayload extends LimitsPayload {
  readonly traderId: string;
  /** Decimal USDT. Omitted: the programme's default — and approval is refused when neither is set. */
  readonly requiredReserve?: string | null;
  /** Reward override for this trader in basis points; omitted or null follows the programme. */
  readonly rewardBps?: number | null;
  readonly note?: string | null;
}

/**
 * `trader.approve` — `traders:configure` (⧗). The bank account and wallet must already be verified (each is its own
 * decision, `trader.review_destination`); approval fixes the Security Reserve the trader must keep locked and opens
 * the trader's route and capacity block for each side it applied for. The trader starts offline, with its blocks
 * paused: nothing is assigned until the trader has funded its reserve, set its rates and switched on itself.
 *
 * A client that exists only to provide capacity (no Exchange access) gets, here and only here, the authority to
 * commit to orders: its applicant becomes able to accept orders for it. Verifying an email never grants that.
 */
export function approveTrader(actor: OperatorActor) {
  return operatorCommand(actor, 'traders:configure', async (ctx, p: ApprovePayload) => {
    const trader = await lockTrader(ctx, p.traderId);
    if (trader.status !== 'UNDER_REVIEW') throw new DomainError('INVALID_TRANSITION', `the trader is ${trader.status}`);
    const profile = await ctx.tx.selectFrom('trader_profile').selectAll().where('id', '=', trader.id).executeTakeFirstOrThrow();
    const program = await traderProgram(ctx.tx);
    const reserve = p.requiredReserve ? Money.parse(p.requiredReserve, 'USDT') : program.defaultRequiredReserve;
    if (!reserve || !reserve.isPositive()) throw new DomainError('TRADER_RESERVE_NOT_SET', 'set the Security Reserve for this trader, or a programme default, before approving');
    const unverified = await pendingRegistered(ctx.tx, profile.bank_account_id, profile.wallet_id);
    if (unverified.length > 0) throw new DomainError('TRADER_DESTINATION_UNVERIFIED', `verify the submitted ${unverified.join(' and ')} before approving`);
    const destinations = await requireRegisteredDestinations(ctx.tx, trader.client_id, { bankAccountId: profile.bank_account_id, walletId: profile.wallet_id });
    const note = typeof p.note === 'string' && p.note.trim() ? p.note.trim().slice(0, 500) : null;

    const payoutIdentity = payoutIdentityOf(destinations.bank);
    const sides = [...(profile.offers_buy ? (['BUY_USDT'] as const) : []), ...(profile.offers_sell ? (['SELL_USDT'] as const) : [])];
    for (const side of sides) {
      const existing = await ctx.tx.selectFrom('trader_block').select('id').where('trader_id', '=', trader.id).where('side', '=', side).executeTakeFirst();
      if (existing) continue;
      const route = await createTraderRoute(ctx, {
        traderId: trader.id,
        name: `Trader ${trader.ref} · ${side === 'BUY_USDT' ? 'Buy USDT' : 'Sell USDT'}`,
        // A trader buying USDT is the other side of a client selling it, and the other way round.
        direction: side === 'BUY_USDT' ? 'SELL_USDT' : 'BUY_USDT',
        registeredRouteAddress: destinations.wallet.address,
        registeredPayoutIdentity: payoutIdentity,
      });
      await ctx.tx.insertInto('trader_block').values({ trader_id: trader.id, side, route_id: route.routeId }).execute();
    }
    const after = await ctx.tx
      .updateTable('trader_profile')
      .set({
        status: 'APPROVED',
        required_reserve_minor: reserve.minor,
        reward_bps: parseRewardBps(p.rewardBps),
        ...limitColumns(p),
        reviewed_by: actorLabel(ctx),
        reviewed_at: sql<Date>`inrp2p_now()`,
        review_note: note,
        updated_at: sql<Date>`inrp2p_now()`,
        version: trader.version + 1,
      })
      .where('id', '=', trader.id)
      .returning(['required_reserve_minor', 'reward_bps', 'max_order_inr_minor', 'max_order_usdt_minor', 'max_capacity_inr_minor', 'max_capacity_usdt_minor'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, { action: 'trader.approved', entityType: 'trader_profile', entityId: trader.id, before: { status: trader.status }, after: { status: 'APPROVED', sides, note, ...after } });
    await grantTraderCommitment(ctx, trader.client_id, profile.applied_by);
    await enqueueOutbox(ctx, { type: 'trader.approved', aggregateType: 'trader_profile', aggregateId: trader.id, payload: { traderId: trader.id, clientId: trader.client_id } });
    return { status: 'APPROVED' as const, sides };
  });
}

/** `trader.reject` — `traders:configure` (⧗), with a note the applicant sees. They may apply again. */
export function rejectTrader(actor: OperatorActor) {
  return operatorCommand(actor, 'traders:configure', async (ctx, p: { traderId: string; note: string }) => {
    const note = requireText(p.note, 'note', 500);
    const trader = await lockTrader(ctx, p.traderId);
    if (trader.status !== 'UNDER_REVIEW') throw new DomainError('INVALID_TRANSITION', `the trader is ${trader.status}`);
    await ctx.tx
      .updateTable('trader_profile')
      .set({ status: 'REJECTED', reviewed_by: actorLabel(ctx), reviewed_at: sql<Date>`inrp2p_now()`, review_note: note, updated_at: sql<Date>`inrp2p_now()`, version: trader.version + 1 })
      .where('id', '=', trader.id)
      .execute();
    await appendAudit(ctx, { action: 'trader.rejected', entityType: 'trader_profile', entityId: trader.id, before: { status: trader.status }, after: { status: 'REJECTED', note } });
    await enqueueOutbox(ctx, { type: 'trader.rejected', aggregateType: 'trader_profile', aggregateId: trader.id, payload: { traderId: trader.id, clientId: trader.client_id, reason: note } });
    return { status: 'REJECTED' as const };
  });
}

/**
 * `trader.pause` — `traders:pause` (⧗), with a reason the trader sees. The trader goes offline and nothing new is
 * assigned; its pending offers are withdrawn (and routed on). Orders already accepted or in progress continue to
 * their end: pausing never breaks a commitment already made, and never touches the reserve.
 */
export function pauseTrader(actor: OperatorActor) {
  return operatorCommand(actor, 'traders:pause', async (ctx, p: { traderId: string; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    const trader = await lockTrader(ctx, p.traderId);
    if (trader.status !== 'APPROVED') throw new DomainError('INVALID_TRANSITION', `the trader is ${trader.status}`);
    const withdrawn = await withdrawOffers(ctx, { traderId: trader.id }, 'TRADER_PAUSED');
    await ctx.tx
      .updateTable('trader_profile')
      .set({ status: 'PAUSED', available: false, control_note: reason, updated_at: sql<Date>`inrp2p_now()`, version: trader.version + 1 })
      .where('id', '=', trader.id)
      .execute();
    await appendAudit(ctx, { action: 'trader.paused', entityType: 'trader_profile', entityId: trader.id, before: { status: trader.status, available: trader.available }, after: { status: 'PAUSED', available: false, reason, offers_withdrawn: withdrawn } });
    await enqueueOutbox(ctx, { type: 'trader.paused', aggregateType: 'trader_profile', aggregateId: trader.id, payload: { traderId: trader.id, clientId: trader.client_id, reason } });
    return { status: 'PAUSED' as const, offersWithdrawn: withdrawn };
  });
}

/** `trader.resume` — `traders:pause` (⧗). Back to APPROVED and still offline: the trader switches on itself. */
export function resumeTrader(actor: OperatorActor) {
  return operatorCommand(actor, 'traders:pause', async (ctx, p: { traderId: string; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    const trader = await lockTrader(ctx, p.traderId);
    if (trader.status !== 'PAUSED') throw new DomainError('INVALID_TRANSITION', `the trader is ${trader.status}`);
    await ctx.tx
      .updateTable('trader_profile')
      .set({ status: 'APPROVED', control_note: null, updated_at: sql<Date>`inrp2p_now()`, version: trader.version + 1 })
      .where('id', '=', trader.id)
      .execute();
    await appendAudit(ctx, { action: 'trader.resumed', entityType: 'trader_profile', entityId: trader.id, before: { status: 'PAUSED' }, after: { status: 'APPROVED', reason } });
    await enqueueOutbox(ctx, { type: 'trader.resumed', aggregateType: 'trader_profile', aggregateId: trader.id, payload: { traderId: trader.id, clientId: trader.client_id, reason } });
    return { status: 'APPROVED' as const };
  });
}

/**
 * `trader.set_assignments` — `traders:pause` (⧗). Stops (or restarts) new assignments without taking the trader
 * offline: a risk hold the trader sees, with the reason, on its own screen. Pending offers are withdrawn.
 */
export function setTraderAssignments(actor: OperatorActor) {
  return operatorCommand(actor, 'traders:pause', async (ctx, p: { traderId: string; enabled: boolean; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    const enabled = p.enabled === true;
    const trader = await lockTrader(ctx, p.traderId);
    if (trader.assignments_enabled === enabled) return { changed: false, offersWithdrawn: 0 };
    const withdrawn = enabled ? 0 : await withdrawOffers(ctx, { traderId: trader.id }, 'ASSIGNMENTS_DISABLED');
    await ctx.tx
      .updateTable('trader_profile')
      .set({ assignments_enabled: enabled, control_note: enabled ? null : reason, updated_at: sql<Date>`inrp2p_now()`, version: trader.version + 1 })
      .where('id', '=', trader.id)
      .execute();
    await appendAudit(ctx, {
      action: 'trader.assignments_changed', entityType: 'trader_profile', entityId: trader.id,
      before: { assignments_enabled: trader.assignments_enabled }, after: { assignments_enabled: enabled, reason, offers_withdrawn: withdrawn },
    });
    return { changed: true, offersWithdrawn: withdrawn };
  });
}

/**
 * `trader.set_limits` — `traders:configure` (⧗). Operator ceilings over what the trader may set. Lowering one never
 * edits the trader's own numbers: routing uses the lower of the two, and the trader's screen says which applies.
 */
export function setTraderLimits(actor: OperatorActor) {
  return operatorCommand(actor, 'traders:configure', async (ctx, p: LimitsPayload & { traderId: string; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    const trader = await lockTrader(ctx, p.traderId);
    const before = await ctx.tx.selectFrom('trader_profile').select(['max_order_inr_minor', 'max_order_usdt_minor', 'max_capacity_inr_minor', 'max_capacity_usdt_minor']).where('id', '=', trader.id).executeTakeFirstOrThrow();
    const after = await ctx.tx
      .updateTable('trader_profile')
      .set({ ...limitColumns(p), updated_at: sql<Date>`inrp2p_now()`, version: trader.version + 1 })
      .where('id', '=', trader.id)
      .returning(['max_order_inr_minor', 'max_order_usdt_minor', 'max_capacity_inr_minor', 'max_capacity_usdt_minor'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, { action: 'trader.limits_changed', entityType: 'trader_profile', entityId: trader.id, before, after: { ...after, reason } });
    return { changed: true };
  });
}

/**
 * `trader.set_required_reserve` — `traders:configure` (⧗). Raising it above what the trader holds does not take
 * the trader offline or touch its orders; new assignments simply stop until the reserve is topped up, and the
 * trader is told exactly how much is missing. Nothing happens silently.
 */
export function setTraderRequiredReserve(actor: OperatorActor) {
  return operatorCommand(actor, 'traders:configure', async (ctx, p: { traderId: string; requiredReserve: string; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    const required = Money.parse(p.requiredReserve, 'USDT');
    if (!required.isPositive()) throw new DomainError('INVALID_AMOUNT', 'the Security Reserve must be positive');
    const trader = await lockTrader(ctx, p.traderId);
    if (trader.status !== 'APPROVED' && trader.status !== 'PAUSED') throw new DomainError('TRADER_NOT_APPROVED', `the trader is ${trader.status}`);
    await ctx.tx.updateTable('trader_profile').set({ required_reserve_minor: required.minor, updated_at: sql<Date>`inrp2p_now()`, version: trader.version + 1 }).where('id', '=', trader.id).execute();
    await appendAudit(ctx, {
      action: 'trader.required_reserve_changed', entityType: 'trader_profile', entityId: trader.id,
      before: { required_reserve: trader.required_reserve_minor === null ? null : Money.ofMinor(trader.required_reserve_minor, 'USDT') },
      after: { required_reserve: required, reason },
    });
    await enqueueOutbox(ctx, { type: 'trader.reserve_issue', aggregateType: 'trader_profile', aggregateId: trader.id, payload: { traderId: trader.id, reason: 'REQUIREMENT_CHANGED', amount: required.toDecimalString() } });
    return { changed: true };
  });
}

/** `trader.set_reward` — `traders:configure` (⧗). Applies to orders that start afterwards; running ones keep theirs. */
export function setTraderReward(actor: OperatorActor) {
  return operatorCommand(actor, 'traders:configure', async (ctx, p: { traderId: string; rewardBps: number | null; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    const bps = parseRewardBps(p.rewardBps);
    const trader = await lockTrader(ctx, p.traderId);
    const before = await ctx.tx.selectFrom('trader_profile').select('reward_bps').where('id', '=', trader.id).executeTakeFirstOrThrow();
    await ctx.tx.updateTable('trader_profile').set({ reward_bps: bps, updated_at: sql<Date>`inrp2p_now()`, version: trader.version + 1 }).where('id', '=', trader.id).execute();
    await appendAudit(ctx, { action: 'trader.reward_changed', entityType: 'trader_profile', entityId: trader.id, before: { reward_bps: before.reward_bps }, after: { reward_bps: bps, reason } });
    return { changed: true };
  });
}

/**
 * `trader.set_settlement_details` — `traders:configure` (⧗). The desk points the trader at another of its client's
 * verified bank accounts or wallets (a trader proposes its own with `trader.propose_settlement_change`). Refused
 * while an order is accepted or in progress. The trader's routes follow, so deliveries are expected from, and paid
 * to, the new wallet.
 */
export function setTraderSettlementDetails(actor: OperatorActor) {
  return operatorCommand(actor, 'traders:configure', async (ctx, p: { traderId: string; bankAccountId: string; walletId: string; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    const trader = await lockTrader(ctx, p.traderId);
    const destinations = await requireRegisteredDestinations(ctx.tx, trader.client_id, p);
    if (destinations.bank.id !== trader.bank_account_id || destinations.wallet.id !== trader.wallet_id) await assertNoOpenOrders(ctx.tx, trader.id);
    // A proposal the trader made for the side the desk just set is settled by this decision.
    const profile = await ctx.tx.selectFrom('trader_profile').select(['proposed_bank_account_id', 'proposed_wallet_id']).where('id', '=', trader.id).executeTakeFirstOrThrow();
    await ctx.tx
      .updateTable('trader_profile')
      .set({
        bank_account_id: destinations.bank.id,
        wallet_id: destinations.wallet.id,
        ...(profile.proposed_bank_account_id === destinations.bank.id ? { proposed_bank_account_id: null } : {}),
        ...(profile.proposed_wallet_id === destinations.wallet.id ? { proposed_wallet_id: null } : {}),
        updated_at: sql<Date>`inrp2p_now()`,
        version: trader.version + 1,
      })
      .where('id', '=', trader.id)
      .execute();
    await updateTraderRouteRegistration(ctx, { traderId: trader.id, registeredRouteAddress: destinations.wallet.address, registeredPayoutIdentity: payoutIdentityOf(destinations.bank), reason });
    await appendAudit(ctx, {
      action: 'trader.settlement_details_changed', entityType: 'trader_profile', entityId: trader.id,
      before: { bank_account_id: trader.bank_account_id, wallet_id: trader.wallet_id }, after: { bank_account_id: destinations.bank.id, wallet_id: destinations.wallet.id, reason },
    });
    return { changed: true };
  });
}

/** Which of a profile's registered destinations still wait for the desk. */
async function pendingRegistered(tx: Tx, bankAccountId: string, walletId: string): Promise<string[]> {
  const bank = await tx.selectFrom('bank_account').select('status').where('id', '=', bankAccountId).executeTakeFirstOrThrow();
  const wallet = await tx.selectFrom('crypto_wallet').select('status').where('id', '=', walletId).executeTakeFirstOrThrow();
  return [...(bank.status === 'PENDING_REVIEW' ? ['bank account'] : []), ...(wallet.status === 'PENDING_REVIEW' ? ['wallet'] : [])];
}

/**
 * On approval of a client that provides capacity only, its applicant may commit to orders — the authority every
 * trader action that binds money checks (`can_accept_quotes`, D-01). Such a client has no Exchange access, so this
 * opens no quote to anyone (IX080 refuses its requests). A client the desk onboarded keeps the authority it set.
 */
async function grantTraderCommitment(ctx: TxContext, clientId: string, userId: string): Promise<void> {
  const client = await ctx.tx.selectFrom('client').select('exchange_access').where('id', '=', clientId).executeTakeFirstOrThrow();
  if (client.exchange_access) return;
  const cu = await ctx.tx
    .selectFrom('client_user')
    .select(['id', 'role', 'status', 'can_accept_quotes'])
    .where('client_id', '=', clientId)
    .where('user_id', '=', userId)
    .forUpdate()
    .executeTakeFirst();
  if (!cu || cu.status !== 'ACTIVE' || cu.role !== 'CLIENT_ADMIN' || cu.can_accept_quotes) return;
  await ctx.tx.updateTable('client_user').set({ can_accept_quotes: true, updated_at: sql<Date>`statement_timestamp()` }).where('id', '=', cu.id).execute();
  await appendAudit(ctx, {
    action: 'client_user.accept_permission_changed', entityType: 'client_user', entityId: cu.id,
    before: { can_accept_quotes: false }, after: { can_accept_quotes: true, changed_via: 'trader.approve' },
  });
}

export async function traderIdOfClient(tx: Tx, clientId: string): Promise<string | null> {
  const row = await tx.selectFrom('trader_profile').select('id').where('client_id', '=', clientId).executeTakeFirst();
  return row?.id ?? null;
}

export type { TxContext };
