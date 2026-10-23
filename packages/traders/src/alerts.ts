import { p2pDeal } from '@inrp2p/settlement';
import type { Executor } from '@inrp2p/db';

/**
 * The P2P steps about to run out on the trader's side (docs/adr/0020-desks.md §2.14): orders in progress whose current
 * step is the trader's — fund the escrow, pay the rupees, confirm the rupees — and is due within `withinMinutes`. Only for
 * traders someone of whom linked a Telegram chat: nobody else would be told, so nothing else is read.
 */
export interface DueSoon {
  readonly orderId: string;
  readonly step: string;
  readonly dueBy: string;
}

export async function ordersDueSoon(ex: Executor, opts: { withinMinutes: number; now: Date; limit?: number }): Promise<DueSoon[]> {
  const candidates = await ex
    .selectFrom('trader_order as o')
    .innerJoin('trader_profile as t', 't.id', 'o.trader_id')
    .innerJoin('liquidity_route as r', 'r.id', 'o.route_id')
    .select(['o.id', 'o.side', 'o.trade_id'])
    .where('o.status', '=', 'IN_PROGRESS')
    .where('r.execution_mode', '=', 'P2P')
    .where('o.trade_id', 'is not', null)
    .where((eb) =>
      eb.exists(
        eb.selectFrom('telegram_link as l').innerJoin('client_user as cu', 'cu.id', 'l.client_user_id').select('l.id').whereRef('cu.client_id', '=', 't.client_id').where('l.status', '=', 'ACTIVE'),
      ),
    )
    .orderBy('o.started_at')
    .limit(opts.limit ?? 200)
    .execute();
  const out: DueSoon[] = [];
  for (const o of candidates) {
    const deal = await p2pDeal(ex, null, { tradeId: o.trade_id!, viewer: 'TRADER' });
    if (!deal?.dueBy || !deal.turn) continue;
    const traderIs = o.side === 'SELL_USDT' ? 'SELLER' : 'BUYER';
    if (deal.turn !== traderIs) continue;
    const left = Date.parse(deal.dueBy) - opts.now.getTime();
    if (left <= 0 || left > opts.withinMinutes * 60_000) continue;
    out.push({ orderId: o.id, step: deal.step, dueBy: deal.dueBy });
  }
  return out;
}
