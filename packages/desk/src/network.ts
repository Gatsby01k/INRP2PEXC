import { sql } from 'kysely';
import { Money, formatTrx, trxToInrMinor } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';
import { budgetFigures, custodyHdAccount, latestFeeSnapshot, latestTrxRate, listSends, networkBudgetWallet, networkFeePolicy, openWithdrawals, quoteFeeSun, reservePerSendSun } from '@inrp2p/network';

/**
 * The desk's view of the exchange's own rails (ADR 0017): the TRX budget each funder prefunded and what of it is free,
 * what the chain charges and what a TRX is worth, every send in flight with its transactions, the trades' network
 * economics — the fee priced in, what the network actually cost, what the trader is paid back and what is left — and
 * the budget wallet as the chain sees it against what the records say it holds.
 */
export interface FunderRow {
  readonly funder: 'PLATFORM' | string;
  readonly traderRef: string | null;
  readonly name: string;
  readonly deposited: string;
  readonly spent: string;
  readonly withdrawn: string;
  readonly balance: string;
  readonly held: string;
  readonly inFlight: string;
  readonly withdrawing: string;
  readonly available: string;
}

export interface NetworkSendRow {
  readonly id: string;
  readonly ref: string;
  readonly purpose: string;
  readonly asset: 'USDT' | 'TRX';
  readonly amount: string;
  readonly status: string;
  readonly tradeId: string | null;
  readonly tradeRef: string | null;
  readonly from: string;
  readonly to: string;
  readonly bearer: string;
  readonly needsApproval: boolean;
  readonly approvedBy: string | null;
  readonly requestedBy: string;
  readonly blockedReason: string | null;
  readonly lastError: string | null;
  readonly failedAttempts: number;
  /** A USDT send's fixed TRX cap and what its top-ups drew on it (null for a TRX send). */
  readonly networkCap: string | null;
  readonly networkUsed: string | null;
  readonly updatedAt: string;
  readonly attempts: readonly { readonly seq: number; readonly txid: string; readonly status: string; readonly broadcasts: number; readonly expiration: string; readonly burned: string | null; readonly energy: string | null; readonly result: string | null }[];
}

export interface TradeNetworkRow {
  readonly tradeId: string;
  readonly ref: string;
  readonly direction: 'SELL_USDT' | 'BUY_USDT';
  readonly lifecycle: string;
  readonly funder: string;
  readonly grossMargin: string;
  readonly reward: string;
  /** The network fee inside the client's price (INR) and the TRX it priced. */
  readonly feeCharged: string;
  readonly feeChargedTrx: string;
  readonly heldTrx: string;
  /** TRX the trade's transfers actually cost the funder (top-ups and their fees), and its INR value at the quote's price. */
  readonly spentTrx: string;
  /** Of that, what a trader bears (a return its own failure caused): not a cost of the trade. */
  readonly traderBorneTrx: string;
  /** What the network cost the exchange, in INR at the quote's TRX price and rate. */
  readonly spentInr: string;
  readonly reimbursed: string | null;
  /**
   * What the trade leaves: gross margin less the reward less the network — what its transfers actually cost once its
   * hold is closed (`netFinal`), and until then the fee its price carried (or the cost so far, if that is already more).
   */
  readonly netProfit: string;
  readonly netFinal: boolean;
  readonly holdStatus: 'ACTIVE' | 'CLOSED' | 'NONE';
}

export interface NetworkView {
  readonly hdAccount: { readonly provider: string; readonly xpub: string; readonly feeWallet: string } | null;
  readonly budgetWallet: { readonly address: string; readonly onChainTrx: string | null; readonly observedAt: string | null; readonly recordedTrx: string; readonly difference: string | null } | null;
  readonly policy: { readonly autoSend: boolean; readonly quoteEnergy: number; readonly reserveEnergy: number; readonly minNetMargin: string; readonly priceBufferBps: number; readonly topupBufferBps: number; readonly setAt: string; readonly reason: string };
  readonly fees: { readonly energyPriceSun: string; readonly observedAt: string; readonly ageSeconds: number; readonly perSendQuotedTrx: string; readonly perSendHeldTrx: string } | null;
  readonly trxRate: { readonly usdtPerTrx: string; readonly source: string; readonly effectiveAt: string; readonly ageSeconds: number } | null;
  readonly funders: readonly FunderRow[];
  readonly sends: readonly NetworkSendRow[];
  readonly trades: readonly TradeNetworkRow[];
  readonly withdrawals: readonly { readonly id: string; readonly ref: string; readonly traderRef: string; readonly amount: string; readonly fee: string; readonly to: string; readonly status: string; readonly requestedAt: string }[];
}

