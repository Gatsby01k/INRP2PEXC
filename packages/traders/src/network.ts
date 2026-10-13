import { sql } from 'kysely';
import { Money, formatTrx } from '@inrp2p/kernel';
import type { Executor, TraderSide } from '@inrp2p/db';
import { budgetFigures, currentNetworkCosts, networkBudgetWallet, reservePerSendSun, reserveSends, spentByBearer } from '@inrp2p/network';
import { traderApplicant } from '@inrp2p/trader-core';
import { assertTraderSafe } from './views.ts';

/**
 * A trader's network deposit (ADR 0017 §2), as the trader sees it: the TRX it paid in so the exchange can send USDT for
 * its orders, what its open orders hold, what each finished order spent and who bore it, and what came back as INR
 * with its rewards. Kept apart from the Security Reserve and from trading money, as the budget itself is.
 */
export interface TraderNetworkOrder {
  readonly orderRef: string;
  readonly side: TraderSide;
  readonly open: boolean;
  /** TRX held for the order's transfers (its worst case), from acceptance until it finishes. */
  readonly held: string;
  /** TRX its transfers actually burned out of the deposit. */
  readonly spent: string;
  /** Of that, the part the trader bears (a return of the counterparty's USDT its own failure caused). */
  readonly yours: string;
  /** TRX paid back, and its INR value added to the trader's rewards. */
  readonly repaidTrx: string;
  readonly repaidInr: string;
  readonly at: string;
}

export interface TraderNetworkView {
  readonly balance: string;
  readonly held: string;
  readonly inFlight: string;
  readonly withdrawing: string;
  readonly available: string;
  /**
   * What one order holds now, by the trader's side; null while the exchange has no current fee figures. A Buy USDT
   * order (the client sells) may need two transfers — paying the trader, or returning the client's USDT — a Sell USDT
   * order (the client buys) one.
   */
  readonly perOrder: { readonly BUY_USDT: string; readonly SELL_USDT: string } | null;
  /** The most one order of a side the trader offers holds: what must be free for the next order. */
  readonly perOrderNeed: string | null;
  /** How many more orders of the costlier side the free TRX covers. */
  readonly ordersCovered: number | null;
  /** Too little free TRX for one more order of the side(s) offered: new orders are not assigned. */
  readonly short: boolean;
  readonly depositAddress: string | null;
  readonly registeredWallet: string;
  readonly withdrawal: { readonly id: string; readonly ref: string; readonly amount: string; readonly fee: string; readonly status: 'REQUESTED' | 'APPROVED'; readonly askedAt: string } | null;
  readonly orders: readonly TraderNetworkOrder[];
  readonly repaidInrTotal: string;
  readonly history: readonly { readonly kind: 'DEPOSIT' | 'WITHDRAWAL' | 'ADJUSTMENT'; readonly amount: string; readonly status: string; readonly at: string; readonly txHash: string | null; readonly note: string | null }[];
}

const trx = (sun: bigint) => formatTrx(sun < 0n ? -sun : sun);

