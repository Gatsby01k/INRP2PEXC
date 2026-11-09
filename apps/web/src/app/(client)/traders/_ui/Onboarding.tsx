import Link from 'next/link';
import { ArrowIcon, InfoIcon } from '../../_workspace/icons.tsx';
import { usdt } from './format.ts';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

/**
 * First visit: what trading on INRP2P is, the four steps to a first order — the Security Reserve named with its amount
 * before anyone starts, never a surprise halfway through — what to have at hand, and the one way in.
 */
export function Onboarding({ canApply, reserve }: { canApply: boolean; reserve: string | null }) {
  const amount = reserve && /[1-9]/.test(reserve) ? usdt(reserve) : null;
  return (
    <section className={`${shell.surface} ${styles.onboard}`} aria-labelledby="onboard-title" data-robot-target="panel">
      <div>
        <h2 id="onboard-title" className={styles.onboardTitle}>
          Trade on INRP2P.
          <span>Orders come to you. The escrow holds every deal.</span>
        </h2>
        <p className={styles.onboardCopy}>
          INRP2P’s clients buy and sell USDT at your prices while you are online, and your own page and deal links bring you clients of your own.
        </p>
      </div>
      <ol className={styles.how} data-count="4">
        <li>
          <strong>Apply · 2 minutes</strong>
          Who you are, what you trade, and your own bank account and TRC20 wallet.
        </li>
        <li>
          <strong>Send your reserve</strong>
          {amount ? `${amount} from that wallet, on TRON.` : 'USDT from that wallet, on TRON.'} It proves the wallet is yours and stays yours — it is not spent on deals.
        </li>
        <li>
          <strong>Set your prices</strong>
          Follow the market by your own margin, and say how much you can take on.
        </li>
        <li>
          <strong>Go online</strong>
          Orders arrive at your prices; the USDT of each deal waits in escrow until the rupees are confirmed.
        </li>
      </ol>
      <p className={styles.haveReady}>
        <span>Have ready</span> a bank account in your name (or your company’s) · a TRC20 wallet you hold the key to{amount ? ` · ${amount} for the reserve` : ''}
      </p>
      {canApply ? (
        <div>
          <Link className={shell.action} href="/traders/apply" data-robot-target="cta">
            Apply now
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
