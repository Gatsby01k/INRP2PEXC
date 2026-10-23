import { sql } from 'kysely';
import { DomainError, Money, formatTrx, normalizeTronAddress, parseTrx, requireText, requireUuid, trxToInrMinor } from '@inrp2p/kernel';
import type { Executor, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type ClientActor, type OperatorActor, operatorCommand } from '@inrp2p/identity';
import { postJournal, traderNetworkReimbursementJournal } from '@inrp2p/ledger';
import type { TrxTransferFacts } from '@inrp2p/adapters';
import { lockTrader, traderClientCommand } from '@inrp2p/trader-core';
import { tradeNetworkFee } from './pricing.ts';

/**
 * The TRX network budget (ADR 0017 §2): the only money the exchange's signer burns. Each funder — a trader's network
 * deposit, or the platform's own budget (`traderId = null`) — has a balance in `network_budget_entry`, kept apart from
 * trading money (the ledger) and from the Security Reserve. A trade holds the worst case of its transfers from
 * acceptance; a top-up spends from it; what is left goes back when the trade is over. Nothing is committed that the
 * funder does not have (FI-91, IX108).
 */
export type Funder = string | null;

const funderKey = (f: Funder) => `inrp2p.network_budget:${f ?? 'platform'}`;

/** Serializes everything that commits a funder's TRX — the same lock the database check takes at commit (IX108). */
export async function lockFunder(ctx: TxContext, funder: Funder): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${funderKey(funder)}))`.execute(ctx.tx);
}

export async function networkAvailable(ex: Executor, funder: Funder): Promise<bigint> {
  const r = await sql<{ a: string }>`select inrp2p_network_available(${funder}::uuid)::text as a`.execute(ex);
  return BigInt(r.rows[0]!.a);
}

export interface BudgetFigures {
  readonly funder: Funder;
  /** Σ of the funder's entries: deposits less what was spent and withdrawn. */
  readonly balanceSun: bigint;
  /** Held for open trades and not yet spent. */
  readonly heldSun: bigint;
  /** Top-ups signed or about to be, not final yet. */
  readonly inFlightSun: bigint;
  /** Withdrawals requested or approved. */
  readonly withdrawingSun: bigint;
  /** What the funder can still commit. */
  readonly availableSun: bigint;
  readonly depositedSun: bigint;
  readonly spentSun: bigint;
  readonly withdrawnSun: bigint;
}

export async function budgetFigures(ex: Executor, funder: Funder): Promise<BudgetFigures> {
  const r = await sql<{ balance: string; deposited: string; spent: string; withdrawn: string; held: string; inflight: string; withdrawing: string; available: string }>`
    with spent as (
      select trade_id, -sum(amount_sun) as amt from network_budget_entry where kind = 'SPENT' and trader_id is not distinct from ${funder}::uuid group by trade_id
    ), pending as (
      select trade_id, sum(amount_minor + fee_estimate_sun) as amt from chain_send
       where purpose = 'TOPUP' and status not in ('CONFIRMED', 'CANCELLED') and funder_trader_id is not distinct from ${funder}::uuid group by trade_id
    )
    select
      coalesce((select sum(amount_sun) from network_budget_entry where trader_id is not distinct from ${funder}::uuid), 0)::text as balance,
      coalesce((select sum(amount_sun) from network_budget_entry where kind = 'DEPOSIT' and trader_id is not distinct from ${funder}::uuid), 0)::text as deposited,
      coalesce((select -sum(amount_sun) from network_budget_entry where kind = 'SPENT' and trader_id is not distinct from ${funder}::uuid), 0)::text as spent,
      coalesce((select -sum(amount_sun) from network_budget_entry where kind = 'WITHDRAWAL' and trader_id is not distinct from ${funder}::uuid), 0)::text as withdrawn,
      coalesce((select sum(greatest(h.amount_sun - coalesce(s.amt, 0) - coalesce(p.amt, 0), 0)) from network_budget_hold h
                 left join spent s on s.trade_id = h.trade_id left join pending p on p.trade_id = h.trade_id
                where h.status = 'ACTIVE' and h.trader_id is not distinct from ${funder}::uuid), 0)::text as held,
      coalesce((select sum(amt) from pending), 0)::text as inflight,
      coalesce((select sum(amount_sun + fee_estimate_sun) from network_deposit_withdrawal
                where ${funder}::uuid is not null and trader_id = ${funder}::uuid and status in ('REQUESTED', 'APPROVED')), 0)::text as withdrawing,
      inrp2p_network_available(${funder}::uuid)::text as available`.execute(ex);
  const row = r.rows[0]!;
  return {
    funder,
    balanceSun: BigInt(row.balance), heldSun: BigInt(row.held), inFlightSun: BigInt(row.inflight), withdrawingSun: BigInt(row.withdrawing),
    availableSun: BigInt(row.available), depositedSun: BigInt(row.deposited), spentSun: BigInt(row.spent), withdrawnSun: BigInt(row.withdrawn),
  };
}

const short = (funder: Funder, available: bigint, needed: bigint) =>
  new DomainError('NETWORK_BUDGET_INSUFFICIENT', `${funder ? "the trader's network deposit" : 'the platform network budget'} has ${formatTrx(available > 0n ? available : 0n)} TRX free; ${formatTrx(needed)} TRX is needed`, {
    funder: funder ?? 'PLATFORM', available: formatTrx(available > 0n ? available : 0n), needed: formatTrx(needed),
  });

/**
 * Holds a trade's worst case of the funder's TRX, inside the acceptance (FI-91): no trade is accepted whose transfers
 * nobody has paid for in advance. The database re-checks at commit, under the funder's lock (IX108).
 */
export async function holdNetworkBudget(ctx: TxContext, input: { tradeId: string; funder: Funder; perSendSun: bigint; sends: number; snapshotId: string }): Promise<{ holdId: string; amountSun: bigint }> {
  await lockFunder(ctx, input.funder);
  const amount = input.perSendSun * BigInt(input.sends);
  const available = await networkAvailable(ctx.tx, input.funder);
  if (available < amount) throw short(input.funder, available, amount);
  const row = await ctx.tx
    .insertInto('network_budget_hold')
    .values({ trade_id: requireUuid(input.tradeId, 'tradeId'), trader_id: input.funder, amount_sun: amount, sends: input.sends, per_send_sun: input.perSendSun, snapshot_id: input.snapshotId })
    .returning('id')
    .executeTakeFirstOrThrow();
  await appendAudit(ctx, { action: 'network.budget_held', entityType: 'trade', entityId: input.tradeId, after: { funder: input.funder ?? 'PLATFORM', amount_trx: formatTrx(amount), sends: input.sends } });
  return { holdId: row.id, amountSun: amount };
}

export async function tradeHold(ex: Executor, tradeId: string) {
  return ex.selectFrom('network_budget_hold').selectAll().where('trade_id', '=', tradeId).executeTakeFirst();
}

/** A spend for a trade: a top-up that went final (its amount and the fee it burned at the budget wallet). Once per attempt. */
export async function recordSpent(ctx: TxContext, input: { funder: Funder; tradeId: string; attemptId: string; amountSun: bigint; note: string }): Promise<void> {
  if (input.amountSun <= 0n) return;
  const inserted = await ctx.tx
    .insertInto('network_budget_entry')
    .values({
      trader_id: input.funder, kind: 'SPENT', amount_sun: -input.amountSun, trade_id: input.tradeId, chain_send_attempt_id: input.attemptId,
      posting_key: `send_fee:${input.attemptId}`, note: input.note.slice(0, 500), created_by: ctx.actor.id ?? `SYSTEM:${ctx.commandName}`,
    })
    .onConflict((oc) => oc.column('posting_key').doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted) {
    await appendAudit(ctx, { action: 'network.budget_spent', entityType: 'trade', entityId: input.tradeId, after: { funder: input.funder ?? 'PLATFORM', amount_trx: formatTrx(input.amountSun), attempt_id: input.attemptId } });
  }
}

/**
 * What a trade's transfers spent of its funder's TRX, split by who bears it: the client's own transfer (priced in),
 * the platform (its mistake, or a refund it chose to carry), or the trader (a refund its own failure caused).
 */
export async function spentByBearer(ex: Executor, tradeId: string): Promise<{ client: bigint; platform: bigint; trader: bigint; total: bigint }> {
  const r = await sql<{ bearer: 'CLIENT' | 'PLATFORM' | 'TRADER'; spent: string }>`
    select p.bearer, coalesce(-sum(e.amount_sun), 0)::text as spent
      from network_budget_entry e
      join chain_send_attempt a on a.id = e.chain_send_attempt_id
      join chain_send t on t.id = a.send_id
      join chain_send p on p.id = coalesce(t.parent_send_id, t.id)
     where e.kind = 'SPENT' and e.trade_id = ${tradeId}
     group by p.bearer`.execute(ex);
  const by = (b: string) => BigInt(r.rows.find((x) => x.bearer === b)?.spent ?? '0');
  const client = by('CLIENT');
  const platform = by('PLATFORM');
  const trader = by('TRADER');
  return { client, platform, trader, total: client + platform + trader };
}

/**
 * Closes a finished trade's hold: what it did not spend is free again, and — through the exchange — a trader that paid for
 * transfers it does not bear is owed their value in INR, at the TRX price and rate its trade was quoted with (rounded
 * down: the exchange pays). It is accrued with the trader's rewards (`network_fee:{trade}:reimburse`, Dr
 * EXPENSE:NETWORK_FEES / Cr LIAB:TRADER_REWARD_PAYABLE) and paid like them, only out of realized margin (FI-82). A P2P
 * trader bears all of its deal's transfers. The caller has checked that no transfer of the trade can still happen.
 */
export async function closeNetworkHold(ctx: TxContext, tradeId: string, reason: string): Promise<{ closed: boolean; spentSun: bigint; reimbursedSun: bigint; reimbursedInrMinor: bigint }> {
  const hold = await ctx.tx.selectFrom('network_budget_hold').selectAll().where('trade_id', '=', tradeId).forUpdate().executeTakeFirst();
  if (!hold || hold.status !== 'ACTIVE') return { closed: false, spentSun: 0n, reimbursedSun: 0n, reimbursedInrMinor: 0n };
  const spent = await spentByBearer(ctx.tx, tradeId);
  let reimbursedSun = 0n;
  let reimbursedInr = 0n;
  // A P2P deal's transfers are its trader's own cost, priced into its rate (migration 0040): nothing is paid back — no rupee
  // passes the exchange to pay it with, and the platform has no TRX budget of its own to carry it.
  const mode = (await ctx.tx.selectFrom('trade_economics').select('route_execution_mode').where('trade_id', '=', tradeId).executeTakeFirst())?.route_execution_mode;
  if (hold.trader_id && mode !== 'P2P') {
    reimbursedSun = spent.client + spent.platform;
    const terms = await tradeNetworkFee(ctx.tx, tradeId);
    if (terms && reimbursedSun > 0n) {
      reimbursedInr = trxToInrMinor(reimbursedSun, terms.usdtPerTrxMicro, terms.clientRateMicro, 'DOWN');
      if (reimbursedInr > 0n) {
        await postJournal(ctx, traderNetworkReimbursementJournal({ tradeId, traderId: hold.trader_id, amount: Money.ofMinor(reimbursedInr, 'INR') }));
      }
    }
  }
  await ctx.tx
    .updateTable('network_budget_hold')
    .set({ status: 'CLOSED', closed_at: sql<Date>`inrp2p_now()`, close_reason: reason.slice(0, 500), spent_sun: spent.total, reimbursed_sun: reimbursedSun, reimbursed_inr_minor: reimbursedInr })
    .where('id', '=', hold.id)
    .execute();
  await appendAudit(ctx, {
    action: 'network.budget_released', entityType: 'trade', entityId: tradeId,
    after: { funder: hold.trader_id ?? 'PLATFORM', held_trx: formatTrx(hold.amount_sun), spent_trx: formatTrx(spent.total), reimbursed_trx: formatTrx(reimbursedSun), reimbursed_inr: Money.ofMinor(reimbursedInr, 'INR'), reason },
  });
  return { closed: true, spentSun: spent.total, reimbursedSun, reimbursedInrMinor: reimbursedInr };
}

// ---- deposits ------------------------------------------------------------------------------------------------

/** The budget wallet: where TRX deposits arrive and top-ups leave from. */
export async function networkBudgetWallet(ex: Executor): Promise<{ id: string; address: string } | null> {
  const w = await ex.selectFrom('treasury_wallet').select(['id', 'address']).where('role', '=', 'NETWORK_BUDGET').where('status', '=', 'ACTIVE').executeTakeFirst();
  return w ?? null;
}

/** The trader a TRX deposit belongs to: the one whose registered wallet sent it and was on file before (the D-17 rule). */
export async function depositSenderTrader(ex: Executor, from: string, at: Date): Promise<string | null> {
  const r = await sql<{ t: string | null }>`select inrp2p_reserve_sender_trader(${normalizeTronAddress(from)}, ${at}::timestamptz)::text as t`.execute(ex);
  return r.rows[0]?.t ?? null;
}

async function creditDeposit(ctx: TxContext, input: { funder: Funder; facts: TrxTransferFacts; note: string }): Promise<{ entryId: string; credited: boolean }> {
  const existing = await ctx.tx.selectFrom('network_budget_entry').select(['id', 'trader_id']).where('kind', '=', 'DEPOSIT').where('tx_hash', '=', input.facts.txid).executeTakeFirst();
  if (existing) {
    if (existing.trader_id !== input.funder) throw new DomainError('NETWORK_DEPOSIT_NOT_YOURS', 'this transaction is already credited to another budget');
    return { entryId: existing.id, credited: false };
  }
  const row = await ctx.tx
    .insertInto('network_budget_entry')
    .values({
      trader_id: input.funder, kind: 'DEPOSIT', amount_sun: input.facts.amountSun, tx_hash: input.facts.txid, from_address: input.facts.from,
      posting_key: `trx_deposit:${input.facts.txid}`, note: input.note.slice(0, 500), created_by: ctx.actor.id ?? `SYSTEM:${ctx.commandName}`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await appendAudit(ctx, {
    action: 'network.deposit_credited', entityType: input.funder ? 'trader_profile' : 'network_budget_entry', entityId: input.funder ?? row.id,
    after: { tx_hash: input.facts.txid, from: input.facts.from, amount_trx: formatTrx(input.facts.amountSun), block: input.facts.blockNumber.toString(), funder: input.funder ?? 'PLATFORM' },
  });
  return { entryId: row.id, credited: true };
}

async function requireBudgetDestination(ctx: TxContext, facts: TrxTransferFacts): Promise<void> {
  const wallet = await networkBudgetWallet(ctx.tx);
  if (!wallet) throw new DomainError('WALLET_NOT_ACTIVE', 'no network budget wallet is active');
  if (normalizeTronAddress(facts.to) !== wallet.address) throw new DomainError('NETWORK_DEPOSIT_NOT_FOUND', `that transaction paid ${facts.to}, not the network budget wallet ${wallet.address}`);
}

/**
 * `network_deposit.claim` — a trader's member hands in the hash of the TRX it sent to the budget wallet. The facts are
 * the chain's (read by the server before the command, final), and attribution is the sender's registered wallet,
 * never the person asking: another trader's transfer is refused and nothing is written. A transfer already credited
 * is never credited again (one entry per transaction).
 */
export function claimNetworkDeposit(actor: ClientActor, facts: TrxTransferFacts) {
  return traderClientCommand(actor, 'VIEW', async (ctx, _p: { txHash: string }, member) => {
    const trader = await ctx.tx.selectFrom('trader_profile').select(['id', 'ref']).where('client_id', '=', member.clientId).executeTakeFirst();
    if (!trader) throw new DomainError('NOT_FOUND', 'this account is not a trader');
    await requireBudgetDestination(ctx, facts);
    const owner = await depositSenderTrader(ctx.tx, facts.from, facts.blockTime);
    if (owner !== trader.id) {
      throw new DomainError('NETWORK_DEPOSIT_NOT_YOURS', 'that TRX was not sent from your registered wallet; send it from the wallet on file, or ask the desk');
    }
    await lockTrader(ctx, trader.id);
    const out = await creditDeposit(ctx, { funder: trader.id, facts, note: `claimed by ${trader.ref}` });
    if (out.credited) await enqueueOutbox(ctx, { type: 'trader.network_deposit_credited', aggregateType: 'trader_profile', aggregateId: trader.id, payload: { traderId: trader.id, txHash: facts.txid } });
    return { credited: out.credited, amount: formatTrx(facts.amountSun) };
  });
}

/**
 * `network_deposit.record` — `network:manage` (⧗). The desk records a TRX transfer into the budget wallet: a trader's
 * deposit (its registered wallet sent it — the same rule as a claim), or the platform's own top-up, said explicitly.
 */
export function recordNetworkDeposit(actor: OperatorActor, facts: TrxTransferFacts) {
  return operatorCommand(actor, 'network:manage', async (ctx, p: { txHash: string; platform?: boolean; note?: string }) => {
    await requireBudgetDestination(ctx, facts);
    const owner = await depositSenderTrader(ctx.tx, facts.from, facts.blockTime);
    if (p.platform) {
      if (owner) throw new DomainError('INVALID_ARGUMENT', 'this TRX came from a trader’s registered wallet: it is that trader’s deposit, not the platform’s');
    } else if (!owner) {
      throw new DomainError('NETWORK_DEPOSIT_NOT_YOURS', 'no trader registered the sending wallet; record it as the platform’s own top-up if it is');
    }
    if (owner) await lockTrader(ctx, owner);
    const out = await creditDeposit(ctx, { funder: p.platform ? null : owner, facts, note: requireText(p.note ?? (p.platform ? 'platform top-up' : 'recorded by the desk'), 'note', 500) });
    return { credited: out.credited, funder: p.platform ? 'PLATFORM' : owner, amount: formatTrx(facts.amountSun) };
  });
}

/** The entry an operator writes to correct a budget, with the reason. Never touches a trade's spend. */
export function adjustNetworkBudget(actor: OperatorActor) {
  return operatorCommand(actor, 'network:manage', async (ctx, p: { traderId?: string | null; amount: string; negative?: boolean; reason: string; key: string }) => {
    const funder = p.traderId ? requireUuid(p.traderId, 'traderId') : null;
    const magnitude = parseTrx(p.amount);
    if (magnitude === 0n) throw new DomainError('INVALID_AMOUNT', 'an adjustment moves something');
    const reason = requireText(p.reason, 'reason', 500);
    if (!/^[0-9a-z-]{8,64}$/.test(p.key)) throw new DomainError('INVALID_ARGUMENT', 'key: 8–64 lowercase letters, digits or dashes');
    await lockFunder(ctx, funder);
    const amount = p.negative ? -magnitude : magnitude;
    if (amount < 0n && (await networkAvailable(ctx.tx, funder)) + amount < 0n) throw short(funder, await networkAvailable(ctx.tx, funder), magnitude);
    await ctx.tx.insertInto('network_budget_entry').values({ trader_id: funder, kind: 'ADJUSTMENT', amount_sun: amount, posting_key: `adjustment:${p.key}`, note: reason, created_by: ctx.actor.id ?? 'SYSTEM' }).execute();
    await appendAudit(ctx, { action: 'network.budget_adjusted', entityType: 'network_budget_entry', entityId: null, after: { funder: funder ?? 'PLATFORM', amount_trx: formatTrx(amount), reason } });
    return { adjusted: formatTrx(amount) };
  });
}

// ---- withdrawals -----------------------------------------------------------------------------------------------

/**
 * `network_withdrawal.request` — a trader member who can commit asks for TRX of its deposit back, to its registered
 * wallet, up to what is free after its open trades and the withdrawal's own transfer fee.
 */
export function requestNetworkWithdrawal(actor: ClientActor) {
  return traderClientCommand(actor, 'COMMIT', async (ctx, p: { amount: string }, member) => {
    const traderRow = await ctx.tx.selectFrom('trader_profile').select('id').where('client_id', '=', member.clientId).executeTakeFirst();
    if (!traderRow) throw new DomainError('NOT_FOUND', 'this account is not a trader');
    const trader = await lockTrader(ctx, traderRow.id);
    const amount = parseTrx(p.amount);
    if (amount <= 0n) throw new DomainError('INVALID_AMOUNT', 'a withdrawal must be positive');
    const open = await ctx.tx.selectFrom('network_deposit_withdrawal').select('ref').where('trader_id', '=', trader.id).where('status', 'in', ['REQUESTED', 'APPROVED']).executeTakeFirst();
    if (open) throw new DomainError('NETWORK_WITHDRAWAL_OPEN', `withdrawal ${open.ref} is still open`);
    const wallet = await ctx.tx.selectFrom('crypto_wallet').select(['address', 'status']).where('id', '=', trader.wallet_id).executeTakeFirstOrThrow();
    if (wallet.status !== 'ACTIVE') throw new DomainError('TRADER_DESTINATION_UNVERIFIED', 'your registered wallet is not verified yet');
    const snapshot = await ctx.tx.selectFrom('network_fee_snapshot').select(['bandwidth_price_sun']).orderBy('observed_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
    const fee = (snapshot?.bandwidth_price_sun ?? 1000n) * 300n;
    await lockFunder(ctx, trader.id);
    const available = await networkAvailable(ctx.tx, trader.id);
    if (amount + fee > available) {
      throw new DomainError('NETWORK_WITHDRAWAL_EXCEEDS_AVAILABLE', `at most ${formatTrx(available > fee ? available - fee : 0n)} TRX can be withdrawn now (the rest is held for your open orders or pays this transfer)`, {
        available: formatTrx(available > fee ? available - fee : 0n),
      });
    }
    const row = await ctx.tx
      .insertInto('network_deposit_withdrawal')
      .values({ trader_id: trader.id, amount_sun: amount, fee_estimate_sun: fee, to_address: wallet.address, requested_by: member.userId })
      .returning(['id', 'ref'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, { action: 'network.withdrawal_requested', entityType: 'trader_profile', entityId: trader.id, after: { ref: row.ref, amount_trx: formatTrx(amount), to: wallet.address } });
    await enqueueOutbox(ctx, { type: 'desk.network_withdrawal_requested', aggregateType: 'trader_profile', aggregateId: trader.id, payload: { traderId: trader.id, withdrawalId: row.id } });
    return { withdrawalId: row.id, ref: row.ref };
  });
}

export function cancelNetworkWithdrawal(actor: ClientActor) {
  return traderClientCommand(actor, 'COMMIT', async (ctx, p: { withdrawalId: string }, member) => {
    const w = await ctx.tx
      .selectFrom('network_deposit_withdrawal as w')
      .innerJoin('trader_profile as t', 't.id', 'w.trader_id')
      .select(['w.id', 'w.ref', 'w.status', 'w.trader_id'])
      .where('w.id', '=', requireUuid(p.withdrawalId, 'withdrawalId'))
      .where('t.client_id', '=', member.clientId)
      .executeTakeFirst();
    if (!w) throw new DomainError('NOT_FOUND', 'withdrawal not found');
    if (w.status !== 'REQUESTED') throw new DomainError('INVALID_TRANSITION', `withdrawal ${w.ref} is ${w.status.toLowerCase()}`);
    await ctx.tx.updateTable('network_deposit_withdrawal').set({ status: 'CANCELLED', closed_at: sql<Date>`inrp2p_now()`, close_reason: 'cancelled by the trader' }).where('id', '=', w.id).execute();
    await appendAudit(ctx, { action: 'network.withdrawal_cancelled', entityType: 'trader_profile', entityId: w.trader_id, after: { ref: w.ref } });
    return { status: 'CANCELLED' as const };
  });
}

export async function openWithdrawals(ex: Executor) {
  return ex
    .selectFrom('network_deposit_withdrawal as w')
    .innerJoin('trader_profile as t', 't.id', 'w.trader_id')
    .select(['w.id', 'w.ref', 'w.trader_id', 't.ref as trader_ref', 'w.amount_sun', 'w.fee_estimate_sun', 'w.to_address', 'w.status', 'w.requested_at'])
    .where('w.status', 'in', ['REQUESTED', 'APPROVED'])
    .orderBy('w.requested_at')
    .execute();
}
