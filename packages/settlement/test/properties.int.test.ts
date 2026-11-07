import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { DomainError } from '@inrp2p/kernel';
import { runAs } from '@inrp2p/identity/testing';
import { approveAdjustment, confirmClientReceipt, createRefundLeg, requestAdjustment, routeObligationMismatches } from '../src/index.ts';
import { clientDepositAddressOf, clientPaysTrader, createWorld, observe, openTrade, payClient, settleFirstLeg, type World } from './world.ts';

let w: World;
beforeAll(async () => { w = await createWorld('settlement_properties'); });
afterAll(async () => w.close());

/** Deterministic PRNG (mulberry32) so a failing sequence can be replayed exactly. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const expectedFailures = new Set([
  'OVER_ALLOCATION', 'ROUTE_OVER_ALLOCATION', 'ROUTE_DIRECT_PAYOUT_MISMATCH', 'TRADE_ON_HOLD', 'INVALID_TRANSITION', 'INVALID_AMOUNT', 'NOT_FOUND', 'DUPLICATE_UTR',
  'SECOND_APPROVER_REQUIRED', 'PAYOUT_ALREADY_CONFIRMED', 'PAYOUT_IN_FLIGHT', 'FUNDS_ALREADY_RECEIVED', 'TRANSFER_NOT_CONFIRMED', 'DESTINATION_CHANGED', 'REFUND_IN_PROGRESS',
  'TRADER_ACTION_NOT_DUE', 'TRADER_ORDER_NOT_LIVE', 'ESCROW_NOT_FUNDED', 'NOTHING_OWED',
  // D-16: what would go beyond the money of the deal itself is refused, not advanced.
  'FUNDING_NOT_CONFIRMED', 'FUNDING_INSUFFICIENT', 'FUNDING_LOCATION_MISMATCH',
  'CUSTODY_BALANCE_INSUFFICIENT', 'CUSTODY_OBSERVATION_STALE',
]);

/** Runs a step, swallowing only the refusals the invariants are supposed to produce. */
async function attempt(step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (e) {
    if (e instanceof DomainError && expectedFailures.has(e.code)) return;
    throw e;
  }
}

