import { sql } from 'kysely';
import { DomainError, Money, formatTrx, isDomainError } from '@inrp2p/kernel';
import { type UnsignedTronTx, buildTrc20Transfer, buildTrxTransfer, signedTransactionHex } from '@inrp2p/adapters';
import { type Db, type TxContext, pgErrorCode } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { assertPayoutsOpen, lockTrade, payoutsHeld } from '@inrp2p/trades';
import { assertPhysicallyAvailable, openExceptionInTx } from '@inrp2p/settlement';
import { latestFeeSnapshot, lockFunder, lockSend, networkBudgetWallet, networkFeePolicy, planChainSend, sendNetworkUsed, topupFor } from '@inrp2p/network';
import { observeBalances } from '@inrp2p/scanner';
import { type OnchainDeps, policyOf, settlementDepsOf, step } from './deps.ts';

/**
 * The signer's planning and signing half (ADR 0017 §4). For every send that is due it decides, from what the chain says
 * now, whether the paying address first needs TRX (a top-up from the budget wallet, itself a send) or can be signed,
 * and signs it. The signed transaction and its txid are committed **before** anything is broadcast: a crash, a timeout
 * or a second worker afterwards can only ever broadcast those same bytes again (`monitor.ts`), never make a second
 * transfer. Nothing is signed — USDT or TRX — while the signer's switch is off or while outgoing payments are held after
 * the database changed underneath (FI-54), nothing for a trade on hold, and no send is fuelled past its fixed TRX cap.
 */
export interface SenderReport {
  readonly signed: number;
  readonly broadcast: number;
  readonly topupsPlanned: number;
  readonly blocked: number;
  readonly resumed: number;
  readonly waiting: number;
  readonly failures: readonly { readonly sendRef: string; readonly code: string; readonly message: string }[];
}

type SendRow = Awaited<ReturnType<typeof lockSend>>;

export async function runSender(db: Db, deps: OnchainDeps): Promise<SenderReport> {
  const policy = policyOf(deps);
  const report = { signed: 0, broadcast: 0, topupsPlanned: 0, blocked: 0, resumed: 0, waiting: 0, failures: [] as { sendRef: string; code: string; message: string }[] };

  // A send waiting for its top-up goes on once the top-up is final (or was cancelled: it is decided again).
  const fueled = await sql<{ id: string }>`
    select p.id from chain_send p
     where p.status = 'AWAITING_RESOURCES'
       and not exists (select 1 from chain_send t where t.parent_send_id = p.id and t.purpose = 'TOPUP' and t.status not in ('CONFIRMED', 'CANCELLED'))
     order by p.created_at limit ${policy.batch}`.execute(db);
  for (const r of fueled.rows) {
    await step(db, 'chain_send.resume', { sendId: r.id }, async (ctx) => {
      const send = await lockSend(ctx, r.id);
      if (send.status !== 'AWAITING_RESOURCES') return;
      await ctx.tx.updateTable('chain_send').set({ status: 'PLANNED', updated_at: sql<Date>`inrp2p_now()` }).where('id', '=', send.id).execute();
    });
    report.resumed += 1;
  }
  // A send blocked for want of TRX is tried again a while later; one blocked after failing on chain waits for a person.
  const retry = await sql<{ id: string }>`
    select id from chain_send
     where status = 'BLOCKED' and failed_attempts < ${policy.maxFailedAttempts} and updated_at <= inrp2p_now() - make_interval(secs => ${policy.blockedRetrySeconds})
     order by updated_at limit ${policy.batch}`.execute(db);
  for (const r of retry.rows) {
    await step(db, 'chain_send.retry_blocked', { sendId: r.id }, async (ctx) => {
      const send = await lockSend(ctx, r.id);
      if (send.status !== 'BLOCKED') return;
      await ctx.tx.updateTable('chain_send').set({ status: 'PLANNED', blocked_reason: null, updated_at: sql<Date>`inrp2p_now()` }).where('id', '=', send.id).execute();
    });
    report.resumed += 1;
  }

  const fees = await networkFeePolicy(db);
  // After a restore nothing is fuelled, signed or broadcast — a TRX top-up or withdrawal no more than USDT — until a
  // person has reconciled what already left and a second one lifted the fence (FI-54). Planned sends simply wait.
  if ((await payoutsHeld(db)).held) {
    const waiting = await sql<{ n: string }>`select count(*)::text as n from chain_send where status = 'PLANNED'`.execute(db);
    report.waiting += Number.parseInt(waiting.rows[0]!.n, 10);
    return report;
  }
  // Top-ups and withdrawals first: they are what the USDT transfers wait for.
  const due = await sql<{ id: string }>`
    select id from chain_send where status = 'PLANNED' order by (asset = 'TRX') desc, created_at, id limit ${policy.batch}`.execute(db);
  for (const r of due.rows) {
    const send = await db.selectFrom('chain_send').selectAll().where('id', '=', r.id).executeTakeFirstOrThrow();
    if (send.status !== 'PLANNED') continue;
    if (!fees.autoSendEnabled || !deps.signer) {
      report.waiting += 1;
      continue;
    }
    try {
      const out = send.asset === 'TRX' ? await prepareTrx(db, deps, send) : await prepareUsdt(db, deps, send);
      if (out.kind === 'SIGNED') {
        report.signed += 1;
        if (await broadcastAttempt(db, deps, out.attemptId)) report.broadcast += 1;
      } else if (out.kind === 'TOPUP') report.topupsPlanned += 1;
      else if (out.kind === 'BLOCKED') report.blocked += 1;
      else report.waiting += 1;
    } catch (e) {
      const code = isDomainError(e) ? e.code : (pgErrorCode(e) ?? 'UNEXPECTED');
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      report.failures.push({ sendRef: send.ref, code, message });
      await step(db, 'chain_send.note_error', { sendId: send.id }, async (ctx) => {
        await ctx.tx.updateTable('chain_send').set({ last_error: `${code}: ${message}`.slice(0, 500), last_error_at: sql<Date>`inrp2p_now()` }).where('id', '=', send.id).execute();
      }).catch(() => undefined);
    }
  }
  return report;
}

