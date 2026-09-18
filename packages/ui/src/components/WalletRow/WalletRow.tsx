'use client';

import { cx } from '../../cx.ts';
import { shortenAddress } from '../../format/mask.ts';
import styles from './WalletRow.module.css';

export interface WalletRowProps {
  address: string;
  network: 'TRC20';
  label?: string;
  status: 'ACTIVE' | 'ARCHIVED' | 'PAUSED';
  selected?: boolean;
  onSelect?: () => void;
}

export function WalletRow({ address, network, label, status, selected, onSelect }: WalletRowProps) {
  const body = (
    <>
      <span className={styles.primary}>
        {network} · <span className="ix-num" title={address}>{shortenAddress(address)}</span>
        <span className="ix-visually-hidden"> full address {address}</span>
      </span>
      <span className={styles.secondary}>{label ?? 'USDT wallet'}</span>
      {status !== 'ACTIVE' ? <span className={styles.status}>{status === 'ARCHIVED' ? 'Archived' : 'Paused'}</span> : null}
    </>
  );
  return onSelect ? (
    <button type="button" role="radio" aria-checked={Boolean(selected)} className={cx(styles.row, styles.selectable, selected && styles.selected)} onClick={onSelect} disabled={status !== 'ACTIVE'}>
      {body}
    </button>
  ) : (
    <div className={styles.row}>{body}</div>
  );
}
