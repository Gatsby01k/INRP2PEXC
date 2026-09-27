'use client';

import { forwardRef, useId } from 'react';
import { groupDigits } from '@inrp2p/ui/format';
import styles from './exchange.module.css';

export type Currency = 'USDT' | 'INR';

function CurrencyTag({ currency }: { currency: Currency }) {
  return (
    <span className={styles.currency}>
      <span className={styles.coin} data-coin={currency} aria-hidden="true">
        {currency === 'INR' ? '₹' : '₮'}
      </span>
      <span>
        {currency}
        <br />
        <span className={styles.currencySub}>{currency === 'USDT' ? 'TRC20' : 'Bank transfer'}</span>
      </span>
    </span>
  );
}

const grouped = (value: string) => {
  const [whole = '', fraction] = value.split('.');
  return whole ? `${groupDigits(whole)}${fraction !== undefined ? `.${fraction}` : ''}` : '';
};

/**
 * One side of a request the client can type into. Both sides are offered and whichever the client types into is
 * the amount they fix (`fixedSide`); the other shows that the desk prices it. Nothing is ever computed across:
 * there is no rate here to compute with.
 */
export const LegInput = forwardRef<
  HTMLInputElement,
  { label: string; currency: Currency; value: string; fixed: boolean; invalid?: boolean; describedBy?: string; onChange: (raw: string) => void }
>(function LegInput({ label, currency, value, fixed, invalid = false, describedBy, onChange }, ref) {
  const id = useId();
  return (
    <div className={styles.leg} data-fixed={fixed} {...(invalid ? { 'data-invalid': '' } : {})}>
      <label className={styles.legLabel} htmlFor={id}>
        {label}
      </label>
      <div className={styles.legBox}>
        <input
          ref={ref}
          id={id}
          className={styles.legInput}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={fixed ? grouped(value) : ''}
          placeholder={fixed ? '0' : 'Priced by the desk'}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={invalid || undefined}
          {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        />
        <CurrencyTag currency={currency} />
      </div>
    </div>
  );
});

/** One side of a request or quote that is already decided: its amount, or that the desk is pricing it. */
export function LegStatic({ label, currency, amount }: { label: string; currency: Currency; amount: string | null }) {
  return (
    <div className={styles.leg} data-fixed={amount !== null}>
      <span className={styles.legLabel}>{label}</span>
      <div className={styles.legBox}>
        {amount !== null ? <span className={styles.legValue}>{amount}</span> : <span className={styles.legPending}>Priced by the desk</span>}
        <CurrencyTag currency={currency} />
      </div>
    </div>
  );
}

/** What leaves the client and what reaches them, in that order, for each direction. */
export const LEGS: Record<'SELL_USDT' | 'BUY_USDT', readonly [{ label: string; currency: Currency }, { label: string; currency: Currency }]> = {
  SELL_USDT: [
    { label: 'You sell', currency: 'USDT' },
    { label: 'You receive', currency: 'INR' },
  ],
  BUY_USDT: [
    { label: 'You pay', currency: 'INR' },
    { label: 'You receive', currency: 'USDT' },
  ],
};

export const sideOf = (currency: Currency): 'BASE' | 'QUOTE' => (currency === 'USDT' ? 'BASE' : 'QUOTE');
