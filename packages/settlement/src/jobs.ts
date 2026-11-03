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
  /** Cases that could not be opened this run: each is tried again next run, never in front of the others. */
  readonly failures: readonly { readonly subjectId: string; readonly message: string }[];
}

const failureOf = (subjectId: string, e: unknown) => ({ subjectId, message: (e instanceof Error ? e.message : String(e)).slice(0, 300) });

/**
 * Nightly reconciliation (FI-44, FI-64): the ledger must balance globally per currency, and every open route
 * obligation's remaining side must equal its ledger balance. Anything else opens a blocking case for FINANCE.
 */
export async function runReconciliation(db: Db): Promise<ReconciliationReport> {
  const imbalance = await globalImbalance(db);
  const mismatches = await routeObligationMismatches(db);
  // One case per step: an obligation whose case cannot be opened never keeps the others from theirs.
  const failures: { subjectId: string; message: string }[] = [];
  for (const m of mismatches) {
    try {
      await systemCommand(db, 'reconcile.route_obligation', async (ctx) => {
        const o = await ctx.tx.selectFrom('route_obligation').select('trade_id').where('id', '=', m.routeObligationId).executeTakeFirst();
        if (o?.trade_id) await lockTrade(ctx.tx, o.trade_id);
        await openExceptionInTx(ctx, {
          type: 'RECONCILIATION_MISMATCH', subjectType: 'ROUTE_OBLIGATION', subjectId: m.routeObligationId, tradeId: o?.trade_id ?? null,
          details: { side: m.side, remaining: m.remaining, ledger: m.ledger },
        });
      });
    } catch (e) {
      failures.push(failureOf(m.routeObligationId, e));
    }
  }
  return { routeMismatches: mismatches.length, currencyImbalances: imbalance.map((i) => `${i.currency}:${i.net}`), failures };
}

/** SLA sweep: payouts that have been in flight too long, and route obligations older than the route's SLA. */
export async function runSettlementSla(
  db: Db,
  opts: { payoutMinutes?: number; obligationHours?: number } = {},
): Promise<{ delayedPayouts: number; overdueObligations: number; failures: readonly { readonly subjectId: string; readonly message: string }[] }> {
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
  // One case per step, each under its own trade's lock: one that cannot be opened never keeps the others from theirs.
  const failures: { subjectId: string; message: string }[] = [];
  for (const l of legs.rows) {
    try {
      await systemCommand(db, 'settlement.sla_payout', async (ctx) => {
        await lockTrade(ctx.tx, l.trade_id);
        await openExceptionInTx(ctx, { type: 'INR_PAYOUT_DELAYED', subjectType: 'SETTLEMENT_LEG', subjectId: l.id, tradeId: l.trade_id, details: { sla_minutes: payoutMinutes } });
      });
    } catch (e) {
      failures.push(failureOf(l.id, e));
    }
  }
  for (const o of obligations.rows) {
    try {
      await systemCommand(db, 'settlement.sla_obligation', async (ctx) => {
        if (o.trade_id) await lockTrade(ctx.tx, o.trade_id);
        await openExceptionInTx(ctx, { type: 'ROUTE_OBLIGATION_OVERDUE', subjectType: 'ROUTE_OBLIGATION', subjectId: o.id, tradeId: o.trade_id, details: { sla_hours: obligationHours } });
      });
    } catch (e) {
      failures.push(failureOf(o.id, e));
    }
  }
  return { delayedPayouts: legs.rows.length, overdueObligations: obligations.rows.length, failures };
}
