import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Rate } from '@inrp2p/kernel';
import { type FeePolicy, RESERVED_DESK_HANDLES, normalizeDeskHandle, priceDeskDeal } from '../src/desk.ts';

describe('the address of a desk’s page (inrp2p.com/<handle>)', () => {
  it('is trimmed and lower-cased', () => {
    expect(normalizeDeskHandle('  Rahul-OTC ')).toBe('rahul-otc');
    expect(normalizeDeskHandle('desk24')).toBe('desk24');
  });

  it('is 3 to 30 letters, digits and inner hyphens', () => {
    for (const bad of ['ab', 'a'.repeat(31), '-rahul', 'rahul-', 'rahul otc', 'rahul_otc', 'राहुल', '', 42]) {
      expect(() => normalizeDeskHandle(bad)).toThrow(expect.objectContaining({ code: 'DESK_HANDLE_INVALID' }));
    }
  });

  it('never takes one of the site’s own paths', () => {
    expect(RESERVED_DESK_HANDLES.has('usdt-to-inr')).toBe(true);
    for (const path of ['sign-in', 'usdt-to-inr', 'traders', 'api', 'www', 'public-desk', 'pnl', 'trader-desk']) {
      expect(() => normalizeDeskHandle(path)).toThrow(expect.objectContaining({ code: 'DESK_HANDLE_INVALID' }));
    }
  });

  it('is refused by the same list in the database', () => {
    const migration = readFileSync(new URL('../../db/migrations/0040_desks.sql', import.meta.url), 'utf8');
    const body = /inrp2p_desk_handle_reserved[\s\S]*?ARRAY\[([\s\S]*?)\]\)/.exec(migration)![1]!;
    const inDatabase = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(new Set(inDatabase)).toEqual(new Set(RESERVED_DESK_HANDLES));
    expect(inDatabase).toHaveLength(RESERVED_DESK_HANDLES.size);
  });
});

describe('pricing a desk’s deal on the fee policy', () => {
  const policy: FeePolicy = { id: '00000000-0000-7000-8000-000000000000', ownDealBps: 25, networkDealBps: 60, setAt: new Date(0) };

  it('uses the policy’s own-deal rate, on either side the request fixes', () => {
    const base = priceDeskDeal({ direction: 'SELL_USDT', fixedSide: 'BASE', amountMinor: 5_000_000_000n, clientRate: Rate.parse('101', 'CLIENT'), policy });
    expect(base.platformFeeBase.toDecimalString()).toBe('12.500000');
    expect(base.routeBase.toDecimalString()).toBe('4987.500000');
    const quote = priceDeskDeal({ direction: 'BUY_USDT', fixedSide: 'QUOTE', amountMinor: 50_500_000n, clientRate: Rate.parse('101', 'CLIENT'), policy });
    expect(quote.base.toDecimalString()).toBe('5000.000000');
    expect(quote.routeBase.toDecimalString()).toBe('5012.500000');
  });
});
