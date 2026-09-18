import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Db } from '@inrp2p/db';
import { executeCommand } from '@inrp2p/commands';
import { globalImbalance } from '@inrp2p/ledger';
import { lockTrade } from '@inrp2p/trades';
import { openExceptionInTx } from './exceptions.ts';
import { routeObligationMismatches } from './pnl.ts';

const SYSTEM = { type: 'SYSTEM' as const, id: null, surface: 'SYSTEM' as const };

function systemCommand<R>(db: Db, name: string, fn: Parameters<typeof executeCommand<{ run: string }, R>>[1]['handle']): Promise<R> {
  const key = randomUUID();
  return executeCommand(db, { authorize: async () => {}, handle: fn }, { name, actor: SYSTEM, payload: { run: key }, idempotencyKey: key, financial: false }).then((o) => o.result);
}

export interface ReconciliationReport {
  readonly routeMismatches: number;
  readonly currencyImbalances: readonly string[];
}

/**
 * Nightly reconciliation (FI-44, FI-64): the ledger must balance globally per currency, and every open route
 * obligation's remaining side must equal its ledger balance. Anything else opens a blocking case for FINANCE.
 */
export async function runReconciliation(db: Db): Promise<ReconciliationReport> {
  const imbalance = await globalImbalance(db);
  const mismatches = await routeObligationMismatches(db);
  if (mismatches.length) {
    await systemCommand(db, 'reconcile.route_obligations', async (ctx) => {
      for (const m of mismatches) {
        const o = await ctx.tx.selectFrom('route_obligation').select('trade_id').where('id', '=', m.routeObligationId).executeTakeFirst();
        if (o?.trade_id) await lockTrade(ctx.tx, o.trade_id);
        await openExceptionInTx(ctx, {
          type: 'RECONCILIATION_MISMATCH', subjectType: 'ROUTE_OBLIGATION', subjectId: m.routeObligationId, tradeId: o?.trade_id ?? null,
          details: { side: m.side, remaining: m.remaining, ledger: m.ledger },
        });
      }
      return mismatches.length;
    });
  }
  return { routeMismatches: mismatches.length, currencyImbalances: imbalance.map((i) => `${i.currency}:${i.net}`) };
}

/** SLA sweep: payouts that have been in flight too long, and route obligations older than the route's SLA. */
export async function runSettlementSla(db: Db, opts: { payoutMinutes?: number; obligationHours?: number } = {}): Promise<{ delayedPayouts: number; overdueObligations: number }> {
  const payoutMinutes = opts.payoutMinutes ?? 120;
  const obligationHours = opts.obligationHours ?? 48;
  const legs = await sql<{ id: string; trade_id: string }>`
    select l.id, l.trade_id from settlement_leg l
    where l.side = 'EXCHANGE_TO_CLIENT' and l.status = 'PROCESSING'
      and l.sent_at <= inrp2p_now() - make_interval(mins => ${payoutMinutes})
      and not exists (select 1 from exception_case e where e.type = 'INR_PAYOUT_DELAYED' and e.subject_id = l.id and e.status in ('OPEN', 'IN_PROGRESS'))
    order by l.sent_at limit 200`.execute(db);
  const obligations = await sql<{ id: string; trade_id: string | null }>`
    select o.id, o.trade_id from route_obligation o
    where o.status in ('OPEN', 'PARTIALLY_SETTLED')
      and o.opened_at <= inrp2p_now() - make_interval(hours => ${obligationHours})
      and not exists (select 1 from exception_case e where e.type = 'ROUTE_OBLIGATION_OVERDUE' and e.subject_id = o.id and e.status in ('OPEN', 'IN_PROGRESS'))
    order by o.opened_at limit 200`.execute(db);
  if (legs.rows.length === 0 && obligations.rows.length === 0) return { delayedPayouts: 0, overdueObligations: 0 };

  await systemCommand(db, 'settlement.sla_sweep', async (ctx) => {
    for (const l of legs.rows) {
      await lockTrade(ctx.tx, l.trade_id);
      await openExceptionInTx(ctx, { type: 'INR_PAYOUT_DELAYED', subjectType: 'SETTLEMENT_LEG', subjectId: l.id, tradeId: l.trade_id, details: { sla_minutes: payoutMinutes } });
    }
    for (const o of obligations.rows) {
      if (o.trade_id) await lockTrade(ctx.tx, o.trade_id);
      await openExceptionInTx(ctx, { type: 'ROUTE_OBLIGATION_OVERDUE', subjectType: 'ROUTE_OBLIGATION', subjectId: o.id, tradeId: o.trade_id, details: { sla_hours: obligationHours } });
    }
    return legs.rows.length + obligations.rows.length;
  });
  return { delayedPayouts: legs.rows.length, overdueObligations: obligations.rows.length };
}
