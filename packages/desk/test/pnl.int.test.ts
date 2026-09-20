import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import { runAs } from '@inrp2p/identity/testing';
import { confirmPayout, createPayoutLeg, recordLegEvidence, sendPayoutLeg } from '@inrp2p/settlement';
import { istToday, pnlPage } from '../src/index.ts';
import { type World, createWorld, newUtr, openTrade, settleFirstLeg } from '../../settlement/test/world.ts';

/**
 * Phase 8 exit: **P&L equals ledger revenue.**
 *
 * The page is allowed to sum the trades it lists — that is what makes a row-level P&L readable — but the figure
 * it reports as realized is the ledger's, and the two have to agree. This test settles one trade to completion
 * and leaves another open, then holds the page against the ledger directly. It also checks the part that is
 * easy to get wrong and expensive to get wrong: the open trade's expected margin never reaches the realized
 * figure, because a forecast is not revenue (FI-43, FI-44).
 */
let w: World;
let day = '';
let completedRef = '';
let openRef = '';
let realizedMinor = 0n;

beforeAll(async () => {
  w = await createWorld('desk_pnl', { capacityInr: '500000000.00' });
  day = await istToday(w.app);

  const done = await openTrade(w, { baseUsdt: '1000', clientRate: '90.000000', routeRate: '92.500000', executionMode: 'TO_EXCHANGE' });
  completedRef = done.tradeRef;
  await settleFirstLeg(w, done.tradeId);
  const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', {
    tradeId: done.tradeId, amount: '90000.00', payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId,
  });
  await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
  await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', {
    legId: leg.legId, rail: 'IMPS' as const, utr: newUtr(),
  });
  await confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });

  const pending = await openTrade(w, { baseUsdt: '500', clientRate: '90.000000', routeRate: '92.500000', executionMode: 'TO_EXCHANGE' });
  openRef = pending.tradeRef;

  const revenue = await sql<{ net: string }>`
    select coalesce(sum(case e.direction when 'CR' then e.amount_minor else -e.amount_minor end), 0)::text as net
    from ledger_entry e
    join ledger_account a on a.id = e.account_id
    join ledger_journal j on j.id = e.journal_id
    where a.code = 'REVENUE:GROSS_MARGIN'
      and (j.posted_at AT TIME ZONE 'Asia/Kolkata')::date = ${day}::date`.execute(w.app);
  realizedMinor = BigInt(revenue.rows[0]!.net);
});
afterAll(async () => w.close());

describe('the P&L page', () => {
  it('reports the ledger’s realized margin, and says so on its face', async () => {
    const page = await pnlPage(w.app, { from: day, to: day });
    expect(page.summary.realizedGrossMargin).toBe(Money.ofMinor(realizedMinor, 'INR').toDecimalString());
    expect(page.ledgerCheck.ledger).toBe(page.summary.realizedGrossMargin);
    expect(page.ledgerCheck.trades).toBe(page.ledgerCheck.ledger);
    expect(page.ledgerCheck.agrees).toBe(true);
    // The completed trade made 2500 INR: 1000 USDT at a 2.50 spread between the client and route rates.
    expect(page.ledgerCheck.ledger).toBe('2500.00');
  });

  it('keeps expected margin out of the realized figure', async () => {
    const page = await pnlPage(w.app, { from: day, to: day });
    expect(page.summary.openTrades).toBeGreaterThanOrEqual(1);
    expect(Money.parse(page.summary.openExpectedMargin, 'INR').isPositive()).toBe(true);
    // Both are reported; neither is added to the other.
    const realized = Money.parse(page.summary.realizedGrossMargin, 'INR');
    const expected = Money.parse(page.summary.openExpectedMargin, 'INR');
    expect(realized.minor).toBe(realizedMinor);
    expect(realized.minor).not.toBe(realized.minor + expected.minor);
  });

  it('says of every row which kind of margin it is', async () => {
    const page = await pnlPage(w.app, { from: day, to: day });
    const done = page.rows.find((r) => r.tradeRef === completedRef);
    const pending = page.rows.find((r) => r.tradeRef === openRef);
    expect(done?.kind).toBe('realized');
    expect(done?.status).toBe('COMPLETED');
    expect(pending?.kind).toBe('expected');
    expect(pending?.status).not.toBe('COMPLETED');
    expect(done?.margin).toBe('2500.00');
    // The rows carry both rates, because this screen is behind `pnl:view` and exists to show the spread.
    expect(done?.routeRate).toBe('92.500000');
    expect(done?.clientRate).toBe('90.000000');
  });

  it('counts a completed trade in the period it completed in, and in no other', async () => {
    const before = await pnlPage(w.app, { from: shift(day, -30), to: shift(day, -1) });
    expect(before.summary.completedTrades).toBe(0);
    expect(before.summary.realizedGrossMargin).toBe('0.00');
    expect(before.rows.some((r) => r.tradeRef === completedRef)).toBe(false);
    // Open trades are not of a period at all: they are what is unfinished now, whichever window is being read.
    expect(before.rows.some((r) => r.tradeRef === openRef)).toBe(true);
    expect(before.ledgerCheck.agrees).toBe(true);
  });
});

function shift(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
