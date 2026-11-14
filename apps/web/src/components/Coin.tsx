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

/** Tether's own sign, from `Tether_Logo.svg` (public domain), in its own coordinates. */
const TETHER_SIGN =
  'm73.295 81.633v-.01c-.43.03-2.65.16-7.59.16-3.95 0-6.72-.11-7.7-.16v.01c-15.19-.67-26.52-3.31-26.52-6.48 0-3.16 11.34-5.81 26.52-6.48v10.33c.99.07 3.84.24 7.77.24 4.72 0 7.08-.2 7.52-.24v-10.32c15.16.68 26.46 3.32 26.46 6.48s-11.31 5.8-26.46 6.48m0-14.03v-9.24h21.15v-14.09h-57.58v14.09h21.15v9.24c-17.19.79-30.11 4.19-30.11 8.27s12.93 7.48 30.11 8.28v29.62h15.29v-29.62c17.16-.79 30.06-4.19 30.06-8.27 0-4.07-12.9-7.48-30.06-8.27';

/**
 * A currency's coin: INR is the mark's own orange disc with its rupee; USDT Tether's green disc with Tether's own sign.
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
        // Tether's own sign (`Tether_Logo.svg`, public domain), drawn into the disc's 32 grid.
        <path className={styles.tether} transform="scale(0.25723) translate(-4.465 -13.693)" d={TETHER_SIGN} />
      )}
    </svg>
  );
}
