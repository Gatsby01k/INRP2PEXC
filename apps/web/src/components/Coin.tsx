import styles from './coin.module.css';

/**
 * The rupee as the mark draws it — the sign inside the INRP2P hub, not a font's. Used wherever a figure is large
 * enough for the difference to show; small text keeps the typed sign.
 */
export const RUPEE_PATH = 'M8.5 7.5h7 M8.5 10.5h7 M10 7.5c2.6 0 3.9 1.1 3.9 2.9 0 1.9-1.4 3-3.9 3H9l4.8 3.6';

export function RupeeGlyph({ className }: { className?: string | undefined }) {
  return (
    <svg className={`${styles.rupee} ${className ?? ''}`} viewBox="7.6 6.6 8.8 11.4" fill="none" aria-hidden="true" focusable="false">
      <path d={RUPEE_PATH} />
    </svg>
  );
}

/**
 * A currency's coin: INR is the mark's own orange disc with its rupee; USDT the tether's green disc with its sign.
 * Decorative — the currency is always named in words beside it.
 */
export function Coin({ currency, size = 30, className }: { currency: 'INR' | 'USDT'; size?: number; className?: string | undefined }) {
  return (
    <svg className={`${styles.coin} ${className ?? ''}`} data-coin={currency} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <circle cx="16" cy="16" r="16" className={styles.disc} />
      <circle cx="16" cy="16" r="15.25" className={styles.rim} />
      {currency === 'INR' ? (
        <path className={styles.sign} transform="translate(16 16.4) scale(1.12) translate(-12.1 -12.3)" d={RUPEE_PATH} />
      ) : (
        <g className={styles.sign}>
          <path d="M10 9.5h12M16 9.5v13" />
          <ellipse cx="16" cy="15" rx="6.2" ry="1.9" />
        </g>
      )}
    </svg>
  );
}