type Prepared = { kind: 'SIGNED'; attemptId: string } | { kind: 'TOPUP' } | { kind: 'BLOCKED' } | { kind: 'WAIT' };

/** A USDT transfer: top the address up first if the chain shows it short of TRX, else sign. */
async function prepareUsdt(db: Db, deps: OnchainDeps, send: SendRow): Promise<Prepared> {
  const fees = await networkFeePolicy(db);
  const snapshot = await latestFeeSnapshot(db);
  if (!snapshot) throw new DomainError('NETWORK_FEES_UNKNOWN', 'the chain\'s fees have never been read');
  // A fresh reading of the USDT there (B2), before anything is decided from it.
  await observeBalances(db, { sources: deps.chain.balanceSources(), contract: deps.chain.tokenContract }, { addresses: [send.from_address] });
  const account = await deps.network.accountState(send.from_address);
  const estimate = await deps.network.estimateTrc20Energy({ from: send.from_address, contract: deps.chain.tokenContract, to: send.to_address, amountMinor: send.amount_minor });
  // A simulation that cannot run (a provider that does not simulate for an address it has never seen) falls back to the
  // worst case the trade holds for: never less than it needs.
  const energy = estimate.ok ? estimate.energy : BigInt(fees.reserveEnergy);
  const need = topupFor({ energy, energyPriceSun: snapshot.energyPriceSun, balanceSun: account.balanceSun, policy: fees });

  if (need.topupSun > 0n) {
    const budget = await networkBudgetWallet(db);
    if (!budget) throw new DomainError('WALLET_NOT_ACTIVE', 'no network budget wallet is active');
    const topupFee = (account.exists ? 0n : snapshot.createNewAccountFeeSun + snapshot.createAccountFeeSun) + BigInt(fees.topupBytes) * snapshot.bandwidthPriceSun;
    return step(db, 'chain_send.plan_topup', { sendId: send.id }, async (ctx) => {
      const current = await lockSend(ctx, send.id);
      if (current.status !== 'PLANNED') return { kind: 'WAIT' as const };
      await lockFunder(ctx, current.funder_trader_id);
      // The send's fixed cap, less what its earlier top-ups already drew (retries included): never the funder's other
      // TRX. Gas that rose or attempts that burned it stop here, blocked, until a person raises the cap.
      const used = await sendNetworkUsed(ctx.tx, current.id);
      const cap = current.network_cap_sun!;
      const wanted = need.topupSun + topupFee;
      if (used + wanted > cap) {
        await block(ctx, current, `this transfer may draw ${formatTrx(cap)} TRX in all; ${formatTrx(used)} TRX is drawn and ${formatTrx(wanted)} TRX more is needed now — a person may raise its cap`, 'NETWORK_BUDGET_SHORT');
        return { kind: 'BLOCKED' as const };
      }
      await planChainSend(ctx, {
        purpose: 'TOPUP', asset: 'TRX', tradeId: current.trade_id, parentSendId: current.id, fromAddress: budget.address, toAddress: current.from_address,
        amountMinor: need.topupSun, feeEstimateSun: topupFee, funder: current.funder_trader_id, bearer: current.bearer, needsApproval: false, requestedBy: `SYSTEM:${ctx.commandName}`,
      });
      await ctx.tx.updateTable('chain_send').set({ status: 'AWAITING_RESOURCES', updated_at: sql<Date>`inrp2p_now()` }).where('id', '=', current.id).execute();
      await appendAudit(ctx, { action: 'chain_send.awaiting_topup', entityType: 'chain_send', entityId: current.id, after: { topup_trx: formatTrx(need.topupSun), fee_trx: formatTrx(topupFee), energy: energy.toString(), at_address_trx: formatTrx(account.balanceSun) } });
      return { kind: 'TOPUP' as const };
    });
  }

  const ref = await deps.network.referenceBlock();
  const policy = policyOf(deps);
  const tx = buildTrc20Transfer({
    from: send.from_address, contract: deps.chain.tokenContract, to: send.to_address, amountMinor: send.amount_minor, feeLimitSun: need.feeLimitSun,
    ref, timestamp: ref.timestamp, expiration: ref.timestamp + policy.validitySeconds * 1000,
  });
  return sign(db, deps, send, tx);
}

