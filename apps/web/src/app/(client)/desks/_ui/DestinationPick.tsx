'use client';

import { PlusIcon } from '../../_workspace/icons.tsx';
import shell from '../../shell.module.css';
import styles from '../desks.module.css';

export interface PickOption {
  readonly id: string;
  readonly name: string;
  readonly meta: string;
}

/**
 * Where the client's money lands on this deal — one of its own bank accounts (it sells) or wallets (it buys) — or, when it
 * has none yet, the way to add one without leaving the deal.
 */
export function DestinationPick({ kind, options, value, onChange, canAdd, onAdd }: { kind: 'bank' | 'wallet'; options: readonly PickOption[]; value: string; onChange: (id: string) => void; canAdd: boolean; onAdd: () => void }) {
  const bank = kind === 'bank';
  if (options.length === 0) {
    return (
      <div className={shell.info}>
        <span className={styles.rowText}>
          <span>{bank ? 'Add the bank account the rupees are paid to. It takes a minute, and the code you signed in with confirms it.' : 'Add the TRC20 wallet the USDT goes to. It takes a minute, and the code you signed in with confirms it.'}</span>
          {canAdd ? (
            <button type="button" className={shell.secondaryAction} data-size="sm" onClick={onAdd}>
              <PlusIcon />
              {bank ? 'Add bank account' : 'Add wallet'}
            </button>
          ) : (
            <span className={shell.muted}>An administrator of your account adds it.</span>
          )}
        </span>
      </div>
    );
  }
  return (
    <fieldset className={styles.picks}>
      <legend className={styles.legend}>{bank ? 'Rupees paid to' : 'USDT delivered to'}</legend>
      {options.map((o) => (
        <label key={o.id} className={styles.pick}>
          <input type="radio" name={`pick-${kind}`} value={o.id} checked={value === o.id} onChange={() => onChange(o.id)} />
          <span className={styles.pickText}>
            <span className={styles.pickName}>{o.name}</span>
            <span className={styles.pickMeta}>{o.meta}</span>
          </span>
        </label>
      ))}
      {canAdd ? (
        <button type="button" className={shell.textAction} onClick={onAdd}>
          {bank ? 'Use another account' : 'Use another wallet'}
        </button>
      ) : null}
    </fieldset>
  );
}
