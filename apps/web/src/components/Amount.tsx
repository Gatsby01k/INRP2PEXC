import type { CSSProperties } from 'react';
import { RupeeGlyph } from './Coin.tsx';
import styles from './amount.module.css';

/**
 * A figure set the way a statement sets it: the rupee drawn as the mark draws it and sitting on the line with the
 * digits, the whole number in full, the paise or cents a step smaller and quieter, a unit after it quieter still. The
 * digits arrive one after another, once, as the figure appears. It takes the string already formatted (the format
 * helpers decide every digit) and only sets its parts, so its text is exactly the figure it was given.
 */
export function Amount({ value, className }: { value: string; className?: string | undefined }) {
  const m = /^([₹$€]?)(-?[\d,]+)(\.\d+)?(\s.*)?$/.exec(value.trim());
  if (!m) return <span className={className}>{value}</span>;
  const [, cur, whole = '', fraction, unit] = m;
  let i = 0;
  const chars = (text: string) =>
    [...text].map((c) => (
      <span key={i} className={styles.ch} style={{ '--i': i++ } as CSSProperties}>
        {c}
      </span>
    ));
  return (
    <span className={`${styles.amount} ${className ?? ''}`}>
      {cur === '₹' ? (
        <span className={styles.cur}>
          <span className="ix-visually-hidden">₹</span>
          <RupeeGlyph className={styles.rupee} />
        </span>
      ) : cur ? (
        <span className={styles.cur}>{cur}</span>
      ) : null}
      {chars(whole)}
      {fraction ? <span className={styles.fraction}>{chars(fraction)}</span> : null}
      {unit ? <span className={styles.unit}>{unit}</span> : null}
    </span>
  );
}
