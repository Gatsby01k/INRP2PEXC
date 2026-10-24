import { sql } from 'kysely';
import { Money, isDomainError } from '@inrp2p/kernel';
import { type Db, pgErrorCode } from '@inrp2p/db';
import { effectiveObligations, legTotals } from '@inrp2p/trades';
import { createPayoutLegInTx, finishP2pUnwindInTx, fundingSources, openExceptionInTx, planEscrowReturnInTx, planFeeSweepInTx, planP2pRefundInTx, planRoutePaymentInTx, revenueWallet, sendPayoutLegInTx } from '@inrp2p/settlement';
import { closeNetworkHold, latestFeeSnapshot, networkAvailable, networkFeePolicy, planTrxReclaimInTx, recordFeeSnapshot, recordMarketTrxRate, reservePerSendSun, signablePathOf } from '@inrp2p/network';
import { observeBalances } from '@inrp2p/scanner';
import { type OnchainDeps, policyOf, settlementDepsOf, step } from './deps.ts';

/**
 * What is due, paid without anyone pressing a button (ADR 0017 §4) — and only that:
 *
 * - a client buying USDT is paid its USDT from the address the trader's USDT arrived at, once the client's INR is
 *   confirmed and the trader's USDT is final (D-12, FI-72): never before, never from anywhere else;
 * - a counterparty is paid the client's USDT from the client's deposit address once it delivered its INR in full
 *   (DVP, FI-77);
 * - a P2P trader gets its own USDT back from the escrow of a deal its client never paid (ADR 0019 §2.7);
 * - a P2P client gets its own USDT back from the escrow of a SELL its trader never paid (TD-35);
 * - INRP2P's earnings go from the deal addresses no trade uses to its revenue wallet, once an address has earned enough
 *   to be worth the transfer and the platform has the TRX for it; the TRX the transfers did not burn goes back to the
 *   budget wallet (block 10, TD-31, TD-36).
 *
 * Every payout is planned through the same commands the desk uses, with every check they make; above the approval
 * threshold it then waits for a second person before the signer touches it (C1). INR stays with the desk: no bank is
 * driven from here.
 */
export interface AutopayReport {
  readonly payoutsPlanned: number;
  readonly routePaymentsPlanned: number;
  readonly escrowReturnsPlanned: number;
  readonly refundsPlanned: number;
  readonly sweepsPlanned: number;
  /** Addresses whose earnings are worth sweeping but wait for the platform's TRX. */
  readonly sweepsWaiting: number;
  readonly reclaimsPlanned: number;
  readonly skipped: readonly { readonly tradeId: string; readonly code: string; readonly message: string }[];
}

