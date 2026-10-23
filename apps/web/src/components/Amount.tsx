import styles from './amount.module.css';

/**
 * A figure set the way a statement sets it: the currency sign smaller and raised, the whole number in full, the paise
 * or cents smaller and lighter, a unit after it quieter still. It takes the string already formatted (the format
 * helpers decide every digit) and only sets its parts, so its text is exactly the figure it was given.
 */
export function Amount({ value, className }: { value: string; className?: string | undefined }) {
  const m = /^([₹$€]?)(-?[\d,]+)(\.\d+)?(\s.*)?$/.exec(value.trim());
  if (!m) return <span className={className}>{value}</span>;
  const [, cur, whole, fraction, unit] = m;
  return (
    <span className={`${styles.amount} ${className ?? ''}`}>
      {cur ? <span className={styles.cur}>{cur}</span> : null}
      {whole}
      {fraction ? <span className={styles.fraction}>{fraction}</span> : null}
      {unit ? <span className={styles.unit}>{unit}</span> : null}
    </span>
  );
}
