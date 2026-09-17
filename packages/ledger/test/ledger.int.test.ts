import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money, Rate, computeTradeEconomics, type TradeEconomics } from '@inrp2p/kernel';
import { pgErrorCode } from '@inrp2p/db';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import {
  Accounts, accountBalance, globalImbalance, postJournal, reverseJournal, routeObligationBalances,
  tradeAcceptJournal, tradeBalances, tradeCancelReversal, tradeCompleteJournal,
} from '../src/index.ts';
import { inCommand } from './support.ts';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('ledger');
});
afterAll(async () => t.close());

const inr = (a: string) => Money.parse(a, 'INR');
const usdt = (a: string) => Money.parse(a, 'USDT');

function sell(client = '102.00', route = '104.20', amount = '100000'): TradeEconomics {
  return computeTradeEconomics({ direction: 'SELL_USDT', fixedSide: 'BASE', amount: usdt(amount), clientRate: Rate.parse(client, 'CLIENT'), routeRate: Rate.parse(route, 'ROUTE') });
}
function buy(client = '102.00', route = '100.00', amount = '100000'): TradeEconomics {
  return computeTradeEconomics({ direction: 'BUY_USDT', fixedSide: 'BASE', amount: usdt(amount), clientRate: Rate.parse(client, 'CLIENT'), routeRate: Rate.parse(route, 'ROUTE') });
}
function refs() {
  return { tradeId: randomUUID(), clientId: randomUUID(), routeId: randomUUID(), routeObligationId: randomUUID() };
}