export async function runAutopay(db: Db, deps: OnchainDeps): Promise<AutopayReport> {
  const report = { payoutsPlanned: 0, routePaymentsPlanned: 0, escrowReturnsPlanned: 0, refundsPlanned: 0, sweepsPlanned: 0, sweepsWaiting: 0, reclaimsPlanned: 0, skipped: [] as { tradeId: string; code: string; message: string }[] };
  const sdeps = settlementDepsOf(deps);
  const skipped = async (tradeId: string, e: unknown) => {
    const code = isDomainError(e) ? e.code : (pgErrorCode(e) ?? 'UNEXPECTED');
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    report.skipped.push({ tradeId, code, message });
    // A transfer the trade's hold has no room for waits for a person (FI-95): say so on the desk, once.
    if (code === 'NETWORK_BUDGET_INSUFFICIENT' || code === 'IX115') {
      await step(db, 'autopay.network_budget_short', { tradeId }, (ctx) =>
        openExceptionInTx(ctx, { type: 'NETWORK_BUDGET_SHORT', subjectType: 'TRADE', subjectId: tradeId, tradeId, details: { reason: message } })).catch(() => undefined);
    }
  };

  const buys = await sql<{ id: string }>`
    select t.id from trade t
      join network_budget_hold h on h.trade_id = t.id and h.status = 'ACTIVE'
     where t.direction = 'BUY_USDT' and t.lifecycle_state in ('FIRST_LEG_CONFIRMED', 'SETTLING', 'PARTIALLY_SETTLED') and not t.hold
       and not exists (select 1 from settlement_leg l where l.trade_id = t.id and l.side in ('EXCHANGE_TO_CLIENT', 'REFUND_TO_CLIENT') and l.status in ('PENDING', 'PROCESSING'))
       and exists (select 1 from funding_source s where s.trade_id = t.id and s.kind = 'COUNTERPARTY_FUNDS' and s.asset = 'USDT')
     order by t.opened_at limit 50`.execute(db);
  for (const t of buys.rows) {
    try {
      const { payout } = await effectiveObligations(db, t.id);
      const totals = await legTotals(db, t.id);
      const unpaid = payout.minor - totals.committed;
      if (unpaid <= 0n) continue;
      const source = (await fundingSources(db, t.id, { kind: 'COUNTERPARTY_FUNDS', asset: 'USDT' })).find((s) => s.availableMinor > 0n);
      if (!source) continue;
      const address = source.location.slice('TRON:'.length);
      if (!(await signablePathOf(db, address))) continue;
      const deposit = await db.selectFrom('deposit_address').select('id').where('network', '=', 'TRON').where('address', '=', address).executeTakeFirstOrThrow();
      const amount = source.availableMinor < unpaid ? source.availableMinor : unpaid;
      // B2: the payout is created against a fresh reading of the address it leaves from.
      await observeBalances(db, { sources: deps.chain.balanceSources(), contract: deps.chain.tokenContract }, { addresses: [address] });
      await step(db, 'autopay.client_payout', { tradeId: t.id }, async (ctx) => {
        const leg = await createPayoutLegInTx(ctx, sdeps, { tradeId: t.id, amount: Money.ofMinor(amount, 'USDT').toDecimalString(), payer: 'EXCHANGE_ACCOUNT', sourceDepositAddressId: deposit.id });
        return sendPayoutLegInTx(ctx, sdeps, leg.legId);
      });
      report.payoutsPlanned += 1;
    } catch (e) {
      await skipped(t.id, e);
    }
  }

  const sells = await sql<{ id: string; address: string }>`
    select distinct t.id, substr(s.location, 6) as address from trade t
      join network_budget_hold h on h.trade_id = t.id and h.status = 'ACTIVE'
      join route_obligation o on o.trade_id = t.id
      join funding_source s on s.trade_id = t.id and s.kind = 'CLIENT_FUNDS' and s.asset = 'USDT'
     where t.direction = 'SELL_USDT' and not t.hold and t.lifecycle_state <> 'CANCELLED'
       and o.status in ('OPEN', 'PARTIALLY_SETTLED') and o.exchange_delivers_asset = 'USDT'
       and inrp2p_counterparty_delivered(o.id)
       and not exists (select 1 from chain_send c where c.route_obligation_id = o.id and c.purpose = 'ROUTE_PAYMENT' and c.status not in ('CONFIRMED', 'CANCELLED'))
       and not exists (select 1 from settlement_leg l where l.trade_id = t.id and l.side = 'REFUND_TO_CLIENT' and l.status in ('PENDING', 'PROCESSING'))
     order by t.id limit 50`.execute(db);
  for (const t of sells.rows) {
    try {
      await observeBalances(db, { sources: deps.chain.balanceSources(), contract: deps.chain.tokenContract }, { addresses: [t.address] });
      const planned = await step(db, 'autopay.route_payment', { tradeId: t.id }, (ctx) => planRoutePaymentInTx(ctx, sdeps, t.id, `SYSTEM:${ctx.commandName}`));
      if (planned) report.routePaymentsPlanned += 1;
    } catch (e) {
      await skipped(t.id, e);
    }
  }

  const unwound = await sql<{ id: string; address: string }>`
    select distinct t.id, substr(s.location, 6) as address from trade t
      join network_budget_hold h on h.trade_id = t.id and h.status = 'ACTIVE'
      join route_obligation o on o.trade_id = t.id
      join funding_source s on s.trade_id = t.id and s.kind = 'COUNTERPARTY_FUNDS' and s.asset = 'USDT'
     where t.lifecycle_state = 'CANCELLED' and o.status = 'CANCELLED' and o.execution_mode = 'P2P'
       and inrp2p_escrow_returnable(o.id) > 0
       and not exists (select 1 from chain_send c where c.route_obligation_id = o.id and c.purpose = 'ESCROW_RETURN' and c.status not in ('CONFIRMED', 'CANCELLED'))
     order by t.id limit 50`.execute(db);
  for (const t of unwound.rows) {
    try {
      await observeBalances(db, { sources: deps.chain.balanceSources(), contract: deps.chain.tokenContract }, { addresses: [t.address] });
      const planned = await step(db, 'autopay.escrow_return', { tradeId: t.id }, (ctx) => planEscrowReturnInTx(ctx, sdeps, t.id, `SYSTEM:${ctx.commandName}`));
      if (planned) report.escrowReturnsPlanned += 1;
    } catch (e) {
      await skipped(t.id, e);
    }
  }

  // A SELL its trader did not pay (in time, or at all): the client's USDT goes back to the wallet it came from.
  const refunds = await sql<{ id: string; address: string }>`
    select distinct t.id, substr(s.location, 6) as address from trade t
      join p2p_unwind u on u.trade_id = t.id
      join network_budget_hold h on h.trade_id = t.id and h.status = 'ACTIVE'
      join funding_source s on s.trade_id = t.id and s.kind = 'CLIENT_FUNDS' and s.asset = 'USDT'
     where t.lifecycle_state not in ('COMPLETED', 'CANCELLED')
       and not exists (select 1 from settlement_leg l where l.trade_id = t.id and l.side = 'REFUND_TO_CLIENT' and l.status in ('PENDING', 'PROCESSING'))
       -- One the signer cannot return waits with the desk's case; it is tried again once the case is closed.
       and (u.waiting_reason is null or not exists (select 1 from exception_case c where c.trade_id = t.id and c.type = 'P2P_PAYMENT_OVERDUE' and c.status in ('OPEN', 'IN_PROGRESS')))
     order by t.id limit 50`.execute(db);
  for (const t of refunds.rows) {
    try {
      await observeBalances(db, { sources: deps.chain.balanceSources(), contract: deps.chain.tokenContract }, { addresses: [t.address] });
      const planned = await step(db, 'autopay.escrow_refund', { tradeId: t.id }, (ctx) => planP2pRefundInTx(ctx, sdeps, t.id));
      if (planned && 'sendRef' in planned) report.refundsPlanned += 1;
    } catch (e) {
      await skipped(t.id, e);
    }
  }

  // An address waiting for the platform's TRX is no trade's case: it is only noted.
  await runFeeSweeps(db, deps, report, async (address, e) => {
    report.skipped.push({ tradeId: address, code: isDomainError(e) ? e.code : (pgErrorCode(e) ?? 'UNEXPECTED'), message: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
  });
  return report;
}

/**
 * INRP2P's earnings off the deal addresses (block 10). An address no trade uses is swept once its completed trades earned
 * at least the policy's minimum there — one transfer for all of them — and only while the platform's budget can pay it;
 * the rest waits, safe where it is. Then the TRX that addresses' transfers did not burn goes back to the budget wallet,
 * from every address whose earnings are not about to be swept.
 */
async function runFeeSweeps(db: Db, deps: OnchainDeps, report: { sweepsPlanned: number; sweepsWaiting: number; reclaimsPlanned: number }, skipped: (id: string, e: unknown) => Promise<void>): Promise<void> {
  const fees = await networkFeePolicy(db);
  const snapshot = await latestFeeSnapshot(db);
  if (!snapshot) return;
  const sdeps = settlementDepsOf(deps);
  const sweepable = new Set<string>();
  if (fees.feeSweepEnabled && (await revenueWallet(db))) {
    const due = await sql<{ address: string }>`
      select d.address
        from deposit_address d
        join (select distinct s.trade_id, s.location from funding_source s join trade t on t.id = s.trade_id
               where s.asset = 'USDT' and t.lifecycle_state = 'COMPLETED') x on x.location = 'TRON:' || d.address
       where d.network = 'TRON' and d.status <> 'ASSIGNED' and d.source = 'DERIVED'
         and not exists (select 1 from chain_send c where c.from_address = d.address and c.status not in ('CONFIRMED', 'CANCELLED'))
       group by d.address
      having sum(inrp2p_trade_sweepable(x.trade_id, x.location)) >= ${fees.feeSweepMinUsdtMinor}
       order by sum(inrp2p_trade_sweepable(x.trade_id, x.location)) desc
       limit 20`.execute(db);
    const perSweep = reservePerSendSun(snapshot, fees);
    for (const a of due.rows) {
      sweepable.add(a.address);
      // The platform pays its own sweeps: none is planned it could not fuel now.
      if ((await networkAvailable(db, null)) < perSweep) {
        report.sweepsWaiting += 1;
        continue;
      }
      try {
        await observeBalances(db, { sources: deps.chain.balanceSources(), contract: deps.chain.tokenContract }, { addresses: [a.address] });
        const planned = await step(db, 'autopay.fee_sweep', { address: a.address }, (ctx) => planFeeSweepInTx(ctx, sdeps, { address: a.address, minMinor: fees.feeSweepMinUsdtMinor, requestedBy: `SYSTEM:${ctx.commandName}` }));
        if (planned) report.sweepsPlanned += 1;
      } catch (e) {
        await skipped(a.address, e);
      }
    }
  }

  // TD-31: what the transfers did not burn, from addresses topped up since their last reclaim, idle for a while.
  const topped = await sql<{ address: string }>`
    select distinct d.address
      from deposit_address d
      join chain_send t on t.to_address = d.address and t.purpose = 'TOPUP' and t.status = 'CONFIRMED'
     where d.network = 'TRON' and d.status <> 'ASSIGNED' and d.source = 'DERIVED'
       and not exists (select 1 from chain_send c where (c.from_address = d.address or c.to_address = d.address)
                          and (c.status not in ('CONFIRMED', 'CANCELLED') or c.closed_at > inrp2p_now() - make_interval(mins => ${policyOf(deps).reclaimIdleMinutes})))
       and t.created_at > coalesce((select max(r.created_at) from chain_send r where r.purpose = 'TRX_RECLAIM' and r.from_address = d.address and r.status = 'CONFIRMED'), '-infinity'::timestamptz)
     limit 20`.execute(db);
  for (const a of topped.rows) {
    if (sweepable.has(a.address)) continue;
    try {
      const account = await deps.network.accountState(a.address);
      // A plain TRX transfer is about 270 bytes: free when the address has that much free bandwidth left today.
      const fee = account.freeNetLimit - account.freeNetUsed >= 300 ? 0n : BigInt(fees.topupBytes) * snapshot.bandwidthPriceSun;
      const amount = account.balanceSun - fee;
      if (amount < fees.trxReclaimMinSun) continue;
      await step(db, 'autopay.trx_reclaim', { address: a.address }, (ctx) => planTrxReclaimInTx(ctx, { address: a.address, amountSun: amount, feeEstimateSun: fee }));
      report.reclaimsPlanned += 1;
    } catch (e) {
      await skipped(a.address, e);
    }
  }
}

/**
 * Ends every unwound P2P deal whose client's USDT is back (TD-35): the trade is cancelled, each in its own step. Run after
 * the monitor settled what the chain made final, before the holds close.
 */
export async function runUnwindClosing(db: Db): Promise<{ cancelled: number }> {
  const done = await sql<{ trade_id: string }>`
    select u.trade_id from p2p_unwind u
      join trade t on t.id = u.trade_id
      join settlement_leg l on l.id = u.refund_leg_id and l.status = 'COMPLETED'
     where t.lifecycle_state not in ('COMPLETED', 'CANCELLED')
     order by u.created_at limit 100`.execute(db);
  let cancelled = 0;
  for (const u of done.rows) {
    if (await step(db, 'autopay.escrow_unwound', { tradeId: u.trade_id }, (ctx) => finishP2pUnwindInTx(ctx, u.trade_id))) cancelled += 1;
  }
  return { cancelled };
}

/**
 * Closes the network hold of every trade that can send nothing more: finished, its counterparty paid (or the
 * obligation over), no send of it still open. What it did not spend is free again; a trader is owed what it fronted
 * and does not bear (`closeNetworkHold`).
 */
export async function runHoldClosing(db: Db): Promise<{ closed: number }> {
  const done = await sql<{ trade_id: string }>`
    select h.trade_id from network_budget_hold h
      join trade t on t.id = h.trade_id
      left join route_obligation o on o.trade_id = t.id
     where h.status = 'ACTIVE' and t.lifecycle_state in ('COMPLETED', 'CANCELLED')
       and (o.id is null or o.status in ('SETTLED', 'CANCELLED') or o.exchange_delivers_asset = 'INR')
       -- A P2P trader's escrow still to go back keeps the TRX that returns it (ADR 0019 §2.7).
       and (o.id is null or inrp2p_escrow_returnable(o.id) = 0)
       and not exists (select 1 from chain_send s where s.trade_id = t.id and s.status not in ('CONFIRMED', 'CANCELLED'))
     order by h.created_at limit 200`.execute(db);
  let closed = 0;
  for (const h of done.rows) {
    const out = await step(db, 'network.close_hold', { tradeId: h.trade_id }, (ctx) => closeNetworkHold(ctx, h.trade_id, 'the trade is finished and nothing more is sent'));
    if (out.closed) closed += 1;
  }
  return { closed };
}

/** `network_fee_refresh`: what the chain charges now, read from the providers and recorded. */
/**
 * The TRX price from public markets (`trx_rate_refresh`): read, then published under the system actor unless it moved
 * too far from the last one. Without it, quotes stop 72 hours after a person last remembered to publish a price.
 */
export async function runTrxRateRefresh(db: Db, read: () => Promise<{ usdtPerTrxMicro: bigint; source: string }>): Promise<{ rateId: string | null; usdtPerTrxMicro: string; skipped?: string }> {
  const reading = await read();
  const out = await step(db, 'network.trx_rate_published', { source: reading.source }, (ctx) => recordMarketTrxRate(ctx, reading));
  return { ...out, usdtPerTrxMicro: reading.usdtPerTrxMicro.toString() };
}

export async function runFeeRefresh(db: Db, deps: Pick<OnchainDeps, 'network'>): Promise<{ snapshotId: string; energyPriceSun: string }> {
  const params = await deps.network.feeParameters();
  const out = await step(db, 'network.fees_observed', { by: params.by }, (ctx) => recordFeeSnapshot(ctx, params.value, [params.by]));
  return { snapshotId: out.snapshotId, energyPriceSun: params.value.energyPriceSun.toString() };
}
