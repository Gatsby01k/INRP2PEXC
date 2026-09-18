'use client';

import type { ReactNode } from 'react';
import type { Money } from '@inrp2p/kernel';
import { cx } from '../../cx.ts';
import { formatInr } from '../../format/money.ts';
import { maskUtr } from '../../format/mask.ts';
import { formatIstTime } from '../../format/time.ts';
import styles from './SettlementLegRow.module.css';

export type LegStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

interface Common {
  amount: Money<'INR'>;
  status: LegStatus;
  utr?: string;
  at?: Date;
}

/**
 * Client rows never carry payer or account (route identity is never shown to clients, S14).
 * Operator rows add payer and source account.
 */
export type SettlementLegRowProps =
  | (Common & { audience: 'client' })
  | (Common & { audience: 'operator'; legRef: string; payer: 'EXCHANGE_ACCOUNT' | 'ROUTE'; sourceLabel?: string });

const CLIENT_LABEL: Record<LegStatus, string> = { PENDING: 'Pending', PROCESSING: 'Processing', COMPLETED: 'Received', FAILED: 'Failed', CANCELLED: 'Cancelled' };
const OPERATOR_LABEL: Record<LegStatus, string> = { PENDING: 'Pending', PROCESSING: 'Processing', COMPLETED: 'Confirmed', FAILED: 'Failed', CANCELLED: 'Cancelled' };

export function SettlementLegRow(props: SettlementLegRowProps) {
  const labels = props.audience === 'client' ? CLIENT_LABEL : OPERATOR_LABEL;
  return (
    <li className={cx(styles.row, styles[props.status.toLowerCase()], styles[props.audience])}>
      {props.audience === 'operator' ? <span className={cx(styles.ref, 'ix-num')}>{props.legRef}</span> : null}
      <span className={cx(styles.amount, 'ix-num')}>{formatInr(props.amount)}</span>
      <span className={styles.status}>
        <span aria-hidden="true" className={styles.dot} />
        {labels[props.status]}
      </span>
      <span className={cx(styles.utr, 'ix-num')}>{props.utr ? <>UTR {maskUtr(props.utr)}</> : null}</span>
      <span className={cx(styles.time, 'ix-num')}>{props.at ? formatIstTime(props.at, { suffix: false }) : null}</span>
      {props.audience === 'operator' ? (
        <span className={styles.payer}>
          {props.payer === 'ROUTE' ? 'Route · direct' : 'Exchange account'}
          {props.sourceLabel ? ` · ${props.sourceLabel}` : ''}
        </span>
      ) : null}
    </li>
  );
}

export function SettlementLegList({ children, label = 'INR settlement legs' }: { children: ReactNode; label?: string }) {
  return (
    <ul className={styles.list} aria-label={label}>
      {children}
    </ul>
  );
}
