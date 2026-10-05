import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Money } from '@inrp2p/kernel';
import { movementJournal } from '../src/rules/movement.ts';
import { assertBalanced } from '../src/posting.ts';

/** The posting table for a trader's reserve applied to its own undelivered USDT (TD-21, FINANCIAL_INVARIANTS §3.4). */
describe('TRADER_RESERVE_APPLIED', () => {
  const traderId = randomUUID();
  const routeId = randomUUID();
  const routeObligationId = randomUUID();
  const movementId = randomUUID();
  const amount = Money.parse('500', 'USDT');
  const base = { kind: 'CRYPTO' as const, movementId, amount, from: { kind: 'TRADER' as const, traderId }, to: { kind: 'ROUTE' as const, routeId, routeObligationId }, tradeId: randomUUID(), purpose: 'TRADER_RESERVE_APPLIED' as const };
  const lines = (j: ReturnType<typeof movementJournal>) => j.entries.map((e) => `${e.direction} ${e.account.code}`);

  it('within one treasury wallet: the debt to the trader and the route receivable shrink together, once', () => {
    const wallet = randomUUID();
    const j = movementJournal({ ...base, custody: { fromWalletId: wallet, toWalletId: wallet } });
    expect(j.postingKey).toBe(`crypto:${movementId}:confirm`);
    expect(lines(j)).toEqual([`DR LIAB:TRADER_RESERVE:${traderId}`, `CR ASSET:ROUTE_RECEIVABLE:${routeId}`]);
    expect(j.entries[1]!.routeObligationId).toBe(routeObligationId);
    expect(() => assertBalanced(j.entries)).not.toThrow();
  });

  it('between two treasury wallets: the custody move is in the same journal, and the treasury total is unchanged', () => {
    const from = randomUUID();
    const to = randomUUID();
    const j = movementJournal({ ...base, custody: { fromWalletId: from, toWalletId: to } });
    expect(lines(j)).toEqual([
      `DR LIAB:TRADER_RESERVE:${traderId}`, `CR ASSET:ROUTE_RECEIVABLE:${routeId}`, `DR ASSET:TREASURY_USDT:${to}`, `CR ASSET:TREASURY_USDT:${from}`,
    ]);
    expect(() => assertBalanced(j.entries)).not.toThrow();
  });

  it('is refused for anything but USDT from the trader to its route obligation, moved between exchange wallets', () => {
    const custody = { fromWalletId: randomUUID(), toWalletId: randomUUID() };
    expect(() => movementJournal({ ...base })).toThrow(/moved between exchange wallets/);
    expect(() => movementJournal({ ...base, amount: Money.parse('500', 'INR'), custody })).toThrow(/USDT/);
    expect(() => movementJournal({ ...base, from: { kind: 'EXCHANGE_TREASURY', walletId: randomUUID() }, custody })).toThrow(/from the trader/);
    expect(() => movementJournal({ ...base, to: { kind: 'CLIENT', clientId: randomUUID() }, custody })).toThrow(/route obligation/);
  });
});