const trx = (sun: bigint) => formatTrx(sun);

export async function networkView(ex: Executor, opts: { tradeLimit?: number; sendLimit?: number } = {}): Promise<NetworkView> {
  const [account, wallet, policy, snapshot, rate] = await Promise.all([custodyHdAccount(ex), networkBudgetWallet(ex), networkFeePolicy(ex), latestFeeSnapshot(ex), latestTrxRate(ex)]);

  const traderRows = await sql<{ id: string; ref: string; name: string }>`
    select t.id, t.ref, c.display_name as name from trader_profile t join client c on c.id = t.client_id
     where exists (select 1 from network_budget_entry e where e.trader_id = t.id) or exists (select 1 from network_budget_hold h where h.trader_id = t.id)
     order by t.ref`.execute(ex);
  let recorded = 0n;
  const funderOf = async (id: string | null, ref: string | null, name: string): Promise<FunderRow> => {
    const f = await budgetFigures(ex, id);
    recorded += f.balanceSun;
    return {
      funder: id ?? 'PLATFORM', traderRef: ref, name, deposited: trx(f.depositedSun), spent: trx(f.spentSun), withdrawn: trx(f.withdrawnSun), balance: trx(f.balanceSun),
      held: trx(f.heldSun), inFlight: trx(f.inFlightSun), withdrawing: trx(f.withdrawingSun), available: trx(f.availableSun),
    };
  };
  const funders = [await funderOf(null, null, 'Platform budget')];
  for (const t of traderRows.rows) funders.push(await funderOf(t.id, t.ref, t.name));

  let budgetWallet: NetworkView['budgetWallet'] = null;
  if (wallet) {
    const obs = await ex.selectFrom('custody_balance_observation').select(['trx_sun', 'observed_at']).where('address', '=', wallet.address).orderBy('observed_at', 'desc').limit(1).executeTakeFirst();
    // TRX already sent to deal addresses and not yet burned belongs to the funders but sits there, not at the wallet.
    const inFlight = await sql<{ t: string }>`
      select coalesce(sum(s.amount_minor + s.fee_estimate_sun), 0)::text as t from chain_send s
        join chain_send_attempt a on a.send_id = s.id and a.status in ('SIGNED', 'BROADCAST')
       where s.asset = 'TRX' and s.from_address = ${wallet.address}`.execute(ex);
    const expected = recorded - BigInt(inFlight.rows[0]!.t);
    const onChain = obs?.trx_sun ?? null;
    budgetWallet = {
      address: wallet.address,
      onChainTrx: onChain === null ? null : trx(onChain),
      observedAt: obs?.observed_at.toISOString() ?? null,
      recordedTrx: trx(expected > 0n ? expected : 0n),
      difference: onChain === null ? null : trx(onChain - expected),
    };
  }

  const sends = await sendRowsOf(ex, { limit: opts.sendLimit ?? 60 });

  const trades = await tradeNetworkRows(ex, { limit: opts.tradeLimit ?? 50 });

  const withdrawals = (await openWithdrawals(ex)).map((w) => ({
    id: w.id, ref: w.ref, traderRef: w.trader_ref, amount: trx(w.amount_sun), fee: trx(w.fee_estimate_sun), to: w.to_address, status: w.status, requestedAt: w.requested_at.toISOString(),
  }));

  return {
    hdAccount: account ? { provider: account.provider, xpub: account.account_xpub, feeWallet: account.fee_wallet_address } : null,
    budgetWallet,
    policy: {
      autoSend: policy.autoSendEnabled, quoteEnergy: policy.quoteEnergy, reserveEnergy: policy.reserveEnergy, minNetMargin: Money.ofMinor(policy.minNetMarginInrMinor, 'INR').toDecimalString(),
      priceBufferBps: policy.priceBufferBps, topupBufferBps: policy.topupBufferBps, setAt: policy.setAt.toISOString(), reason: policy.reason,
    },
    fees: snapshot ? {
      energyPriceSun: snapshot.energyPriceSun.toString(), observedAt: snapshot.observedAt.toISOString(), ageSeconds: snapshot.ageSeconds,
      perSendQuotedTrx: trx(quoteFeeSun(snapshot, policy)), perSendHeldTrx: trx(reservePerSendSun(snapshot, policy)),
    } : null,
    trxRate: rate ? { usdtPerTrx: formatTrx(rate.usdtPerTrxMicro), source: rate.source, effectiveAt: rate.effectiveAt.toISOString(), ageSeconds: rate.ageSeconds } : null,
    funders,
    sends,
    trades,
    withdrawals,
  };
}

