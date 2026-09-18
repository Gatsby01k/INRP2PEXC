import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import { DomainError } from '@inrp2p/kernel';
import { runAs } from '@inrp2p/identity/testing';
import {
  approveAdjustment, cancelPayoutLeg, confirmPayout, confirmRouteSettlement, createPayoutLeg, failPayoutLeg, recordLegEvidence,
  recordRouteSettlement, requestAdjustment, routeObligationMismatches, sendPayoutLeg,
} from '../src/index.ts';
import { createWorld, newUtr, openTrade, settleFirstLeg, type World } from './world.ts';

let w: World;
beforeAll(async () => { w = await createWorld('settlement_properties', { capacityInr: '900000000.00' }); });
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

interface TradeCtx {
  readonly tradeId: string;
  readonly routeObligationId: string;
  readonly direct: boolean;
  readonly payoutAsset: 'INR' | 'USDT';
}

const expectedFailures = new Set([
  'OVER_ALLOCATION', 'ROUTE_OVER_ALLOCATION', 'ROUTE_DIRECT_PAYOUT_MISMATCH', 'TRADE_ON_HOLD', 'INVALID_TRANSITION', 'INVALID_AMOUNT',
  'CAPACITY_INSUFFICIENT', 'NOT_FOUND', 'DUPLICATE_UTR', 'UTR_REQUIRED', 'SECOND_APPROVER_REQUIRED', 'ROUTE_PAYER_NOT_ALLOWED',
  'PAYOUT_ALREADY_CONFIRMED', 'FUNDS_ALREADY_RECEIVED', 'TRANSFER_NOT_CONFIRMED', 'DESTINATION_CHANGED',
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
  it('exit 12: FI-20, FI-21, FI-27, FI-28, FI-30, FI-40 and FI-64 hold after a random mix of movements', async () => {
    const random = rng(20260918);
    const trades: TradeCtx[] = [];
    for (let i = 0; i < 4; i++) {
      const direct = i % 2 === 0;
      const sell = i < 3;
      const trade = await openTrade(w, {
        direction: sell ? 'SELL_USDT' : 'BUY_USDT',
        executionMode: direct ? 'DIRECT_TO_CLIENT' : 'TO_EXCHANGE',
        baseUsdt: String(100 * (i + 1)),
        clientRate: sell ? '102.000000' : '106.000000',
        routeRate: '104.200000',
      });
      await settleFirstLeg(w, trade.tradeId);
      trades.push({ tradeId: trade.tradeId, routeObligationId: trade.routeObligationId, direct, payoutAsset: sell ? 'INR' : 'USDT' });
    }

    const pending: { legId: string; asset: 'INR' | 'USDT' }[] = [];
    for (let step = 0; step < 40; step++) {
      const t = trades[Math.floor(random() * trades.length)]!;
      const roll = random();
      if (roll < 0.35) {
        // Create a payout leg of a random slice of what is still unpaid.
        const remaining = await sql<{ remaining: string }>`
          select (inrp2p_trade_payout_obligation(${t.tradeId})
                  - coalesce((select sum(amount_minor) from settlement_leg
                              where trade_id = ${t.tradeId} and side = 'EXCHANGE_TO_CLIENT' and status in ('PENDING','PROCESSING','COMPLETED')), 0))::text as remaining`.execute(w.app);
        const left = BigInt(remaining.rows[0]!.remaining);
        if (left <= 0n) continue;
        const slice = left === 1n ? left : BigInt(Math.max(1, Math.floor(Number(left) * (0.2 + random() * 0.8))));
        const payer = t.direct && random() < 0.6 ? ('ROUTE' as const) : ('EXCHANGE_ACCOUNT' as const);
        await attempt(async () => {
          const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', {
            tradeId: t.tradeId,
            amount: Money.ofMinor(slice, t.payoutAsset).toDecimalString(),
            payer,
            ...(payer === 'EXCHANGE_ACCOUNT' ? (t.payoutAsset === 'INR' ? { inrAccountId: w.inrAccountId } : { treasuryWalletId: w.treasuryWalletId }) : {}),
          });
          pending.push({ legId: leg.legId, asset: t.payoutAsset });
        });
      } else if (roll < 0.75 && pending.length) {
        const index = Math.floor(random() * pending.length);
        const leg = pending[index]!;
        await attempt(async () => {
          await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
          if (leg.asset === 'INR') {
            await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, rail: 'IMPS' as const, utr: newUtr() });
          } else {
            const row = await w.app.selectFrom('settlement_leg').select(['amount_minor', 'destination_wallet_id']).where('id', '=', leg.legId).executeTakeFirstOrThrow();
            const treasury = await w.app.selectFrom('treasury_wallet').select('address').where('id', '=', w.treasuryWalletId).executeTakeFirstOrThrow();
            const dest = await w.app.selectFrom('crypto_wallet').select('address').where('id', '=', row.destination_wallet_id!).executeTakeFirstOrThrow();
            const receipt = w.chain.add({ from: treasury.address, to: dest.address, amountMinor: row.amount_minor });
            await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, txHash: receipt.txHash, logIndex: receipt.logIndex, fromAddress: treasury.address });
          }
          if (random() < 0.8) {
            await confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });
          } else {
            await runAs(w.app, failPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.fail', { legId: leg.legId, reason: 'random sequence: the bank rejected this transfer' });
          }
        });
        pending.splice(index, 1);
      } else if (roll < 0.85 && pending.length) {
        const index = Math.floor(random() * pending.length);
        const leg = pending[index]!;
        await attempt(() => runAs(w.app, cancelPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.cancel', { legId: leg.legId, reason: 'random sequence: operator changed their mind' }));
        pending.splice(index, 1);
      } else if (roll < 0.95) {
        // A route settlement against a random slice of the route-delivers side.
        await attempt(async () => {
          const remaining = await sql<{ remaining: string; asset: string }>`
            select (o.route_delivers_minor - coalesce((select sum(amount_minor) from route_settlement_allocation
                    where route_obligation_id = o.id and side = 'ROUTE_DELIVERS'), 0))::text as remaining,
                   o.route_delivers_asset as asset
            from route_obligation o where o.id = ${t.routeObligationId}`.execute(w.app);
          const left = BigInt(remaining.rows[0]!.remaining);
          if (left <= 0n) return;
          const asset = remaining.rows[0]!.asset as 'INR' | 'USDT';
          const slice = BigInt(Math.max(1, Math.floor(Number(left) * (0.3 + random() * 0.7))));
          const treasury = await w.app.selectFrom('treasury_wallet').select('address').where('id', '=', w.treasuryWalletId).executeTakeFirstOrThrow();
          const route = await w.app.selectFrom('liquidity_route').select('registered_route_address').where('id', '=', w.routeId).executeTakeFirstOrThrow();
          const evidence =
            asset === 'INR'
              ? { rail: 'NEFT' as const, utr: newUtr('RS'), inrAccountId: w.inrAccountId }
              : (() => {
                  const receipt = w.chain.add({ from: route.registered_route_address!, to: treasury.address, amountMinor: slice });
                  return { txHash: receipt.txHash, logIndex: receipt.logIndex, fromAddress: route.registered_route_address!, treasuryWalletId: w.treasuryWalletId };
                })();
          const rs = await runAs(w.app, recordRouteSettlement(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'route_settlement.record', {
            routeObligationId: t.routeObligationId, flow: 'FROM_ROUTE_TO_EXCHANGE' as const, amount: Money.ofMinor(slice, asset).toDecimalString(), ...evidence,
          });
          if (random() < 0.85) await runAs(w.app, confirmRouteSettlement(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'route_settlement.confirm', { routeSettlementId: rs.routeSettlementId });
        });
      } else {
        // A small approved adjustment that raises what the client is owed.
        await attempt(async () => {
          const delta = t.payoutAsset === 'INR' ? { deltaClientInr: '100.00', deltaRouteInr: '100.00' } : { deltaBaseUsdt: '1', deltaClientInr: '0.00', deltaRouteInr: '0.00' };
          const requested = await runAs(w.app, requestAdjustment(w.financeOp.actor), w.financeOp.ref, 'adjustment.request', {
            tradeId: t.tradeId, type: 'AMOUNT_CORRECTION' as const, ...delta, reason: 'random sequence: agreed correction with the client',
          });
          await runAs(w.app, approveAdjustment(w.financeOp2.actor), w.financeOp2.ref, 'adjustment.approve', { adjustmentId: requested.adjustmentId });
        });
      }
    }

    // ---- FI-20 / FI-21: committed legs never exceed the effective obligation, and COMPLETED means settled.
    const tradeRows = await sql<{ id: string; state: string; payout: string; receivable: string; committed: string; paid: string; received: string }>`
      select t.id, t.lifecycle_state as state,
             inrp2p_trade_payout_obligation(t.id)::text as payout,
             inrp2p_trade_receivable_obligation(t.id)::text as receivable,
             coalesce((select sum(amount_minor) from settlement_leg where trade_id = t.id and side = 'EXCHANGE_TO_CLIENT' and status in ('PENDING','PROCESSING','COMPLETED')), 0)::text as committed,
             coalesce((select sum(amount_minor) from settlement_leg where trade_id = t.id and side = 'EXCHANGE_TO_CLIENT' and status = 'COMPLETED'), 0)::text as paid,
             coalesce((select sum(amount_minor) from settlement_leg where trade_id = t.id and side = 'CLIENT_TO_EXCHANGE' and status = 'COMPLETED'), 0)::text as received
      from trade t where t.id in (${sql.join(trades.map((t) => sql`${t.tradeId}`))})`.execute(w.app);
    for (const row of tradeRows.rows) {
      expect({ id: row.id, within: BigInt(row.committed) <= BigInt(row.payout) }).toEqual({ id: row.id, within: true });
      const settled = BigInt(row.paid) === BigInt(row.payout) && BigInt(row.received) === BigInt(row.receivable);
      expect({ id: row.id, completed: row.state === 'COMPLETED' }).toEqual({ id: row.id, completed: settled && row.state !== 'CANCELLED' });
    }

    // ---- FI-30: no account-day is over-committed and reserved equals the open reservations.
    const days = await sql<{ account_id: string; day: string; over: boolean; matches: boolean }>`
      select d.account_id, d.day::text as day,
             (d.used_minor + d.reserved_minor > d.capacity_minor) as over,
             (d.reserved_minor = coalesce((select sum(amount_minor - consumed_minor) from capacity_reservation r
                                           where r.account_id = d.account_id and r.day = d.day and r.status = 'ACTIVE'), 0)) as matches
      from inr_account_day d`.execute(w.app);
    for (const d of days.rows) expect({ day: d.day, over: d.over, matches: d.matches }).toEqual({ day: d.day, over: false, matches: true });

    // ---- FI-40 / FI-44: every journal balances per currency and the whole ledger nets to zero.
    const unbalanced = await sql<{ posting_key: string }>`
      select j.posting_key from ledger_journal j
      join ledger_entry e on e.journal_id = j.id
      group by j.posting_key, e.currency
      having sum(case e.direction when 'DR' then e.amount_minor else -e.amount_minor end) <> 0`.execute(w.app);
    expect(unbalanced.rows).toEqual([]);
    expect(await w.app.selectFrom('ledger_global_imbalance').selectAll().execute()).toEqual([]);

    // ---- FI-27: every confirmed movement posts exactly one journal, and unconfirmed ones post none.
    const movements = await sql<{ id: string; kind: string; status: string; journals: string }>`
      select f.id, 'FIAT' as kind, f.status,
             (select count(*) from ledger_journal j where j.posting_key = 'fiat:' || f.id || ':confirm')::text as journals
      from fiat_transfer f
      union all
      select c.id, 'CRYPTO', c.state,
             (select count(*) from ledger_journal j where j.posting_key = 'crypto:' || c.id || ':confirm')::text
      from crypto_transfer c`.execute(w.app);
    for (const m of movements.rows) {
      const expected = m.status === 'CONFIRMED' ? '1' : '0';
      expect({ id: m.id, kind: m.kind, journals: m.journals }).toEqual({ id: m.id, kind: m.kind, journals: expected });
    }

    // ---- exit 12: client payable reductions equal the CLIENT-dimension allocations of confirmed payouts,
    // and route receivable reductions equal the ROUTE-dimension allocations of confirmed settlements.
    for (const t of trades) {
      const paid = await sql<{ ledger: string; allocated: string }>`
        select
          coalesce((select sum(case e.direction when 'DR' then e.amount_minor else -e.amount_minor end)
                    from ledger_entry e join ledger_account a on a.id = e.account_id
                    where e.trade_id = ${t.tradeId} and a.code like 'LIAB:CLIENT_PAYABLE%'
                      and e.journal_id in (select id from ledger_journal where posting_key like 'fiat:%' or posting_key like 'crypto:%')), 0)::text as ledger,
          coalesce((select sum(al.amount_minor) from transfer_allocation al
                    join settlement_leg l on l.id = al.settlement_leg_id
                    where l.trade_id = ${t.tradeId} and l.side = 'EXCHANGE_TO_CLIENT' and l.status = 'COMPLETED' and al.voided_at is null), 0)::text as allocated`.execute(w.app);
      expect({ trade: t.tradeId, ledger: paid.rows[0]!.ledger }).toEqual({ trade: t.tradeId, ledger: paid.rows[0]!.allocated });

      const route = await sql<{ ledger: string; allocated: string }>`
        select
          coalesce((select sum(case e.direction when 'CR' then e.amount_minor else -e.amount_minor end)
                    from ledger_entry e join ledger_account a on a.id = e.account_id
                    where e.route_obligation_id = ${t.routeObligationId} and a.code like 'ASSET:ROUTE_RECEIVABLE%'
                      and e.journal_id in (select id from ledger_journal where posting_key like 'fiat:%' or posting_key like 'crypto:%')), 0)::text as ledger,
          coalesce((select sum(ra.amount_minor) from route_settlement_allocation ra
                    where ra.route_obligation_id = ${t.routeObligationId} and ra.side = 'ROUTE_DELIVERS'), 0)::text as allocated`.execute(w.app);
      expect({ obligation: t.routeObligationId, ledger: route.rows[0]!.ledger }).toEqual({ obligation: t.routeObligationId, ledger: route.rows[0]!.allocated });
    }

    // ---- FI-64: every obligation side still matches its ledger lines.
    expect(await routeObligationMismatches(w.app)).toEqual([]);
  });
});