describe('balanced journal enforcement (FI-40)', () => {
  it('rejects an unbalanced journal in the application before touching the database', async () => {
    await expect(
      inCommand(t.app, 'test.ledger', (ctx) =>
        postJournal(ctx, {
          postingKey: `test:${randomUUID()}:unbalanced`, eventType: 'test.unbalanced',
          entries: [
            { account: Accounts.suspenseUnallocated('INR'), direction: 'DR', amount: inr('100.00') },
            { account: Accounts.fees('INR'), direction: 'CR', amount: inr('99.99') },
          ],
        })),
    ).rejects.toMatchObject({ code: 'UNBALANCED_JOURNAL' });
  });

  it('the database rejects an unbalanced journal at commit even when application checks are bypassed', async () => {
    await inCommand(t.app, 'test.ledger', (ctx) =>
      postJournal(ctx, {
        postingKey: `test:${randomUUID()}:seed`, eventType: 'test.seed',
        entries: [
          { account: Accounts.suspenseUnallocated('INR'), direction: 'DR', amount: inr('1.00') },
          { account: Accounts.fees('INR'), direction: 'CR', amount: inr('1.00') },
        ],
      }));
    const ids = await t.app.selectFrom('ledger_account').select(['id', 'code']).where('currency', '=', 'INR').where('code', 'in', ['SUSPENSE:UNALLOCATED', 'EXPENSE:FEES']).execute();
    const suspense = ids.find((r) => r.code === 'SUSPENSE:UNALLOCATED')!.id;
    const fees = ids.find((r) => r.code === 'EXPENSE:FEES')!.id;
    const journalId = randomUUID();
    await expect(
      t.app.transaction().execute(async (tx) => {
        await sql`insert into ledger_journal (id, posting_key, event_type, correlation_id, idempotency_key, posted_by) values (${journalId}, ${`raw:${journalId}:post`}, 'test.raw', 'corr-raw-000', 'key-raw-000', 'test')`.execute(tx);
        await sql`insert into ledger_entry (journal_id, account_id, currency, direction, amount_minor) values (${journalId}, ${suspense}, 'INR', 'DR', 1000), (${journalId}, ${fees}, 'INR', 'CR', 999)`.execute(tx);
      }),
    ).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX012');
    expect(await t.app.selectFrom('ledger_journal').select('id').where('id', '=', journalId).execute()).toHaveLength(0);
  });

  it('the database rejects a journal with fewer than two entries', async () => {
    const id = randomUUID();
    await expect(
      t.owner.transaction().execute(async (tx) => {
        await sql`insert into ledger_journal (id, posting_key, event_type, correlation_id, idempotency_key, posted_by) values (${id}, ${`raw:${id}:empty`}, 'test.raw', 'corr-raw-001', 'key-raw-001', 'test')`.execute(tx);
      }),
    ).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX011');
  });

  it('entries cannot be appended to a journal after its transaction committed', async () => {
    const posted = await inCommand(t.app, 'test.ledger', (ctx) =>
      postJournal(ctx, {
        postingKey: `test:${randomUUID()}:ok`, eventType: 'test.ok',
        entries: [
          { account: Accounts.suspenseUnallocated('USDT'), direction: 'DR', amount: usdt('5') },
          { account: Accounts.fees('USDT'), direction: 'CR', amount: usdt('5') },
        ],
      }));
    const accountId = (await t.app.selectFrom('ledger_account').select('id').where('code', '=', 'EXPENSE:FEES').where('currency', '=', 'USDT').executeTakeFirstOrThrow()).id;
    await expect(
      sql`insert into ledger_entry (journal_id, account_id, currency, direction, amount_minor) values (${posted.id}, ${accountId}, 'USDT', 'DR', 1)`.execute(t.app),
    ).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX010');
  });

  it('rejects entries whose currency differs from the account currency', async () => {
    await expect(
      inCommand(t.app, 'test.ledger', (ctx) =>
        postJournal(ctx, {
          postingKey: `test:${randomUUID()}:ccy`, eventType: 'test.ccy',
          entries: [
            { account: Accounts.fees('INR'), direction: 'DR', amount: usdt('1') },
            { account: Accounts.fees('USDT'), direction: 'CR', amount: usdt('1') },
          ],
        })),
    ).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });
  });

  it('a posting key posts at most once (FI-42)', async () => {
    const key = `test:${randomUUID()}:once`;
    const input = {
      postingKey: key, eventType: 'test.once',
      entries: [
        { account: Accounts.suspenseUnallocated('INR'), direction: 'DR' as const, amount: inr('1.00') },
        { account: Accounts.fees('INR'), direction: 'CR' as const, amount: inr('1.00') },
      ],
    };
    await inCommand(t.app, 'test.ledger', (ctx) => postJournal(ctx, input));
    await expect(inCommand(t.app, 'test.ledger', (ctx) => postJournal(ctx, input))).rejects.toMatchObject({ code: 'DUPLICATE_POSTING_KEY' });
  });

  it('refuses to post outside a financial command (no idempotency key)', async () => {
    await expect(
      t.app.transaction().execute((tx) =>
        postJournal({ tx, actor: { type: 'SYSTEM', id: null, surface: 'SYSTEM' }, correlationId: 'corr-0000001', idempotencyKey: null, commandName: 'x' }, {
          postingKey: `test:${randomUUID()}:nokey`, eventType: 'test.nokey',
          entries: [
            { account: Accounts.fees('INR'), direction: 'DR', amount: inr('1') },
            { account: Accounts.suspenseUnallocated('INR'), direction: 'CR', amount: inr('1') },
          ],
        })),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  });
});

