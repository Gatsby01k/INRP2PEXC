'use client';

import { useState } from 'react';
import type { TraderHome } from '@inrp2p/traders';
import { RailMark } from '../../../../components/PayMarks.tsx';
import { EditIcon } from '../../_workspace/icons.tsx';
import { BlockCard } from './BlockCard.tsx';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

/**
 * The trader's prices on one sheet: what it buys USDT at and what it sells at, side by side as figures, each with the
 * order size it takes and how the rate is set; the card's one Edit opens both sides in place. Along the foot, the ways
 * money moves and the spread between the two rates.
 */
export function PricesCard({ home }: { home: TraderHome }) {
  const [signal, setSignal] = useState(0);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const editing = Object.values(open).some(Boolean);
  const blocks = [...home.blocks].sort((a) => (a.side === 'BUY_USDT' ? -1 : 1));
  const active = blocks.filter((b) => b.status === 'ACTIVE').length;
  const buy = blocks.find((b) => b.side === 'BUY_USDT');
  const sell = blocks.find((b) => b.side === 'SELL_USDT');
  const rails = [...new Set(blocks.flatMap((b) => b.rails))];
  // The spread is a difference, not a rate: it can be nothing or below nothing, so it is set as plain rupees.
  const spread = buy?.rate && sell?.rate ? Number(sell.rate) - Number(buy.rate) : null;
  const spreadText = spread === null ? null : `${spread < 0 ? '−' : ''}₹${Math.abs(spread).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const basis = blocks.every((b) => b.rateBasis === 'MARKET') ? 'following the market' : blocks.every((b) => b.rateBasis === 'FIXED') ? 'fixed rate' : 'one side on the market';
  return (
    <section className={`${shell.card} ${styles.prices}`} aria-labelledby="prices-title" data-prices="" data-editing={editing || undefined}>
      <div className={styles.pricesHead}>
        <h2 id="prices-title" className={styles.pricesTitle}>
          Your prices
        </h2>
        <span className={styles.pill} data-tone={active > 0 ? 'done' : 'neutral'}>
          <span className={styles.pillDot} aria-hidden="true" />
          {active === blocks.length ? 'Active' : active === 0 ? 'Paused' : `${active} of ${blocks.length} active`}
        </span>
        {home.canAct && !editing ? (
          <button type="button" className={`${shell.secondaryAction} ${styles.pricesEdit}`} data-size="sm" onClick={() => setSignal((n) => n + 1)}>
            <EditIcon />
            Edit
          </button>
        ) : null}
      </div>
      <div className={styles.halves} data-count={blocks.length}>
        {blocks.map((b) => (
          <BlockCard
            key={`${b.side}:${b.version}`}
            block={b}
            canAct={home.canAct}
            upiReady={home.upiReady}
            half
            editSignal={signal}
            onEditing={(v) => setOpen((o) => ({ ...o, [b.side]: v }))}
          />
        ))}
      </div>
      <div className={styles.pricesFoot}>
        <span className={styles.pricesRails}>
          {rails.map((r) => (
            <RailMark key={r} rail={r} />
          ))}
        </span>
        <span>
          {spreadText !== null ? `Spread ${spreadText} · ` : ''}
          {basis}
        </span>
      </div>
    </section>
  );
}
