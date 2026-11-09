import styles from '../traders.module.css';

/** A figure with its unit set smaller after it — 16,667.10 USDT — so the number carries the weight. */
export function Unit({ value }: { value: string }) {
  const m = /^(.*?)\s(USDT|TRX)$/.exec(value);
  if (!m) return <>{value}</>;
  return (
    <>
      {m[1]}
      <span className={styles.unit}> {m[2]}</span>
    </>
  );
}
