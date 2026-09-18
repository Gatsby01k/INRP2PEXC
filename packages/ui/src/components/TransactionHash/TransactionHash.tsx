'use client';

import { shortenHash } from '../../format/mask.ts';
import { CopyButton } from '../CopyButton/CopyButton.tsx';
import styles from './TransactionHash.module.css';

export interface TransactionHashProps {
  hash: string;
  /** e.g. "Solidified" / "12 of 19 blocks" — the caller states finality in words. */
  finality?: string;
  explorerUrl?: string;
  copy?: boolean;
}

export function TransactionHash({ hash, finality, explorerUrl, copy = true }: TransactionHashProps) {
  const short = shortenHash(hash);
  return (
    <span className={styles.root}>
      <span className={styles.label}>tx</span>
      {explorerUrl ? (
        <a className={styles.hash} href={explorerUrl} target="_blank" rel="noreferrer noopener" title={hash}>
          {short}
          <span className="ix-visually-hidden"> (opens block explorer, full hash {hash})</span>
          <span aria-hidden="true"> ↗</span>
        </a>
      ) : (
        <span className={styles.hash} title={hash}>
          {short}
          <span className="ix-visually-hidden"> full hash {hash}</span>
        </span>
      )}
      {finality ? <span className={styles.finality}>{finality}</span> : null}
      {copy ? <CopyButton value={hash} label="transaction hash" /> : null}
    </span>
  );
}