const NO_ID = '00000000-0000-0000-0000-000000000000';

async function sendRowsOf(ex: Executor, filter: { tradeId?: string; limit: number }): Promise<NetworkSendRow[]> {
  const sendRows = await listSends(ex, filter);
  const tradeRefs = new Map((await ex.selectFrom('trade').select(['id', 'ref']).where('id', 'in', [...new Set(sendRows.map((s) => s.tradeId).filter((t): t is string => t !== null)), NO_ID]).execute()).map((t) => [t.id, t.ref]));
  const requesters = await ex.selectFrom('chain_send').select(['id', 'requested_by']).where('id', 'in', [...sendRows.map((s) => s.id), NO_ID]).execute();
  const requestedBy = new Map(requesters.map((r) => [r.id, r.requested_by]));
  return sendRows.map((s) => ({
    id: s.id, ref: s.ref, purpose: s.purpose, asset: s.asset,
    amount: s.asset === 'TRX' ? `${trx(s.amountMinor)} TRX` : `${Money.ofMinor(s.amountMinor, 'USDT').toDecimalString()} USDT`,
    status: s.status, tradeId: s.tradeId, tradeRef: s.tradeId ? (tradeRefs.get(s.tradeId) ?? null) : null, from: s.from, to: s.to, bearer: s.bearer,
    needsApproval: s.needsApproval, approvedBy: s.approvedBy, requestedBy: requestedBy.get(s.id) ?? '', blockedReason: s.blockedReason, lastError: s.lastError, failedAttempts: s.failedAttempts,
    networkCap: s.networkCapSun === null ? null : trx(s.networkCapSun), networkUsed: s.networkUsedSun === null ? null : trx(s.networkUsedSun),
    updatedAt: s.updatedAt.toISOString(),
    attempts: s.attempts.map((a) => ({ seq: a.seq, txid: a.txid, status: a.status, broadcasts: a.broadcasts, expiration: a.expiration.toISOString(), burned: a.feeSun === null ? null : trx(a.feeSun), energy: a.energyUsed === null ? null : a.energyUsed.toString(), result: a.result })),
  }));
}

/**
 * Each trade's network economics. What the network cost the exchange is what its transfers burned less the part a
 * trader bears (a return its own failure caused): that part is the trader's, not a cost of the trade.
 */
