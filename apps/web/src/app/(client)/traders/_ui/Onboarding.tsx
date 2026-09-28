import Link from 'next/link';
import { ArrowIcon, InfoIcon } from '../../_workspace/icons.tsx';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

/** First visit: what being a trader is, in two lines, and the one way in. */
export function Onboarding({ canApply }: { canApply: boolean }) {
  return (
    <section className={`${shell.surface} ${styles.onboard}`} aria-labelledby="onboard-title" data-robot-target="panel">
      <div>
        <h2 id="onboard-title" className={styles.onboardTitle}>
          Provide liquidity.
          <span>Earn on completed orders.</span>
        </h2>
        <p className={styles.onboardCopy}>
          Set how much INR or USDT you can provide.
          <br />
          INRP2P sends matching orders to you.
        </p>
      </div>
      <ol className={styles.how}>
        <li>
          <strong>Set your capacity and rate</strong>
          For buying USDT with your INR, selling your USDT for INR, or both.
        </li>
        <li>
          <strong>Receive matching orders</strong>
          Orders come to you privately. You accept or decline each one.
        </li>
        <li>
          <strong>Settle with INRP2P</strong>
          Only through your own bank account and TRC20 wallet, once the desk has verified them.
        </li>
      </ol>
      {canApply ? (
        <div>
          <Link className={shell.action} href="/traders/apply" data-robot-target="cta">
            Become a trader
            <ArrowIcon className={shell.actionIcon} />
          </Link>
        </div>
      ) : (
        <p className={shell.info}>
          <InfoIcon className={shell.infoIcon} />
          <span>An administrator of your account can apply for you.</span>
        </p>
      )}
    </section>
  );
}
