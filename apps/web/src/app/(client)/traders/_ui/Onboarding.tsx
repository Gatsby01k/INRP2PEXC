import Link from 'next/link';
import { ArrowIcon, InfoIcon } from '../../_workspace/icons.tsx';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

/** First visit: what an exchange of one's own on INRP2P is, in two lines, the three steps to it, and the one way in. */
export function Onboarding({ canApply }: { canApply: boolean }) {
  return (
    <section className={`${shell.surface} ${styles.onboard}`} aria-labelledby="onboard-title" data-robot-target="panel">
      <div>
        <h2 id="onboard-title" className={styles.onboardTitle}>
          Open your exchange.
          <span>Your clients, your prices, our escrow.</span>
        </h2>
        <p className={styles.onboardCopy}>
          Apply once. When INRP2P approves you, your page and deal links open here,
          <br />
          and INRP2P’s own orders come to you too.
        </p>
      </div>
      <ol className={styles.how}>
        <li>
          <strong>Apply</strong>
          Who you are, the INR or USDT you can provide, and the bank account and TRC20 wallet you settle with.
        </li>
        <li>
          <strong>Set your prices</strong>
          What you pay and what you ask, and how much you can take on.
        </li>
        <li>
          <strong>Deal</strong>
          With your own clients through your page and links, and with INRP2P’s orders, which you accept or decline.
        </li>
      </ol>
      {canApply ? (
        <div>
          <Link className={shell.action} href="/traders/apply" data-robot-target="cta">
            Open your exchange
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
