'use client';

import { useMemo, useState } from 'react';
import type { DeskPagePrice } from '@inrp2p/traders';
import { Money } from '@inrp2p/kernel';
import { inr, previewDeal, rate as rateText, usdt } from '../../(client)/desk/_ui/format.ts';
import styles from '../storefront.module.css';

type Side = 'SELL_USDT' | 'BUY_USDT';

/**
 * The desk's price ticket: which way, how much, and what the client gets at the desk's live price — rounded against the
 * client exactly as the quote will be. It holds nothing: asking for the firm price happens in the client's workspace,
 * where they sign in, and that price is held for a minute.
 */
export function DeskTicket({
  handle,
  displayName,
  prices,
  live,
  appOrigin,
}: {
  handle: string;
  displayName: string;
  prices: Readonly<Record<Side, DeskPagePrice | null>>;
  live: boolean;
  appOrigin: string;
}) {
  const [side, setSide] = useState<Side>(prices.SELL_USDT || !prices.BUY_USDT ? 'SELL_USDT' : 'BUY_USDT');
  const [fixed, setFixed] = useState<'BASE' | 'QUOTE'>('BASE');
  const [amount, setAmount] = useState('1000');
  const price = prices[side];
  const sells = side === 'SELL_USDT';

  const deal = useMemo(() => (price ? previewDeal({ direction: side, fixedSide: fixed, amount, rate: price.rate, feeBps: 0 }) : null), [price, side, fixed, amount]);
  const priced = deal && typeof deal !== 'string' ? deal : null;
  const base = priced?.base.minor ?? null;
  const tooSmall = price && base !== null && base < Money.parse(price.min, 'USDT').minor;
  const tooLarge = price && base !== null && base > Money.parse(price.max, 'USDT').minor;
  const ok = live && price !== null && priced !== null && !tooSmall && !tooLarge;

  const next = new URL(`/desks/${encodeURIComponent(handle)}`, appOrigin);
  next.searchParams.set('direction', side);
  next.searchParams.set('fixed', fixed);
  if (amount) next.searchParams.set('amount', amount);

  if (!live || (!prices.SELL_USDT && !prices.BUY_USDT)) {
    return (
      <section className={styles.ticket} aria-label="Prices">
        <div className={styles.closed}>
          <p className={styles.closedTitle}>{live ? 'No prices right now' : `${displayName} is not taking deals right now`}</p>
          <p className={styles.hint}>Come back a little later — the desk sets its prices through the day.</p>
        </div>
      </section>
    );
  }

  const top = sells ? (fixed === 'BASE' ? 'You send' : 'You receive') : fixed === 'BASE' ? 'You receive' : 'You pay';
  const bottom = sells ? (fixed === 'BASE' ? 'You receive' : 'You send') : fixed === 'BASE' ? 'You pay' : 'You receive';
  const result = priced ? (fixed === 'BASE' ? inr(priced.clientInr.toDecimalString()) : usdt(priced.base.toDecimalString(), false)) : '—';

  return (
    <section className={styles.ticket} aria-label="Prices">
      <div className={styles.sides} role="group" aria-label="I want to">
        {(['SELL_USDT', 'BUY_USDT'] as const).map((s) => (
          <button key={s} type="button" className={styles.side} aria-pressed={side === s} disabled={!prices[s]} onClick={() => setSide(s)}>
            <span className={styles.sideLabel}>{s === 'SELL_USDT' ? 'Sell USDT' : 'Buy USDT'}</span>
            <span className={styles.sideRate}>{prices[s] ? `${rateText(prices[s]!.rate)} per USDT` : 'Not offered'}</span>
          </button>
        ))}
      </div>

      <label className={styles.leg}>
        <span className={styles.legLabel}>
          {top}
          <button type="button" className={styles.swapUnit} onClick={() => setFixed(fixed === 'BASE' ? 'QUOTE' : 'BASE')}>
            {fixed === 'BASE' ? 'Enter rupees instead' : 'Enter USDT instead'}
          </button>
        </span>
        <span className={styles.legValue}>
          {fixed === 'QUOTE' ? <span className={styles.unit}>₹</span> : null}
          <input className={styles.amount} inputMode="decimal" autoComplete="off" aria-label={`${top}, in ${fixed === 'BASE' ? 'USDT' : 'rupees'}`} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />
          {fixed === 'BASE' ? <span className={styles.unit}>USDT</span> : null}
        </span>
      </label>

      <div className={styles.leg} aria-live="polite">
        <span className={styles.legLabel}>{bottom}</span>
        <span className={styles.legValue}>
          <span className={styles.result}>{result}</span>
          {fixed === 'QUOTE' ? <span className={styles.unit}>USDT</span> : null}
        </span>
      </div>

      {price ? (
        <p className={styles.rateLine}>
          <span>
            Rate <strong>{rateText(price.rate)}</strong> per USDT
          </span>
          <span>
            {usdt(price.min, false)}–{usdt(price.max)} per deal
          </span>
        </p>
      ) : null}
      {typeof deal === 'string' ? <p className={styles.hint} data-tone="warning">{deal}</p> : null}
      {tooSmall ? <p className={styles.hint} data-tone="warning">The smallest deal here is {usdt(price!.min)}.</p> : null}
      {tooLarge ? <p className={styles.hint} data-tone="warning">The largest deal here is {usdt(price!.max)}.</p> : null}

      <a className={styles.cta} href={ok ? next.toString() : undefined} aria-disabled={!ok}>
        {sells ? 'Sell' : 'Buy'} with {displayName}
        <svg className={styles.ctaIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12h13" />
          <path d="m13 7 5 5-5 5" />
        </svg>
      </a>
      <p className={styles.fine}>Sign in with your email to get a firm price, held for a minute. Nothing is charged to you on top of it.</p>
    </section>
  );
}
