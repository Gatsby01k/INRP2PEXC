import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import { istToday, pnlPage } from '../src/index.ts';
import { type World, createWorld, openTrade, payClient, settleFirstLeg } from '../../settlement/test/world.ts';

/**
 * Phase 8 exit: **P&L equals ledger revenue.**
 *
 * The page is allowed to sum the trades it lists — that is what makes a row-level P&L readable — but the figure it reports
 * as realized is the ledger's, and the two have to agree. This test settles one deal to completion and leaves another open,
 * then holds the page against the ledger directly. It also checks the part that is easy to get wrong and expensive to get
 * wrong: the open deal's expected margin never reaches the realized figure, because a forecast is not revenue (FI-43, FI-44).
 */
let w: World;
let day = '';
let completedRef = '';
let openRef = '';
let margin = 0n;

beforeAll(async () => {
  w = await createWorld('desk_pnl');
  day = await istToday(w.app);

  const done = await openTrade(w, { baseUsdt: '1000', clientRate: '102.000000' });
  completedRef = done.tradeRef;
  await settleFirstLeg(w, done.tradeId);
  await payClient(w, done);
  margin = (await w.app.selectFrom('trade_economics').select('gross_margin_base_minor').where('trade_id', '=', done.tradeId).executeTakeFirstOrThrow()).gross_margin_base_minor!;

  const pending = await openTrade(w, { baseUsdt: '500', clientRate: '102.000000' });
  openRef = pending.tradeRef;
});
afterAll(async () => w.close());

describe('the P&L page', () => {
  it('reports the ledger’s realized margin, in USDT, and says so on its face', async () => {
    const revenue = await sql<{ net: string }>`
      select coalesce(sum(case e.direction when 'CR' then e.amount_minor else -e.amount_minor end), 0)::text as net
      from ledger_entry e
      join ledger_account a on a.id = e.account_id
      join ledger_journal j on j.id = e.journal_id
      where a.code in ('REVENUE:GROSS_MARGIN', 'REVENUE:PLATFORM_FEE') and a.currency = 'USDT' and j.posting_key like 'trade:%:complete'
        and (j.posted_at AT TIME ZONE 'Asia/Kolkata')::date = ${day}::date`.execute(w.app);
    const page = await pnlPage(w.app, { from: day, to: day });
    expect(page.ledgerCheck.ledgerUsdt).toBe(Money.ofMinor(BigInt(revenue.rows[0]!.net), 'USDT').toDecimalString());
    expect(page.ledgerCheck.tradesUsdt).toBe(page.ledgerCheck.ledgerUsdt);
    expect(page.ledgerCheck.agrees).toBe(true);
    // ₹102,000 buys the trader 990.291262 USDT at its 103: the 9.708738 between is the exchange's.
    expect(page.ledgerCheck.ledgerUsdt).toBe(Money.ofMinor(margin, 'USDT').toDecimalString());
    expect(margin).toBe(Money.parse('9.708738', 'USDT').minor);
  });

  it('keeps expected margin out of the realized figure', async () => {
    const page = await pnlPage(w.app, { from: day, to: day });
    expect(page.summary.openTrades).toBeGreaterThanOrEqual(1);
    const realized = Money.parse(page.summary.realizedMarginUsdt, 'USDT');
    const expected = Money.parse(page.summary.openExpectedMarginUsdt, 'USDT');
    expect(expected.isPositive()).toBe(true);
    expect(realized.minor).toBe(margin);
  });

  it('says of every row which kind of margin it is', async () => {
    const page = await pnlPage(w.app, { from: day, to: day });
    const done = page.rows.find((r) => r.tradeRef === completedRef);
    const pending = page.rows.find((r) => r.tradeRef === openRef);
    expect(done?.kind).toBe('realized');
    expect(done?.status).toBe('COMPLETED');
    expect(pending?.kind).toBe('expected');
    expect(pending?.status).not.toBe('COMPLETED');
    expect(done?.marginUsdt).toBe(Money.ofMinor(margin, 'USDT').toDecimalString());
    // The rows carry both rates, because this screen is behind `pnl:view` and exists to show the spread.
    expect(done?.routeRate).toBe('103.000000');
    expect(done?.clientRate).toBe('102.000000');
  });

  it('counts a completed trade in the period it completed in, and in no other', async () => {
    const before = await pnlPage(w.app, { from: shift(day, -30), to: shift(day, -1) });
    expect(before.summary.completedTrades).toBe(0);
    expect(before.summary.realizedMarginUsdt).toBe('0.000000');
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