export async function traderNetworkView(ex: Executor, traderId: string): Promise<TraderNetworkView> {
  const profile = await ex
    .selectFrom('trader_profile as t')
    .innerJoin('crypto_wallet as w', 'w.id', 't.wallet_id')
    .select(['t.offers_buy', 't.offers_sell', 'w.address'])
    .where('t.id', '=', traderId)
    .executeTakeFirstOrThrow();
  const f = await budgetFigures(ex, traderId);
  let perOrder: TraderNetworkView['perOrder'] = null;
  let need = 0n;
  try {
    const { policy, snapshot } = await currentNetworkCosts(ex);
    const perSend = reservePerSendSun(snapshot, policy);
    // Holds follow the trade's direction: a trader's Buy USDT order is a client's SELL, its Sell USDT order a client's BUY.
    const traderBuys = perSend * BigInt(reserveSends('SELL_USDT', policy));
    const traderSells = perSend * BigInt(reserveSends('BUY_USDT', policy));
    perOrder = { BUY_USDT: formatTrx(traderBuys), SELL_USDT: formatTrx(traderSells) };
    need = profile.offers_buy ? traderBuys : profile.offers_sell ? traderSells : 0n;
  } catch {
    // No current fee figures: the exchange assigns nothing that moves USDT until it has them (routing says so).
  }
  const wallet = await networkBudgetWallet(ex);
  const open = await ex
    .selectFrom('network_deposit_withdrawal')
    .select(['id', 'ref', 'amount_sun', 'fee_estimate_sun', 'status', 'requested_at'])
    .where('trader_id', '=', traderId)
    .where('status', 'in', ['REQUESTED', 'APPROVED'])
    .executeTakeFirst();

  const holds = await ex
    .selectFrom('network_budget_hold as h')
    .innerJoin('trader_order as o', (j) => j.onRef('o.trade_id', '=', 'h.trade_id').onRef('o.trader_id', '=', 'h.trader_id'))
    .select(['h.trade_id', 'h.amount_sun', 'h.status', 'h.reimbursed_sun', 'h.reimbursed_inr_minor', 'h.created_at', 'h.closed_at', 'o.ref', 'o.side'])
    .where('h.trader_id', '=', traderId)
    .orderBy('h.created_at', 'desc')
    .limit(20)
    .execute();
  const orders: TraderNetworkOrder[] = [];
  for (const h of holds) {
    const spent = await spentByBearer(ex, h.trade_id);
    orders.push({
      orderRef: h.ref,
      side: h.side,
      open: h.status === 'ACTIVE',
      held: formatTrx(h.amount_sun),
      spent: formatTrx(spent.total),
      yours: formatTrx(spent.trader),
      repaidTrx: formatTrx(h.reimbursed_sun ?? 0n),
      repaidInr: Money.ofMinor(h.reimbursed_inr_minor ?? 0n, 'INR').toDecimalString(),
      at: (h.closed_at ?? h.created_at).toISOString(),
    });
  }
  const repaid = await sql<{ total: string }>`
    select coalesce(sum(reimbursed_inr_minor), 0)::text as total from network_budget_hold where trader_id = ${traderId} and status = 'CLOSED'`.execute(ex);

  const entries = await ex
    .selectFrom('network_budget_entry')
    .select(['kind', 'amount_sun', 'tx_hash', 'note', 'created_at'])
    .where('trader_id', '=', traderId)
    .where('kind', 'in', ['DEPOSIT', 'ADJUSTMENT'])
    .orderBy('created_at', 'desc')
    .limit(20)
    .execute();
  const withdrawals = await sql<{ amount_sun: string; status: string; requested_at: Date; closed_at: Date | null; txid: string | null }>`
    select w.amount_sun::text, w.status, w.requested_at, w.closed_at,
           (select a.txid from chain_send s join chain_send_attempt a on a.send_id = s.id
             where s.withdrawal_id = w.id and a.status in ('SIGNED', 'BROADCAST', 'CONFIRMED') order by a.seq desc limit 1) as txid
      from network_deposit_withdrawal w
     where w.trader_id = ${traderId}
     order by w.requested_at desc
     limit 20`.execute(ex);
  const history = [
    ...entries.map((e) => ({
      kind: e.kind as 'DEPOSIT' | 'ADJUSTMENT', amount: trx(e.amount_sun), status: e.kind === 'DEPOSIT' ? 'CREDITED' : e.amount_sun < 0n ? 'DEBITED' : 'CREDITED',
      at: e.created_at.toISOString(), txHash: e.tx_hash, note: e.kind === 'ADJUSTMENT' ? e.note : null,
    })),
    ...withdrawals.rows.map((w) => ({ kind: 'WITHDRAWAL' as const, amount: formatTrx(BigInt(w.amount_sun)), status: w.status, at: (w.closed_at ?? w.requested_at).toISOString(), txHash: w.txid, note: null })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));

  const view: TraderNetworkView = {
    balance: formatTrx(f.balanceSun),
    held: formatTrx(f.heldSun),
    inFlight: formatTrx(f.inFlightSun),
    withdrawing: formatTrx(f.withdrawingSun),
    available: formatTrx(f.availableSun > 0n ? f.availableSun : 0n),
    perOrder,
    perOrderNeed: need > 0n ? formatTrx(need) : null,
    ordersCovered: need > 0n ? Number.parseInt(((f.availableSun > 0n ? f.availableSun : 0n) / need).toString(), 10) : null,
    short: perOrder === null || (need > 0n && f.availableSun < need),
    depositAddress: wallet?.address ?? null,
    registeredWallet: profile.address,
    withdrawal: open
      ? { id: open.id, ref: open.ref, amount: formatTrx(open.amount_sun), fee: formatTrx(open.fee_estimate_sun), status: open.status as 'REQUESTED' | 'APPROVED', askedAt: open.requested_at.toISOString() }
      : null,
    orders,
    repaidInrTotal: Money.ofMinor(BigInt(repaid.rows[0]!.total), 'INR').toDecimalString(),
    history,
  };
  assertTraderSafe(view);
  return view;
}

/** The signed-in person's trader's network deposit, or null when their client is not a trader. */
export async function traderNetworkHome(ex: Executor, userId: string): Promise<TraderNetworkView | null> {
  const { member } = await traderApplicant(ex, userId);
  if (!member) return null;
  const t = await ex.selectFrom('trader_profile').select('id').where('client_id', '=', member.clientId).executeTakeFirst();
  return t ? traderNetworkView(ex, t.id) : null;
}