/** A TRX transfer from the budget wallet: signed only when the chain shows the wallet holding it beyond what is leaving. */
async function prepareTrx(db: Db, deps: OnchainDeps, send: SendRow): Promise<Prepared> {
  const account = await deps.network.accountState(send.from_address);
  const leaving = await sql<{ total: string }>`
    select coalesce(sum(s.amount_minor + s.fee_estimate_sun), 0)::text as total
      from chain_send s join chain_send_attempt a on a.send_id = s.id and a.status in ('SIGNED', 'BROADCAST')
     where s.asset = 'TRX' and s.from_address = ${send.from_address} and s.id <> ${send.id}`.execute(db);
  const required = send.amount_minor + send.fee_estimate_sun + BigInt(leaving.rows[0]!.total);
  if (account.balanceSun < required) {
    return step(db, 'chain_send.block', { sendId: send.id }, async (ctx) => {
      const current = await lockSend(ctx, send.id);
      if (current.status !== 'PLANNED') return { kind: 'WAIT' as const };
      // The budget's records say the TRX is there; the chain says it is not. That is a reconciliation for a person.
      await block(ctx, current, `the budget wallet holds ${formatTrx(account.balanceSun)} TRX on chain; ${formatTrx(required)} TRX is needed with what is already leaving`, 'NETWORK_BUDGET_SHORT');
      return { kind: 'BLOCKED' as const };
    });
  }
  const ref = await deps.network.referenceBlock();
  const policy = policyOf(deps);
  const tx = buildTrxTransfer({ from: send.from_address, to: send.to_address, amountSun: send.amount_minor, ref, timestamp: ref.timestamp, expiration: ref.timestamp + policy.validitySeconds * 1000 });
  return sign(db, deps, send, tx);
}

async function block(ctx: TxContext, send: SendRow, reason: string, caseType: 'NETWORK_BUDGET_SHORT'): Promise<void> {
  await ctx.tx.updateTable('chain_send').set({ status: 'BLOCKED', blocked_reason: reason.slice(0, 500), updated_at: sql<Date>`inrp2p_now()` }).where('id', '=', send.id).execute();
  await appendAudit(ctx, { action: 'chain_send.blocked', entityType: 'chain_send', entityId: send.id, before: { status: send.status }, after: { status: 'BLOCKED', reason } });
  await openExceptionInTx(ctx, { type: caseType, subjectType: 'CHAIN_SEND', subjectId: send.id, tradeId: send.trade_id, details: { ref: send.ref, reason } });
}

/**
 * Signs and commits the attempt — the one moment a transfer becomes possible. Everything that must hold for the money
 * to leave is checked again here, under the locks, after the signature exists and before it is kept: if any check
 * fails, the transaction rolls back and the signature is simply never seen by anyone.
 */
