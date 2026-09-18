'use client';

import { useRef, type KeyboardEvent } from 'react';
import type { Direction } from '@inrp2p/kernel';
import { cx } from '../../cx.ts';
import styles from './DirectionToggle.module.css';

const OPTIONS: readonly { value: Direction; label: string }[] = [
  { value: 'SELL_USDT', label: 'Sell USDT' },
  { value: 'BUY_USDT', label: 'Buy USDT' },
];

/** Radio group semantics with arrow-key switching; switching is instant (no animation dependency). */
export function DirectionToggle({ value, onChange, size = 'md' }: { value: Direction; onChange: (d: Direction) => void; size?: 'sm' | 'md' }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const idx = OPTIONS.findIndex((o) => o.value === value);
    const next = OPTIONS[(idx + 1) % OPTIONS.length]!;
    onChange(next.value);
    refs.current[OPTIONS.indexOf(next)]?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Direction" className={cx(styles.root, styles[size])} onKeyDown={onKey}>
      {OPTIONS.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          className={cx(styles.option, value === o.value && styles.selected)}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
