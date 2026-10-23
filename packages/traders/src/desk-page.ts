import { sql } from 'kysely';
import { DomainError, Money, Rate, requireOneOf } from '@inrp2p/kernel';
import type { DirectionValue, Executor, FixedSideValue } from '@inrp2p/db';
import { currentDeskPrices, currentFeePolicy, deskByHandle, priceDeskDeal } from '@inrp2p/trader-core';

/**
 * A desk's public page (`inrp2p.com/<handle>`, docs/adr/0020-desks.md): what anyone may see before signing in — the desk's
 * name, its live prices with their limits, and its record from the books: how many deals it completed and how long they
 * took. Nothing about its clients, its volumes, its own USDT or INRP2P's fee. A draft desk has no page.
 */
export interface DeskPagePrice {
  readonly rate: string;
  /** Smallest and largest deal on this price, in USDT. */
  readonly min: string;
  readonly max: string;
  readonly validUntil: string;
}

export interface DeskPage {
  readonly handle: string;
  readonly displayName: string;
  readonly about: string | null;
  /** PAUSED: the page stays, but takes no deals. */
  readonly status: 'LIVE' | 'PAUSED';
  readonly since: string;
  /** Keyed by the client's direction: what the desk pays for USDT (SELL_USDT), what it asks for it (BUY_USDT). */
  readonly prices: Readonly<Record<DirectionValue, DeskPagePrice | null>>;
  readonly record: { readonly completedDeals: number; readonly medianMinutes: number | null };
}

export async function deskPage(ex: Executor, handle: string): Promise<DeskPage | null> {
  const desk = await deskByHandle(ex, handle);
  // A draft has no page; one INRP2P hid has none for anyone until INRP2P shows it again (block 11).
  if (!desk || desk.status === 'DRAFT' || desk.pageHiddenReason !== null) return null;
  const current = await currentDeskPrices(ex, desk.id);
  const shown = (direction: DirectionValue): DeskPagePrice | null => {
    const p = current[direction];
    if (desk.status !== 'LIVE' || !p || !p.offered) return null;
    return { rate: Rate.ofMicro(p.rateMicro, 'CLIENT').toDecimalString(), min: Money.ofMinor(p.minBaseMinor, 'USDT').toDecimalString(), max: Money.ofMinor(p.maxBaseMinor, 'USDT').toDecimalString(), validUntil: p.validUntil.toISOString() };
  };
  const record = await sql<{ n: number; median: number | null }>`
    select count(*)::int as n,
           round(percentile_cont(0.5) within group (order by extract(epoch from (t.completed_at - t.opened_at)) / 60))::int as median
      from trade t join trade_request r on r.id = t.trade_request_id
     where r.desk_id = ${desk.id} and t.lifecycle_state = 'COMPLETED'`.execute(ex);
  return {
    // A suspended desk reads as paused to the world: it takes no deals, and why is between it and INRP2P.
    handle: desk.handle, displayName: desk.displayName, about: desk.about, status: desk.status === 'LIVE' ? 'LIVE' : 'PAUSED', since: desk.createdAt.toISOString(),
    prices: { SELL_USDT: shown('SELL_USDT'), BUY_USDT: shown('BUY_USDT') },
    record: { completedDeals: record.rows[0]!.n, medianMinutes: record.rows[0]!.median },
  };
}

/**
 * The page's calculator: what the client would send and receive at the desk's live price right now — the client's side
 * only, rounded against it as the quote will be. Indicative: nothing is held until the client asks for the price itself.
 */
export async function previewDeskDeal(ex: Executor, input: { handle: string; direction: DirectionValue; fixedSide: FixedSideValue; amount: string }) {
  const desk = await deskByHandle(ex, input.handle);
  if (!desk || desk.status !== 'LIVE') throw new DomainError('DESK_NOT_LIVE', 'this desk is not taking deals right now');
  const direction = requireOneOf(input.direction, 'direction', ['SELL_USDT', 'BUY_USDT'] as const);
  const fixedSide = requireOneOf(input.fixedSide, 'fixedSide', ['BASE', 'QUOTE'] as const);
  const price = (await currentDeskPrices(ex, desk.id))[direction];
  if (!price || !price.offered) throw new DomainError('DESK_NOT_LIVE', 'this desk has no live price for this right now');
  const amount = fixedSide === 'BASE' ? Money.parse(input.amount, 'USDT') : Money.parse(input.amount, 'INR');
  const econ = priceDeskDeal({ direction, fixedSide, amountMinor: amount.minor, clientRate: Rate.ofMicro(price.rateMicro, 'CLIENT'), policy: await currentFeePolicy(ex) });
  return {
    rate: Rate.ofMicro(price.rateMicro, 'CLIENT').toDecimalString(),
    base: econ.base.toDecimalString(),
    inr: econ.clientInr.toDecimalString(),
    withinLimits: econ.base.minor >= price.minBaseMinor && econ.base.minor <= price.maxBaseMinor,
  };
}

/** The handles of the desks taking deals, for the public site's sitemap. A draft or paused desk is not listed. */
export async function liveDeskHandles(ex: Executor, limit = 5000): Promise<string[]> {
  const rows = await ex.selectFrom('desk').select('handle').where('status', '=', 'LIVE').where('page_hidden_at', 'is', null).orderBy('handle').limit(limit).execute();
  return rows.map((r) => r.handle);
}