async function sign(db: Db, deps: OnchainDeps, send: SendRow, tx: UnsignedTronTx): Promise<Prepared> {
  const signature = deps.signer!.sign(send.from_path, tx);
  return step(db, 'chain_send.sign', { sendId: send.id, txid: tx.txid }, async (ctx) => {
    if (send.asset === 'USDT') {
      const trade = await lockTrade(ctx.tx, send.trade_id!);
      if (trade.hold) throw new DomainError('TRADE_ON_HOLD', 'the trade has an open blocking exception');
      if (send.settlement_leg_id) {
        const leg = await ctx.tx.selectFrom('settlement_leg').select(['status']).where('id', '=', send.settlement_leg_id).executeTakeFirstOrThrow();
        if (leg.status !== 'PROCESSING') throw new DomainError('INVALID_TRANSITION', `its leg is ${leg.status}`);
      }
      await assertPhysicallyAvailable(ctx, settlementDepsOf(deps), {
        address: send.from_address, amount: Money.ofMinor(send.amount_minor, 'USDT'), excludeLegId: send.settlement_leg_id, excludeSendId: send.id,
      });
    } else if (send.purpose === 'DEPOSIT_WITHDRAWAL') {
      const w = await ctx.tx.selectFrom('network_deposit_withdrawal').select('status').where('id', '=', send.withdrawal_id!).executeTakeFirstOrThrow();
      if (w.status !== 'APPROVED') throw new DomainError('INVALID_TRANSITION', `the withdrawal is ${w.status}`);
    }
    // Every transfer, TRX as well as USDT (the database refuses the attempt too, IX100).
    await assertPayoutsOpen(ctx.tx);
    const current = await lockSend(ctx, send.id);
    if (current.status !== 'PLANNED') return { kind: 'WAIT' as const };
    const seq = await ctx.tx.selectFrom('chain_send_attempt').select(({ fn }) => fn.countAll<string>().as('n')).where('send_id', '=', send.id).executeTakeFirstOrThrow();
    await ctx.tx.updateTable('chain_send').set({ status: 'SENDING', last_error: null, updated_at: sql<Date>`inrp2p_now()` }).where('id', '=', send.id).execute();
    const attempt = await ctx.tx
      .insertInto('chain_send_attempt')
      .values({
        send_id: send.id, seq: Number.parseInt(seq.n, 10) + 1, txid: tx.txid, raw_data_hex: tx.rawDataHex, signature_hex: signature,
        ref_block_num: tx.refBlockNum, expiration: new Date(tx.expiration), fee_limit_sun: tx.feeLimitSun,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, { action: 'chain_send.signed', entityType: 'chain_send', entityId: send.id, after: { txid: tx.txid, expiration: new Date(tx.expiration).toISOString(), fee_limit_trx: tx.feeLimitSun === null ? null : formatTrx(tx.feeLimitSun) } });
    return { kind: 'SIGNED' as const, attemptId: attempt.id };
  });
}

/**
 * Sends the attempt's stored bytes to every provider and records what they said. Never decides anything: an attempt is
 * dead only once the chain proves it (`monitor.ts`). Returns whether any provider took it. Held, like signing, while
 * outgoing payments are held after a restore: a transaction signed before the change waits for the reconciliation.
 */
export async function broadcastAttempt(db: Db, deps: OnchainDeps, attemptId: string): Promise<boolean> {
  const a = await db.selectFrom('chain_send_attempt').select(['id', 'raw_data_hex', 'signature_hex', 'status']).where('id', '=', attemptId).executeTakeFirstOrThrow();
  if (a.status !== 'SIGNED' && a.status !== 'BROADCAST') return false;
  if ((await payoutsHeld(db)).held) return false;
  const result = await deps.network.broadcast(signedTransactionHex(a.raw_data_hex, a.signature_hex));
  const summary = [
    result.accepted.length ? `accepted by ${result.accepted.join(', ')}` : null,
    ...result.rejected.map((r) => `${r.by}: ${r.code}${r.message ? ` ${r.message}` : ''}`),
    ...result.unreachable,
  ].filter(Boolean).join('; ').slice(0, 500) || 'no answer';
  await step(db, 'chain_send.broadcast', { attemptId }, async (ctx) => {
    const current = await ctx.tx.selectFrom('chain_send_attempt').select(['status', 'broadcasts']).where('id', '=', attemptId).forUpdate().executeTakeFirstOrThrow();
    if (current.status !== 'SIGNED' && current.status !== 'BROADCAST') return;
    await ctx.tx
      .updateTable('chain_send_attempt')
      .set({
        status: result.accepted.length > 0 ? 'BROADCAST' : current.status,
        broadcasts: current.broadcasts + 1, last_broadcast_at: sql<Date>`inrp2p_now()`, last_broadcast_result: summary,
      })
      .where('id', '=', attemptId)
      .execute();
  });
  return result.accepted.length > 0;
}
