import { sql } from 'kysely';
import { DomainError, Money, isDomainError, requireUuid } from '@inrp2p/kernel';
import { GASFREE_PERMIT_VERSION, type GasFreePermit, abiAddressWord, gasFreeAddressOf } from '@inrp2p/adapters';
import { type Db, type TxContext, pgErrorCode } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type OperatorActor, operatorCommand } from '@inrp2p/identity';
import { assertPayoutsOpen, lockTrade, payoutsHeld } from '@inrp2p/trades';
import { assertPhysicallyAvailable, openExceptionInTx, settleGasFreeNetworkInTx, settleSignedSendInTx } from '@inrp2p/settlement';
import { lockSend, recordGasFreeFees } from '@inrp2p/network';
import { type OnchainDeps, clockOf, policyOf, settlementDepsOf, step } from './deps.ts';

/**
 * Sends out of GasFree accounts (docs/adr/0022-usdt-network-fees.md §2.4). A permit is signed and committed with
 * everything that must hold for the money to leave — exactly like a TRON transaction (`sender.ts`) — and only then given
 * to GasFree; a retry gives the same permit. It is followed to the transaction GasFree names, which settles like any
 * transfer, from the chain. Another permit is signed for the send only once the first is provably dead: its deadline
 * behind every provider's solidified head and its nonce never used on chain.
 */

type SendRow = Awaited<ReturnType<typeof lockSend>>;
export type PermitPrepared = { kind: 'SIGNED'; permitId: string } | { kind: 'BLOCKED' } | { kind: 'WAIT' };

const owner = async (db: Db | TxContext['tx'], address: string): Promise<string> =>
  (await db.selectFrom('deposit_address').select('owner_address').where('network', '=', 'TRON').where('address', '=', address).executeTakeFirstOrThrow()).owner_address!;

/** What the controller charges now, from the chain itself: one transfer, and the activation of an account's first. */
export async function controllerFees(deps: OnchainDeps): Promise<{ transferFeeMinor: bigint; activateFeeMinor: bigint }> {
  const chain = deps.gasFree!.chain;
  const [transferFeeMinor, activateFeeMinor] = await Promise.all([
    deps.network.solidifiedView(chain.controller, 'tokenFees(address)', abiAddressWord(chain.usdt)),
    deps.network.solidifiedView(chain.controller, 'activateFees(address)', abiAddressWord(chain.usdt)),
  ]);
  return { transferFeeMinor, activateFeeMinor };
}

/** `gasfree_fee_refresh` — the controller's USDT fees, read on chain and recorded for quotes (ADR 0022 §2.2). */
export async function runGasFreeFeeRefresh(db: Db, deps: OnchainDeps): Promise<{ recorded: boolean; transferFee: string | null; activateFee: string | null }> {
  if (!deps.gasFree) return { recorded: false, transferFee: null, activateFee: null };
  const fees = await controllerFees(deps);
  const chain = deps.gasFree.chain;
  await step(db, 'network.gasfree_fees_observed', {}, (ctx) => recordGasFreeFees(ctx, { controller: chain.controller, token: chain.usdt, ...fees }));
  return { recorded: true, transferFee: Money.ofMinor(fees.transferFeeMinor, 'USDT').toDecimalString(), activateFee: Money.ofMinor(fees.activateFeeMinor, 'USDT').toDecimalString() };
}

async function block(ctx: TxContext, send: SendRow, reason: string): Promise<void> {
  await ctx.tx.updateTable('chain_send').set({ status: 'BLOCKED', blocked_reason: reason.slice(0, 500), updated_at: sql<Date>`inrp2p_now()` }).where('id', '=', send.id).execute();
  await appendAudit(ctx, { action: 'chain_send.blocked', entityType: 'chain_send', entityId: send.id, before: { status: send.status }, after: { status: 'BLOCKED', reason } });
  await openExceptionInTx(ctx, { type: 'NETWORK_BUDGET_SHORT', subjectType: 'CHAIN_SEND', subjectId: send.id, tradeId: send.trade_id, details: { ref: send.ref, reason } });
}

/**
 * A planned send out of a GasFree account: signed and committed when GasFree takes permits for its owner now and the
 * controller's fee fits the send's cap; blocked for a person when the fee rose past it; left waiting otherwise (GasFree not
 * configured, or a permit of the same owner still pending).
 */