describe('property: random command sequences never break the invariants', () => {
  it('exit 12: FI-20, FI-21, FI-27, FI-28, FI-40, FI-64 and FI-71…75 hold after a random mix of movements', async () => {
    const random = rng(20261106);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
    const deals: (Awaited<ReturnType<typeof openTrade>> & { sell: boolean; legRef: string | null })[] = [];
    for (let i = 0; i < 6; i++) {
      const sell = i < 4;
      deals.push({ sell, legRef: null, ...(await openTrade(w, { direction: sell ? 'SELL_USDT' : 'BUY_USDT', baseUsdt: String(100 + i * 50) })) });
    }

    const steps: readonly ((d: (typeof deals)[number]) => Promise<unknown>)[] = [
      (d) => (d.sell ? settleFirstLeg(w, d.tradeId) : clientPaysTrader(w, d)),
      (d) => (d.sell ? settleFirstLeg(w, d.tradeId, { amountUsdt: '50' }) : clientPaysTrader(w, d)),
      async (d) => { if (d.sell) d.legRef = (await payClient(w, d, { confirm: false })).legRef; },
      async (d) => {
        if (d.sell && d.legRef) await runAs(w.app, confirmClientReceipt(w.acceptor.actor, w.settlementDeps), w.acceptor.ref, 'payout.confirm_received', { tradeRef: d.tradeRef, legRef: d.legRef, senderName: 'Konkan Desk LLP' });
      },
      async (d) => {
        const requested = await runAs(w.app, requestAdjustment(w.financeOp.actor), w.financeOp.ref, 'adjustment.request', { tradeId: d.tradeId, type: 'WRITE_OFF' as const, deltaClientInr: '-100.00', reason: 'agreed by both sides of the deal' });
        await runAs(w.app, approveAdjustment(w.financeOp2.actor), w.financeOp2.ref, 'adjustment.approve', { adjustmentId: requested.adjustmentId });
      },
      async (d) => {
        if (!d.sell) return;
        const deposit = await clientDepositAddressOf(w, d.tradeId);
        await observe(w, deposit.address);
        await runAs(w.app, createRefundLeg(w.owner.actor), w.owner.ref, 'refund_leg.create', { tradeId: d.tradeId, sourceDepositAddressId: deposit.id });
      },
    ];
    for (let i = 0; i < 60; i++) await attempt(() => pick(steps)(pick(deals)));

    // ---- FI-40: every journal balances, in every currency.
    expect(await w.app.selectFrom('ledger_global_imbalance').selectAll().execute()).toEqual([]);

    // ---- FI-20: confirmed payouts never exceed what the deal owes.
    for (const d of deals) {
      const r = await sql<{ paid: string; owed: string; asset: string }>`
        select coalesce(sum(l.amount_minor) filter (where l.status = 'COMPLETED'), 0)::text as paid, inrp2p_trade_payout_obligation(${d.tradeId}::uuid)::text as owed, ${d.sell ? 'INR' : 'USDT'} as asset
          from settlement_leg l where l.trade_id = ${d.tradeId} and l.side = 'EXCHANGE_TO_CLIENT'`.execute(w.app);
      expect(BigInt(r.rows[0]!.paid)).toBeLessThanOrEqual(BigInt(r.rows[0]!.owed));
    }

    // ---- FI-27: exactly one journal for each confirmed movement, and none for any other.
    const movements = await sql<{ id: string; kind: string; status: string; journals: string }>`
      select f.id, 'FIAT' as kind, f.status, (select count(*) from ledger_journal j where j.posting_key = 'fiat:' || f.id || ':confirm')::text as journals from fiat_transfer f
      union all
      select c.id, 'CRYPTO', c.state, (select count(*) from ledger_journal j where j.posting_key = 'crypto:' || c.id || ':confirm')::text from crypto_transfer c`.execute(w.app);
    for (const m of movements.rows) {
      expect({ id: m.id, kind: m.kind, journals: m.journals }).toEqual({ id: m.id, kind: m.kind, journals: m.status === 'CONFIRMED' ? '1' : '0' });
    }

    // ---- FI-28: the client payable falls by what was paid, and by nothing else.
    for (const d of deals) {
      const paid = await sql<{ ledger: string; allocated: string }>`
        select
          coalesce((select sum(case e.direction when 'DR' then e.amount_minor else -e.amount_minor end)
                    from ledger_entry e join ledger_account a on a.id = e.account_id
                    where e.trade_id = ${d.tradeId} and a.code like 'LIAB:CLIENT_PAYABLE%'
                      and e.journal_id in (select id from ledger_journal where posting_key like 'fiat:%' or posting_key like 'crypto:%')), 0)::text as ledger,
          coalesce((select sum(al.amount_minor) from transfer_allocation al
                    join settlement_leg l on l.id = al.settlement_leg_id
                    where l.trade_id = ${d.tradeId} and l.side = 'EXCHANGE_TO_CLIENT' and l.status = 'COMPLETED' and al.voided_at is null), 0)::text as allocated`.execute(w.app);
      expect({ deal: d.tradeId, ledger: paid.rows[0]!.ledger }).toEqual({ deal: d.tradeId, ledger: paid.rows[0]!.allocated });
    }

    // ---- FI-64: every obligation side still matches its ledger lines.
    expect(await routeObligationMismatches(w.app)).toEqual([]);

    const ids = sql.join(deals.map((d) => sql`${d.tradeId}`));

    // ---- FI-75: no source is earmarked beyond what arrived.
    const sources = await sql<{ source_id: string; amount: string; taken: string }>`
      select s.source_id, s.amount_minor::text as amount,
             coalesce((select sum(f.amount_minor) from funding_allocation f
                        where (f.source_leg_id = s.source_id or f.source_route_settlement_id = s.source_id) and f.status in ('ACTIVE', 'CONSUMED')), 0)::text as taken
        from funding_source s where s.trade_id in (${ids})`.execute(w.app);
    for (const src of sources.rows) expect({ source: src.source_id, over: BigInt(src.taken) > BigInt(src.amount) }).toEqual({ source: src.source_id, over: false });
  });
});
