import { encode } from 'uqr';
import { cx } from '../../cx.ts';
import styles from './QrCode.module.css';

export interface QrCodeProps {
  /** What the code carries: an address, or an `otpauth://` link for an authenticator app. */
  value: string;
  /** What a screen reader hears instead of the picture. */
  label: string;
  className?: string | undefined;
}

/** A QR code drawn as one SVG path in the text colour on the surface, crisp at any size. */
export function QrCode({ value, label, className }: QrCodeProps) {
  const { data, size } = encode(value, { ecc: 'M', border: 2 });
  const cells: string[] = [];
  data.forEach((row, y) => row.forEach((on, x) => on && cells.push(`M${x} ${y}h1v1h-1z`)));
  return (
    <svg className={cx(styles.qr, className)} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} className={styles.bg} />
      <path d={cells.join('')} className={styles.fg} />
    </svg>
  );
}
