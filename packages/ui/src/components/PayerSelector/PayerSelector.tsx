import { useId } from 'react';
import { cx } from '../../cx.ts';
import styles from './PayerSelector.module.css';

export type Payer = 'EXCHANGE_ACCOUNT' | 'ROUTE';

export interface PayerSelectorProps {
  value: Payer;
  onChange: (p: Payer) => void;
  /** Frozen trade execution mode (D-14). ROUTE is selectable only for DIRECT_TO_CLIENT. */
  executionMode: 'DIRECT_TO_CLIENT' | 'TO_EXCHANGE';
}

export function PayerSelector({ value, onChange, executionMode }: PayerSelectorProps) {
  const name = useId();
  const noteId = useId();
  const routeAllowed = executionMode === 'DIRECT_TO_CLIENT';
  return (
    <fieldset className={styles.root}>
      <legend className={styles.legend}>Paid by</legend>
      <label className={cx(styles.option, value === 'EXCHANGE_ACCOUNT' && styles.selected)}>
        <input type="radio" name={name} checked={value === 'EXCHANGE_ACCOUNT'} onChange={() => onChange('EXCHANGE_ACCOUNT')} />
        <span>
          Exchange account<span className={styles.sub}>Uses today’s INR capacity</span>
        </span>
      </label>
      <label className={cx(styles.option, value === 'ROUTE' && styles.selected, !routeAllowed && styles.disabled)}>
        <input type="radio" name={name} checked={value === 'ROUTE'} onChange={() => onChange('ROUTE')} disabled={!routeAllowed} aria-describedby={noteId} />
        <span>
          Route (direct)
          <span id={noteId} className={styles.sub}>
            {routeAllowed ? 'Route pays the client · no capacity used' : 'Not available: trade route settles to exchange'}
          </span>
        </span>
      </label>
    </fieldset>
  );
}