describe('append-only ledger and DB-level mutation rejection (FI-41)', () => {
  it.each(['ledger_journal', 'ledger_entry', 'ledger_account'])('%s rejects UPDATE and DELETE even for the owner', async (table) => {
    await expect(sql`update ${sql.table(table)} set ${sql.ref(table === 'ledger_entry' ? 'direction' : table === 'ledger_account' ? 'code' : 'event_type')} = ${table === 'ledger_entry' ? 'DR' : table === 'ledger_account' ? 'EXPENSE:FEES' : 'test.tampered'}`.execute(t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX001');
    await expect(sql`delete from ${sql.table(table)}`.execute(t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX001');
    await expect(sql`truncate ${sql.table(table)} cascade`.execute(t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX001');
  });

  it.each(['ledger_journal', 'ledger_entry', 'ledger_account'])('%s: application role has no UPDATE/DELETE privilege at all', async (table) => {
    await expect(sql`delete from ${sql.table(table)}`.execute(t.app)).rejects.toSatisfy((e) => pgErrorCode(e) === '42501');
  });
});

describe('trade acceptance journal and cancellation reversal — nothing orphaned', () => {
  async function acceptAndCancel(econ: TradeEconomics) {
    const r = refs();
    const accept = tradeAcceptJournal(econ, r);
    await inCommand(t.app, 'test.trade_accept', (ctx) => postJournal(ctx, accept));
    return r;
  }

  it('SELL canonical: acceptance recognizes client, route and deferred margin; cancellation reverses every line to zero', async () => {
    const econ = sell();
    const r = await acceptAndCancel(econ);

    const afterAccept = await tradeBalances(t.app, r.tradeId);
    const byCode = Object.fromEntries(afterAccept.map((b) => [`${b.code.split(':').slice(0, 2).join(':')}|${b.currency}`, b.net]));
    expect(byCode).toEqual({
      'ASSET:CLIENT_RECEIVABLE|USDT': 100_000_000_000n,
      'LIAB:ROUTE_PAYABLE|USDT': -100_000_000_000n,
      'ASSET:ROUTE_RECEIVABLE|INR': 1_042_000_000n,
      'LIAB:CLIENT_PAYABLE|INR': -1_020_000_000n,
      'LIAB:DEFERRED_MARGIN|INR': -22_000_000n,
    });
    expect(await routeObligationBalances(t.app, r.routeObligationId)).toHaveLength(2);

    await inCommand(t.app, 'test.trade_cancel', (ctx) => reverseJournal(ctx, tradeCancelReversal(r.tradeId)));

    expect(await tradeBalances(t.app, r.tradeId)).toEqual([]);
    expect(await routeObligationBalances(t.app, r.routeObligationId)).toEqual([]);
    expect(await accountBalance(t.app, Accounts.routeReceivable(r.routeId, 'INR'))).toBe(0n);
    expect(await accountBalance(t.app, Accounts.routePayable(r.routeId, 'USDT'))).toBe(0n);
    expect(await globalImbalance(t.app)).toEqual([]);
  });

  it('BUY: route payable/receivable and deferred margin are fully reversed on cancellation', async () => {
    const r = await acceptAndCancel(buy());
    const accepted = await tradeBalances(t.app, r.tradeId);
    expect(accepted.find((b) => b.code === 'LIAB:DEFERRED_MARGIN')?.net).toBe(-20_000_000n);
    expect(accepted.find((b) => b.code.startsWith('LIAB:ROUTE_PAYABLE'))?.net).toBe(-1_000_000_000n);
    expect(accepted.find((b) => b.code.startsWith('ASSET:ROUTE_RECEIVABLE'))?.net).toBe(100_000_000_000n);

    await inCommand(t.app, 'test.trade_cancel', (ctx) => reverseJournal(ctx, tradeCancelReversal(r.tradeId)));
    expect(await tradeBalances(t.app, r.tradeId)).toEqual([]);
    expect(await routeObligationBalances(t.app, r.routeObligationId)).toEqual([]);
  });

  it('negative-margin acceptance (debit deferred margin) is also fully reversed', async () => {
    const r = await acceptAndCancel(sell('105.00', '104.20', '1000'));
    expect((await tradeBalances(t.app, r.tradeId)).find((b) => b.code === 'LIAB:DEFERRED_MARGIN')?.net).toBe(80_000n);
    await inCommand(t.app, 'test.trade_cancel', (ctx) => reverseJournal(ctx, tradeCancelReversal(r.tradeId)));
    expect(await tradeBalances(t.app, r.tradeId)).toEqual([]);
  });

  it('zero-margin acceptance omits the margin line and still reverses cleanly', async () => {
    const r = await acceptAndCancel(sell('104.20', '104.20', '10'));
    expect((await tradeBalances(t.app, r.tradeId)).some((b) => b.code === 'LIAB:DEFERRED_MARGIN')).toBe(false);
    await inCommand(t.app, 'test.trade_cancel', (ctx) => reverseJournal(ctx, tradeCancelReversal(r.tradeId)));
    expect(await tradeBalances(t.app, r.tradeId)).toEqual([]);
  });

  it('a cancellation can be posted only once — no double reversal', async () => {
    const r = await acceptAndCancel(sell());
    const cancel = tradeCancelReversal(r.tradeId);
    await inCommand(t.app, 'test.trade_cancel', (ctx) => reverseJournal(ctx, cancel));
    await expect(inCommand(t.app, 'test.trade_cancel', (ctx) => reverseJournal(ctx, { ...cancel, postingKey: `trade:${r.tradeId}:cancel_again` })))
      .rejects.toMatchObject({ code: 'JOURNAL_ALREADY_REVERSED' });
    expect(await tradeBalances(t.app, r.tradeId)).toEqual([]);
  });

  it('a reversal cannot itself be reversed (which would resurrect orphaned route/margin balances)', async () => {
    const r = await acceptAndCancel(sell());
    await inCommand(t.app, 'test.trade_cancel', (ctx) => reverseJournal(ctx, tradeCancelReversal(r.tradeId)));
    await expect(inCommand(t.app, 'test.x', (ctx) => reverseJournal(ctx, { originalPostingKey: `trade:${r.tradeId}:cancel`, postingKey: `trade:${r.tradeId}:uncancel`, eventType: 'trade.uncancelled' })))
      .rejects.toMatchObject({ code: 'REVERSAL_OF_REVERSAL' });
  });

  it('the database rejects a partial "reversal" that would leave route receivable or deferred margin orphaned', async () => {
    const r = await acceptAndCancel(sell());
    const original = await t.app.selectFrom('ledger_journal').select('id').where('posting_key', '=', `trade:${r.tradeId}:accept`).executeTakeFirstOrThrow();
    const lines = await t.app.selectFrom('ledger_entry').selectAll().where('journal_id', '=', original.id).execute();
    const partialId = randomUUID();
    // Reverse only the client lines (balanced per currency by itself), omitting route and margin.
    const usdtClient = lines.find((l) => l.currency === 'USDT' && l.direction === 'DR')!;
    const usdtRoute = lines.find((l) => l.currency === 'USDT' && l.direction === 'CR')!;
    await expect(
      t.app.transaction().execute(async (tx) => {
        await sql`insert into ledger_journal (id, posting_key, event_type, trade_id, correlation_id, idempotency_key, posted_by, reverses_journal_id)
                  values (${partialId}, ${`trade:${r.tradeId}:cancel`}, 'trade.cancelled', ${r.tradeId}, 'corr-partial', 'key-partial', 'test', ${original.id})`.execute(tx);
        await sql`insert into ledger_entry (journal_id, account_id, currency, direction, amount_minor, trade_id, route_obligation_id)
                  values (${partialId}, ${usdtClient.account_id}, 'USDT', 'CR', ${usdtClient.amount_minor}, ${r.tradeId}, null),
                         (${partialId}, ${usdtRoute.account_id}, 'USDT', 'DR', ${usdtRoute.amount_minor}, ${r.tradeId}, ${r.routeObligationId})`.execute(tx);
      }),
    ).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX014');
    // The accept journal is still intact and unreversed.
    expect((await tradeBalances(t.app, r.tradeId)).length).toBe(5);
  });

  it('completion moves deferred margin into realized gross margin; route receivable remains on the obligation', async () => {
    const econ = sell();
    const r = refs();
    await inCommand(t.app, 'test.trade_accept', (ctx) => postJournal(ctx, tradeAcceptJournal(econ, r)));
    await inCommand(t.app, 'test.trade_complete', (ctx) => postJournal(ctx, tradeCompleteJournal(econ, r)!));
    const b = await tradeBalances(t.app, r.tradeId);
    expect(b.find((x) => x.code === 'LIAB:DEFERRED_MARGIN')).toBeUndefined();
    expect(b.find((x) => x.code === 'REVENUE:GROSS_MARGIN')?.net).toBe(-22_000_000n);
    expect(tradeCompleteJournal(sell('104.20', '104.20', '1'), r)).toBeNull();
    expect(await globalImbalance(t.app)).toEqual([]);
  });
});
