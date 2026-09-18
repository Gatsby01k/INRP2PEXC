'use client';

import { encode } from 'uqr';
import type { Money } from '@inrp2p/kernel';
import { formatUsdt } from '../../format/money.ts';
import { CopyButton } from '../CopyButton/CopyButton.tsx';
import styles from './DepositAddress.module.css';

export interface DepositAddressProps {
  /** Unique per-trade deposit address from the custody adapter (D-02). */
  address: string;
  amount: Money<'USDT'>;
  network: 'TRC20';
  tradeRef: string;
  showQr?: boolean;
}

function QrCode({ value, label }: { value: string; label: string }) {
  const { data, size } = encode(value, { ecc: 'M', border: 2 });
  const cells: string[] = [];
  data.forEach((row, y) => row.forEach((on, x) => on && cells.push(`M${x} ${y}h1v1h-1z`)));
  return (
    <svg className={styles.qr} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} className={styles.qrBg} />
      <path d={cells.join('')} className={styles.qrFg} />
    </svg>
  );
}

export function DepositAddress({ address, amount, network, tradeRef, showQr = true }: DepositAddressProps) {
  return (
    <section className={styles.root} aria-label="Deposit instructions">
      <div className={styles.row}>
        <span className={styles.caption}>Send exactly</span>
        <span className={styles.amount}>
          <span className="ix-num">{formatUsdt(amount, { precision: 'exact' })}</span>
        </span>
      </div>
      <div className={styles.addressBlock}>
        {showQr ? <QrCode value={address} label={`QR code for deposit address ${address}`} /> : null}
        <div className={styles.addressText}>
          <span className={styles.caption}>To this {network} address, for trade {tradeRef} only</span>
          <code className={styles.address}>{address}</code>
          <CopyButton value={address} label="deposit address" />
        </div>
      </div>
      <p className={styles.warning}>
        <strong>USDT on TRON (TRC20) only.</strong> This address belongs to this trade. Sending another asset, another network or to an old address will not settle this trade.
      </p>
    </section>
  );
}
