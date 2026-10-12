'use client';

import type { Money } from '@inrp2p/kernel';
import { formatUsdt } from '../../format/money.ts';
import { CopyButton } from '../CopyButton/CopyButton.tsx';
import { QrCode } from './QrCode.tsx';
import styles from './DepositAddress.module.css';

export interface DepositAddressProps {
  /** Unique per-subject deposit address from the custody adapter (D-02). */
  address: string;
  /** What to send. A reserve top-up takes any amount, so there it is what is still needed, or left out. */
  amount?: Money<'USDT'> | null;
  network: 'TRC20';
  tradeRef: string;
  /** What the address belongs to: a client's trade (the default), a trader's order, or a trader's Security Reserve. */
  purpose?: 'trade' | 'order' | 'reserve';
  showQr?: boolean;
  /** Drawn as a surface of its own (the default), or without one, inside a surface the page already draws. */
  framed?: boolean;
}

const WORDING = {
  trade: {
    amount: 'Send exactly',
    address: (network: string, ref: string) => `To this ${network} address, for trade ${ref} only`,
    warning: 'This address belongs to this trade. Sending another asset, another network or to an old address will not settle this trade.',
  },
  order: {
    amount: 'Send exactly',
    address: (network: string, ref: string) => `To this ${network} address, for order ${ref} only`,
    warning: 'This address belongs to this order. Sending another asset, another network or to an old address will not settle this order.',
  },
  reserve: {
    amount: 'Still needed',
    address: (network: string) => `To this ${network} address, for your Security Reserve only`,
    warning: 'Only USDT sent from your registered wallet is credited to your reserve. Another asset or another network is not.',
  },
} as const;

export function DepositAddress({ address, amount, network, tradeRef, purpose = 'trade', showQr = true, framed = true }: DepositAddressProps) {
  const words = WORDING[purpose];
  return (
    <section className={framed ? styles.root : `${styles.root} ${styles.bare}`} aria-label="Deposit instructions">
      {amount ? (
        <div className={styles.row}>
          <span className={styles.caption}>{words.amount}</span>
          <span className={styles.amount}>
            <span className="ix-num">{formatUsdt(amount, { precision: 'exact' })}</span>
          </span>
        </div>
      ) : null}
      <div className={styles.addressBlock}>
        {showQr ? <QrCode value={address} label={`QR code for deposit address ${address}`} className={styles.qr} /> : null}
        <div className={styles.addressText}>
          <span className={styles.caption}>{words.address(network, tradeRef)}</span>
          <code className={styles.address}>{address}</code>
          <CopyButton value={address} label="deposit address" />
        </div>
      </div>
      <p className={styles.warning}>
        <strong>USDT on TRON (TRC20) only.</strong> {words.warning}
      </p>
    </section>
  );
}
