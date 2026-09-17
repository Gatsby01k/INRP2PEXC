import styles from './Validation.module.css';

const ITEMS = ['Desk', 'Orders', 'Rates', 'INR', 'USDT', 'Clients', 'P&L', 'Settings'] as const;

export function OperatorNav({ active }: { active: (typeof ITEMS)[number] }) {
  return (
    <nav className={styles.sidebar} aria-label="Operator">
      {ITEMS.map((i) => (
        <span key={i} className={`${styles.navItem} ${i === active ? styles.navActive : ''}`} aria-current={i === active ? 'page' : undefined}>
          {i}
        </span>
      ))}
    </nav>
  );
}

export function Strip({ items }: { items: readonly [string, string][] }) {
  return (
    <div className={styles.strip} role="group" aria-label="Operational strip">
      {items.map(([k, v]) => (
        <span key={k} className={styles.stripItem}>
          <span className={styles.stripLabel}>{k}</span>
          <span className={`${styles.stripValue} ix-num`}>{v}</span>
        </span>
      ))}
    </div>
  );
}
