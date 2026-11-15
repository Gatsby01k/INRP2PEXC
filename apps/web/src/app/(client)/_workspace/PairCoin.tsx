import { Coin } from '../../../components/Coin.tsx';
import styles from './workspace.module.css';

/**
 * A deal's two currencies as one mark: what is given, large, and what is got, as a badge on it — the way an exchange
 * shows a pair. Decorative: the side and the amount are in words beside it.
 */
export function PairCoin({ side, size = 36 }: { side: 'BUY_USDT' | 'SELL_USDT'; size?: number }) {
  const buy = side === 'BUY_USDT';
  return (
    <span className={styles.pair} style={{ ['--pair' as string]: `${size}px` }} aria-hidden="true">
      <Coin currency={buy ? 'INR' : 'USDT'} size={size} />
      <Coin currency={buy ? 'USDT' : 'INR'} size={Math.round(size * 0.52)} className={styles.pairBadge} />
    </span>
  );
}