async function tradeNetworkRows(ex: Executor, filter: { tradeId?: string; limit: number }): Promise<TradeNetworkRow[]> {
  const rows = await sql<{
    id: string; ref: string; direction: 'SELL_USDT' | 'BUY_USDT'; lifecycle_state: string; gross: bigint; reward: bigint; fee_inr: bigint; fee_sun: bigint; usdt_per_trx: bigint;
    client_rate: bigint; funder: string | null; trader_ref: string | null; hold_amount: bigint | null; hold_status: 'ACTIVE' | 'CLOSED' | null; reimbursed: bigint | null; spent: string; trader_borne: string;
  }>`
    select t.id, t.ref, t.direction, t.lifecycle_state, q.gross_margin_inr_minor as gross, f.reward_inr_minor as reward, f.fee_inr_minor as fee_inr, f.fee_sun,
           f.usdt_per_trx_micro as usdt_per_trx, q.client_rate_micro as client_rate, f.funder_trader_id as funder, tp.ref as trader_ref,
           h.amount_sun as hold_amount, h.status as hold_status, h.reimbursed_inr_minor as reimbursed,
           coalesce((select -sum(e.amount_sun) from network_budget_entry e where e.kind = 'SPENT' and e.trade_id = t.id), 0)::text as spent,
           coalesce((select -sum(e.amount_sun) from network_budget_entry e
                       join chain_send_attempt a on a.id = e.chain_send_attempt_id
                       join chain_send s on s.id = a.send_id
                       join chain_send p on p.id = coalesce(s.parent_send_id, s.id)
                      where e.kind = 'SPENT' and e.trade_id = t.id and p.bearer = 'TRADER'), 0)::text as trader_borne
      from trade t
      join quote q on q.id = t.quote_id
      join quote_network_fee f on f.quote_id = q.id
      left join trader_profile tp on tp.id = f.funder_trader_id
      left join network_budget_hold h on h.trade_id = t.id
     where ${filter.tradeId ?? null}::uuid is null or t.id = ${filter.tradeId ?? null}::uuid
     order by t.opened_at desc limit ${filter.limit}`.execute(ex);
  return rows.rows.map((r) => {
    const spent = BigInt(r.spent);
    const traderBorne = BigInt(r.trader_borne);
    const costInr = trxToInrMinor(spent - traderBorne, r.usdt_per_trx, r.client_rate, 'UP');
    return {
      tradeId: r.id, ref: r.ref, direction: r.direction, lifecycle: r.lifecycle_state, funder: r.trader_ref ?? 'Platform',
      grossMargin: Money.ofMinor(r.gross, 'INR').toDecimalString(), reward: Money.ofMinor(r.reward, 'INR').toDecimalString(),
      feeCharged: Money.ofMinor(r.fee_inr, 'INR').toDecimalString(), feeChargedTrx: trx(r.fee_sun), heldTrx: r.hold_amount === null ? '0.000000' : trx(r.hold_amount),
      spentTrx: trx(spent), traderBorneTrx: trx(traderBorne), spentInr: Money.ofMinor(costInr, 'INR').toDecimalString(),
      reimbursed: r.reimbursed === null ? null : Money.ofMinor(r.reimbursed, 'INR').toDecimalString(),
      netProfit: Money.ofMinor(r.gross - r.reward - (r.hold_status === 'CLOSED' || costInr > r.fee_inr ? costInr : r.fee_inr), 'INR').toDecimalString(),
      netFinal: r.hold_status === 'CLOSED',
      holdStatus: r.hold_status ?? 'NONE',
    };
  });
}

/** One trade's network side, for its workspace: the economics (economics viewers only), its sends, and which refunds the signer can send. */
export interface DeskTradeNetwork {
  readonly funder: string;
  readonly holdStatus: 'ACTIVE' | 'CLOSED' | 'NONE';
  readonly heldTrx: string;
  readonly spentTrx: string;
  readonly traderBorneTrx: string;
  readonly reimbursed: string | null;
  readonly economics: Pick<TradeNetworkRow, 'grossMargin' | 'reward' | 'feeCharged' | 'feeChargedTrx' | 'spentInr' | 'netProfit' | 'netFinal'> | null;
  readonly sends: readonly NetworkSendRow[];
  /**
   * USDT refunds waiting for a second person whose money sits at an address the signer holds: approving one sends it.
   * One without a destination yet needs the client's sending wallet chosen with the approval.
   */
  readonly signerRefunds: readonly { readonly legId: string; readonly destinationSet: boolean }[];
}

export async function deskTradeNetwork(ex: Executor, tradeId: string, opts: { economics: boolean }): Promise<DeskTradeNetwork | null> {
  const [row] = await tradeNetworkRows(ex, { tradeId, limit: 1 });
  if (!row) return null;
  const legs = await sql<{ id: string; destination_set: boolean }>`
    select l.id, l.destination_wallet_id is not null as destination_set from settlement_leg l
      left join deposit_address da on da.id = l.source_deposit_address_id
      left join treasury_wallet tw on tw.id = l.treasury_wallet_id
     where l.trade_id = ${tradeId} and l.side = 'REFUND_TO_CLIENT' and l.asset = 'USDT' and l.status = 'PENDING'
       and (exists (select 1 from custody_hd_account h where h.provider = da.provider and da.source = 'DERIVED')
            or exists (select 1 from custody_hd_account h where h.fee_wallet_address = tw.address))`.execute(ex);
  return {
    funder: row.funder, holdStatus: row.holdStatus, heldTrx: row.heldTrx, spentTrx: row.spentTrx, traderBorneTrx: row.traderBorneTrx, reimbursed: row.reimbursed,
    economics: opts.economics ? { grossMargin: row.grossMargin, reward: row.reward, feeCharged: row.feeCharged, feeChargedTrx: row.feeChargedTrx, spentInr: row.spentInr, netProfit: row.netProfit, netFinal: row.netFinal } : null,
    sends: await sendRowsOf(ex, { tradeId, limit: 20 }),
    signerRefunds: legs.rows.map((l) => ({ legId: l.id, destinationSet: l.destination_set })),
  };
}