export async function prepareGasFree(db: Db, deps: OnchainDeps, send: SendRow): Promise<PermitPrepared> {
  if (!deps.gasFree || !deps.signer) return { kind: 'WAIT' };
  const policy = policyOf(deps);
  const chain = deps.gasFree.chain;
  const user = await owner(db, send.from_address);
  if (gasFreeAddressOf(user, chain) !== send.from_address) throw new DomainError('GASFREE_MISMATCH', `${send.from_address} is not the GasFree account of ${user} on ${chain.name}`);
  const account = await deps.gasFree.account(user as GasFreePermit['user']);
  if (!account.allowSubmit) return { kind: 'WAIT' };
  const fees = await controllerFees(deps);
  const needed = fees.transferFeeMinor + (account.active ? 0n : fees.activateFeeMinor);
  if (needed > send.fee_cap_usdt_minor!) {
    return step(db, 'chain_send.block', { sendId: send.id }, async (ctx) => {
      const current = await lockSend(ctx, send.id);
      if (current.status !== 'PLANNED') return { kind: 'WAIT' as const };
      await block(ctx, current, `GasFree now charges ${Money.ofMinor(needed, 'USDT').toDecimalString()} USDT for this transfer; its cap is ${Money.ofMinor(send.fee_cap_usdt_minor!, 'USDT').toDecimalString()} USDT — a person may raise it`);
      return { kind: 'BLOCKED' as const };
    });
  }
  const onChainNonce = await deps.network.solidifiedView(chain.controller, 'nonces(address)', abiAddressWord(user));
  if (account.nonce < onChainNonce) return { kind: 'WAIT' };
  // The deadline, in whole seconds of the clock the chain is read by: GasFree refuses one past its window (60–600 s).
  const now = clockOf(deps);
  const deadlineMs = now - (now % 1000) + policy.permitValiditySeconds * 1000;
  const permit: GasFreePermit = {
    token: chain.usdt, serviceProvider: await deps.gasFree.serviceProvider(), user: user as GasFreePermit['user'], receiver: send.to_address as GasFreePermit['receiver'],
    value: send.amount_minor, maxFee: send.fee_cap_usdt_minor!, deadline: BigInt(deadlineMs / 1000),
    version: GASFREE_PERMIT_VERSION, nonce: account.nonce,
  };
  const signed = deps.signer.signPermit(send.from_path, permit, chain);
  return step(db, 'gasfree_permit.sign', { sendId: send.id, digest: signed.digest }, async (ctx) => {
    // Everything that must hold for the money to leave, again, under the locks — as for a TRON transaction (`sender.ts`).
    const trade = await lockTrade(ctx.tx, send.trade_id!);
    if (trade.hold) throw new DomainError('TRADE_ON_HOLD', 'the trade has an open blocking exception');
    if (send.settlement_leg_id) {
      const leg = await ctx.tx.selectFrom('settlement_leg').select(['status']).where('id', '=', send.settlement_leg_id).executeTakeFirstOrThrow();
      if (leg.status !== 'PROCESSING') throw new DomainError('INVALID_TRANSITION', `its leg is ${leg.status}`);
    }
    await assertPhysicallyAvailable(ctx, settlementDepsOf(deps), {
      address: send.from_address, amount: Money.ofMinor(send.amount_minor + send.fee_cap_usdt_minor!, 'USDT'), excludeLegId: send.settlement_leg_id, excludeSendId: send.id,
    });
    await assertPayoutsOpen(ctx.tx);
    const current = await lockSend(ctx, send.id);
    if (current.status !== 'PLANNED') return { kind: 'WAIT' as const };
    const seq = await ctx.tx.selectFrom('gasfree_permit').select(({ fn }) => fn.countAll<string>().as('n')).where('send_id', '=', send.id).executeTakeFirstOrThrow();
    await ctx.tx.updateTable('chain_send').set({ status: 'SENDING', last_error: null, updated_at: sql<Date>`inrp2p_now()` }).where('id', '=', send.id).execute();
    const row = await ctx.tx
      .insertInto('gasfree_permit')
      .values({
        send_id: send.id, seq: Number.parseInt(seq.n, 10) + 1, owner_address: user, gasfree_address: send.from_address, token: permit.token, service_provider: permit.serviceProvider,
        receiver: permit.receiver, value_minor: permit.value, max_fee_minor: permit.maxFee, nonce: permit.nonce, deadline: new Date(deadlineMs),
        digest_hex: signed.digest, signature_hex: signed.signature,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, {
      action: 'gasfree_permit.signed', entityType: 'chain_send', entityId: send.id,
      after: { nonce: permit.nonce.toString(), deadline: new Date(deadlineMs).toISOString(), max_fee: Money.ofMinor(permit.maxFee, 'USDT'), digest: signed.digest },
    });
    return { kind: 'SIGNED' as const, permitId: row.id };
  });
}

/** Gives a signed permit to GasFree — the same permit every time — and records what it said. Never decides anything. */
export async function submitPermit(db: Db, deps: OnchainDeps, permitId: string): Promise<boolean> {
  if (!deps.gasFree || (await payoutsHeld(db)).held) return false;
  const p = await db.selectFrom('gasfree_permit').selectAll().where('id', '=', permitId).executeTakeFirstOrThrow();
  if (p.status !== 'SIGNED') return false;
  const permit: GasFreePermit = {
    token: p.token as GasFreePermit['token'], serviceProvider: p.service_provider as GasFreePermit['serviceProvider'], user: p.owner_address as GasFreePermit['user'],
    receiver: p.receiver as GasFreePermit['receiver'], value: p.value_minor, maxFee: p.max_fee_minor, deadline: BigInt((p.deadline.getTime() - (p.deadline.getTime() % 1000)) / 1000),
    version: GASFREE_PERMIT_VERSION, nonce: p.nonce,
  };
  let answer: string;
  let trace: { id: string; txid: string | null } | null = null;
  try {
    const out = await deps.gasFree.submit(permit, p.signature_hex, p.id);
    if ('refused' in out) answer = `refused: ${out.reason} ${out.message}`.trim();
    else {
      trace = out;
      answer = `taken: ${out.state}`;
    }
  } catch (e) {
    answer = `no answer: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;
  }
  await step(db, 'gasfree_permit.submitted', { permitId }, async (ctx) => {
    const current = await ctx.tx.selectFrom('gasfree_permit').select(['status']).where('id', '=', permitId).forUpdate().executeTakeFirstOrThrow();
    if (current.status !== 'SIGNED') return;
    await ctx.tx
      .updateTable('gasfree_permit')
      .set({ last_answer: answer.slice(0, 500), ...(trace ? { status: 'SUBMITTED' as const, trace_id: trace.id, submitted_at: sql<Date>`inrp2p_now()`, ...(trace.txid ? { txid: trace.txid } : {}) } : {}) })
      .where('id', '=', permitId)
      .execute();
  });
  return trace !== null;
}

/** The permit's transaction is final and successful: its network, what the send paid, and the send itself — one step. */
async function confirmPermitInTx(ctx: TxContext, deps: OnchainDeps, permitId: string, txid: string, decidedBy: string): Promise<void> {
  const p = await ctx.tx.selectFrom('gasfree_permit').select(['send_id']).where('id', '=', permitId).executeTakeFirstOrThrow();
  const send = await ctx.tx.selectFrom('chain_send').selectAll().where('id', '=', p.send_id).executeTakeFirstOrThrow();
  if (send.trade_id) await lockTrade(ctx.tx, send.trade_id);
  const network = await settleGasFreeNetworkInTx(ctx, settlementDepsOf(deps), { permitId, txid, decidedBy });
  await settleSignedSendInTx(ctx, settlementDepsOf(deps), send.id);
  const s = await lockSend(ctx, send.id);
  await ctx.tx.updateTable('chain_send').set({ status: 'CONFIRMED', closed_at: sql<Date>`inrp2p_now()`, updated_at: sql<Date>`inrp2p_now()` }).where('id', '=', s.id).execute();
  await appendAudit(ctx, {
    action: 'chain_send.confirmed', entityType: 'chain_send', entityId: send.id,
    after: { txid, network: Money.ofMinor(network.feeMinor, 'USDT'), via: 'GasFree', purpose: send.purpose },
  });
  await enqueueOutbox(ctx, { type: 'chain_send.confirmed', aggregateType: 'chain_send', aggregateId: send.id, payload: { sendId: send.id, tradeId: send.trade_id, purpose: send.purpose } });
}

export interface PermitReport {
  readonly examined: number;
  readonly submitted: number;
  readonly confirmed: number;
  readonly expired: number;
  readonly pending: number;
  readonly unresolved: number;
  readonly failures: readonly { readonly permitId: string; readonly code: string; readonly message: string }[];
}

/**
 * Follows every live permit until the chain decides it: a lost or refused submission is given again (the same permit)
 * while it may still execute; the transaction GasFree names is confirmed from the chain; a permit is EXPIRED only by
 * proof; one whose nonce was used without a transaction anyone can name opens a case for a person.
 */
export async function runPermits(db: Db, deps: OnchainDeps): Promise<PermitReport> {
  const policy = policyOf(deps);
  const report = { examined: 0, submitted: 0, confirmed: 0, expired: 0, pending: 0, unresolved: 0, failures: [] as { permitId: string; code: string; message: string }[] };
  if (!deps.gasFree) return report;
  const live = await sql<{ id: string; status: string; trace_id: string | null; txid: string | null; deadline: Date; nonce: bigint; owner_address: string; send_id: string; aged: boolean }>`
    select id, status, trace_id, txid, deadline, nonce, owner_address, send_id,
           signed_at <= inrp2p_now() - make_interval(mins => ${policy.unresolvedAfterMinutes}) as aged
      from gasfree_permit where status in ('SIGNED', 'SUBMITTED') order by signed_at limit ${policy.batch}`.execute(db);
  for (const p of live.rows) {
    report.examined += 1;
    try {
      const now = clockOf(deps);
      let txid = p.txid;
      if (!txid && p.trace_id) {
        const trace = await deps.gasFree.trace(p.trace_id);
        if (trace.txid) {
          txid = trace.txid;
          await step(db, 'gasfree_permit.traced', { permitId: p.id }, async (ctx) => {
            await ctx.tx.updateTable('gasfree_permit').set({ txid: trace.txid, last_answer: `GasFree: ${trace.state}` }).where('id', '=', p.id).where('txid', 'is', null).execute();
          });
        }
      }
      if (txid) {
        const outcome = await deps.network.outcome(txid);
        if (outcome.status === 'FINAL' && outcome.facts.success) {
          await step(db, 'gasfree_permit.confirm', { permitId: p.id }, (ctx) => confirmPermitInTx(ctx, deps, p.id, txid!, outcome.agreedBy.join(',')));
          report.confirmed += 1;
          continue;
        }
        if (outcome.status === 'PENDING') {
          report.pending += 1;
          continue;
        }
        // Reverted, or unknown: nothing moved by it — but the same permit may still be given again until its deadline.
      } else if (p.status === 'SIGNED' && now < p.deadline.getTime()) {
        if (await submitPermit(db, deps, p.id)) report.submitted += 1;
        continue;
      }
      if (now > p.deadline.getTime() + policy.permitDeadlineMarginSeconds * 1000) {
        const proof = await provePermitDead(deps, p.deadline.getTime(), policy.permitDeadlineMarginSeconds * 1000, p.owner_address, p.nonce);
        if (proof.dead) {
          await expirePermit(db, p.id, proof.by);
          report.expired += 1;
          continue;
        }
        if (proof.executed && p.aged) {
          await unresolved(db, p.send_id, `permit nonce ${p.nonce} of ${p.owner_address} was used on chain, but no transaction of it is known: find it on the GasFree account and resolve the permit with its hash`);
          report.unresolved += 1;
          continue;
        }
      }
      report.pending += 1;
    } catch (e) {
      report.failures.push({ permitId: p.id, code: isDomainError(e) ? e.code : (pgErrorCode(e) ?? 'UNEXPECTED'), message: (e instanceof Error ? e.message : String(e)).slice(0, 500) });
    }
  }
  return report;
}

/**
 * A permit is dead when every configured provider's solidified head is past its deadline (the controller refuses it from
 * then on) and the controller's solidified nonce of its owner is still its own (it never executed).
 */
async function provePermitDead(deps: OnchainDeps, deadlineMs: number, marginMs: number, user: string, nonce: bigint): Promise<{ dead: boolean; executed: boolean; by: readonly string[] }> {
  const heads = await Promise.all(deps.network.gateways.map(async (g) => ({ g, head: await g.solidifiedHead().catch(() => null) })));
  if (heads.some((h) => !h.head || h.head.timestamp <= deadlineMs + marginMs)) return { dead: false, executed: false, by: [] };
  const used = await deps.network.solidifiedView(deps.gasFree!.chain.controller, 'nonces(address)', abiAddressWord(user));
  return { dead: used === nonce, executed: used > nonce, by: heads.map((h) => h.g.name) };
}

async function expirePermit(db: Db, permitId: string, by: readonly string[]): Promise<void> {
  await step(db, 'gasfree_permit.expire', { permitId }, async (ctx) => {
    const p = await ctx.tx.selectFrom('gasfree_permit').select(['id', 'send_id', 'status', 'nonce']).where('id', '=', permitId).forUpdate().executeTakeFirstOrThrow();
    if (p.status !== 'SIGNED' && p.status !== 'SUBMITTED') return;
    await ctx.tx.updateTable('gasfree_permit').set({ status: 'EXPIRED', decided_at: sql<Date>`inrp2p_now()`, decided_by: by.join(',').slice(0, 300) }).where('id', '=', p.id).execute();
    const send = await lockSend(ctx, p.send_id);
    if (send.status === 'SENDING') {
      await ctx.tx.updateTable('chain_send').set({ status: 'PLANNED', updated_at: sql<Date>`inrp2p_now()`, last_error: `permit ${p.nonce} expired unused`, last_error_at: sql<Date>`inrp2p_now()` }).where('id', '=', send.id).execute();
    }
    await appendAudit(ctx, { action: 'gasfree_permit.expired', entityType: 'chain_send', entityId: p.send_id, after: { nonce: p.nonce.toString(), proved_by: by } });
  });
}

async function unresolved(db: Db, sendId: string, reason: string): Promise<void> {
  await step(db, 'chain_send.unresolved', { sendId }, async (ctx) => {
    const send = await ctx.tx.selectFrom('chain_send').select(['id', 'ref', 'trade_id']).where('id', '=', sendId).executeTakeFirstOrThrow();
    await openExceptionInTx(ctx, { type: 'CHAIN_SEND_UNRESOLVED', subjectType: 'CHAIN_SEND', subjectId: send.id, tradeId: send.trade_id, details: { ref: send.ref, reason } });
  });
}

/**
 * `gasfree_permit.resolve` — `network:manage` (⧗), with the transaction's hash. For a permit whose nonce the chain shows
 * used while GasFree never named its transaction: a person finds it on the GasFree account and hands in its hash. Only
 * the chain's word counts — the transaction must be final, successful, and pay the permit's receiver its amount from its
 * account (`settleGasFreeNetworkInTx`, `settleSignedSendInTx`); anything else is refused and nothing is written.
 */
export function resolveGasFreePermit(actor: OperatorActor, deps: OnchainDeps) {
  return operatorCommand(actor, 'network:manage', async (ctx, p: { permitId: string; txid: string; reason: string }) => {
    const txid = String(p.txid ?? '').trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(txid)) throw new DomainError('INVALID_ARGUMENT', 'a transaction hash is 64 hex characters');
    const permit = await ctx.tx.selectFrom('gasfree_permit').select(['id', 'status']).where('id', '=', requireUuid(p.permitId, 'permitId')).executeTakeFirst();
    if (!permit || (permit.status !== 'SIGNED' && permit.status !== 'SUBMITTED')) throw new DomainError('INVALID_TRANSITION', 'only a live permit is resolved');
    const outcome = await deps.network.outcome(txid);
    if (outcome.status !== 'FINAL' || !outcome.facts.success) throw new DomainError('TRANSFER_NOT_CONFIRMED', `transaction ${txid} is not final and successful on the configured providers`);
    await confirmPermitInTx(ctx, deps, permit.id, txid, `${ctx.actor.id ?? 'SYSTEM'}: ${String(p.reason ?? '').slice(0, 200)}`);
    return { confirmed: true };
  });
}

