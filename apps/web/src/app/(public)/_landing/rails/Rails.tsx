import { RAILS } from '../../../../content/site.ts';
import { ImpsMark, TronMark, UpiMark } from '../../../../components/PayMarks.tsx';
import { Coin } from '../../../../components/Coin.tsx';
import { TelegramIcon } from '../icons.tsx';
import styles from './rails.module.css';

/**
 * The strip under the hero: the ways the money moves, as the marks a client knows from their bank's app, and the way
 * in. Names and marks only — each is a rail or a network the product really uses — so it reads at a glance and claims
 * nothing.
 */
export function Rails() {
  return (
    <div className={styles.rails}>
      <p className={styles.inner}>
        <span className={styles.label}>{RAILS.label}</span>
        <span className={styles.group}>
          <span className={styles.word}>{RAILS.rupees}</span>
          <UpiMark className={styles.mark} />
          <ImpsMark className={styles.mark} />
          <span className={styles.rail}>NEFT</span>
          <span className={styles.rail}>RTGS</span>
        </span>
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.group}>
          <Coin currency="USDT" size={22} />
          <span className={styles.word}>{RAILS.usdt}</span>
          <TronMark size={18} />
          <span className={styles.rail}>TRC20</span>
        </span>
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.group}>
          <span className={styles.telegram}>
            <TelegramIcon />
          </span>
          <span className={styles.word}>{RAILS.signIn}</span>
        </span>
      </p>
    </div>
  );
}
