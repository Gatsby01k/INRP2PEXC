import styles from './CurrencySelector.module.css';

/** V1 corridor is fixed (USDT · TRC20, INR); rendered read-only so no fake choice is offered. */
export function CurrencySelector({ asset, network }: { asset: 'USDT' | 'INR'; network?: 'TRC20' }) {
  return (
    <span className={styles.root} aria-label={network ? `${asset} on ${network}` : asset}>
      <span className={styles.asset}>{asset}</span>
      {network ? <span className={styles.network}>· {network}</span> : null}
    </span>
  );
}
