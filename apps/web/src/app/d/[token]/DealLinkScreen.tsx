'use client';

import { useServerClock } from '../../(client)/exchange/useServerClock.ts';
import { formatCountdown, formatIstDateTime } from '@inrp2p/ui/format';
import { inr, rate as rateText, usdt } from '../../(client)/desk/_ui/format.ts';
import styles from '../../public-desk/storefront.module.css';

interface LinkView {
  readonly ref: string;
  readonly desk: { readonly handle: string; readonly displayName: string; readonly live: boolean };
  readonly direction: 'SELL_USDT' | 'BUY_USDT';
  readonly rate: string;
  readonly base: string;
  readonly inr: string;
  readonly expiresAt: string;
  readonly state: 'OPEN' | 'TAKEN' | 'DONE' | 'EXPIRED' | 'REVOKED';
}

const CLOSED: Record<Exclude<LinkView['state'], 'OPEN'>, { title: string; body: string }> = {
  TAKEN: { title: 'This deal has been taken', body: 'Someone signed in and took it. If it was you, carry on in your workspace.' },
  DONE: { title: 'This deal is done', body: 'It became a trade. Its progress is in the workspace of the person who took it.' },
  EXPIRED: { title: 'This link has expired', body: 'Ask the desk for a new one — or see its live prices.' },
  REVOKED: { title: 'The desk took this link back', body: 'Ask the desk for a new one — or see its live prices.' },
};

/** The deal on the link, and the one thing to do with it — counting down to its expiry from the server's clock. */
export function DealLinkScreen({ view, now: serverNow, takeUrl }: { view: LinkView; now: string; takeUrl: string }) {
  const now = useServerClock(serverNow, view.state === 'OPEN');
  const left = Date.parse(view.expiresAt) - now;
  const open = view.state === 'OPEN' && left > 0 && view.desk.live;
  const sells = view.direction === 'SELL_USDT';
  const closed = view.state !== 'OPEN' ? CLOSED[view.state] : left <= 0 ? CLOSED.EXPIRED : !view.desk.live ? { title: `${view.desk.displayName} is not taking deals right now`, body: 'The link works again when the desk is back.' } : null;

  return (
    <main className={styles.linkMain}>
      <a className={styles.linkDesk} href={`/${view.desk.handle}`}>
        <span className={styles.monogram} aria-hidden="true">
          {view.desk.displayName.trim().charAt(0).toUpperCase()}
        </span>
        <span className={styles.linkDeskName}>
          <strong>{view.desk.displayName}</strong>
          <span>A deal for you · {view.ref}</span>
        </span>
      </a>

      <h1 className={styles.dealTitle}>{sells ? `Sell ${usdt(view.base)} for ${inr(view.inr)}` : `Buy ${usdt(view.base)} for ${inr(view.inr)}`}</h1>

      <section className={styles.ticket} aria-label="The deal">
        <div className={styles.legs}>
          <div className={styles.leg}>
            <span className={styles.legLabel}>You send</span>
            <span className={styles.legFigure}>{sells ? usdt(view.base) : inr(view.inr)}</span>
          </div>
          <div className={styles.leg}>
            <span className={styles.legLabel}>You receive</span>
            <span className={styles.legFigure}>{sells ? inr(view.inr) : usdt(view.base)}</span>
          </div>
        </div>
        <p className={styles.rateLine}>
          <span>
            Rate <strong>{rateText(view.rate)}</strong> per USDT
          </span>
          {open ? (
            <span>
              Valid for <strong className={styles.countdown}>{left < 3_600_000 ? formatCountdown(left) : `${Math.floor(left / 3_600_000)} h ${Math.floor((left % 3_600_000) / 60_000)} min`}</strong>
            </span>
          ) : null}
        </p>
        {closed ? (
          <div className={styles.closed}>
            <p className={styles.closedTitle}>{closed.title}</p>
            <p className={styles.hint}>{closed.body}</p>
            <a className={styles.signIn} href={`/${view.desk.handle}`}>
              See {view.desk.displayName}’s prices
            </a>
          </div>
        ) : (
          <>
            <a className={styles.cta} href={takeUrl}>
              Sign in and take this deal
              <svg className={styles.ctaIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12h13" />
                <path d="m13 7 5 5-5 5" />
              </svg>
            </a>
            <p className={styles.fine}>
              The first person to sign in and take it gets it, at exactly this rate. Valid until {formatIstDateTime(new Date(view.expiresAt))}.
            </p>
          </>
        )}
      </section>

      <ol className={styles.steps} aria-label="How it settles">
        <li className={styles.step}>
          <p className={styles.stepTitle}>{sells ? 'Your USDT into escrow' : 'The desk’s USDT into escrow'}</p>
          <p className={styles.stepBody}>{sells ? 'You send the USDT to the deal’s own address, held by INRP2P.' : 'The desk puts the USDT into the deal’s own address, held by INRP2P.'}</p>
        </li>
        <li className={styles.step}>
          <p className={styles.stepTitle}>Rupees, account to account</p>
          <p className={styles.stepBody}>{sells ? `${view.desk.displayName} pays the rupees straight into your bank account.` : `You pay the rupees straight into ${view.desk.displayName}’s account, from your own.`}</p>
        </li>
        <li className={styles.step}>
          <p className={styles.stepTitle}>Released on confirmation</p>
          <p className={styles.stepBody}>Once the rupees are confirmed, INRP2P releases the USDT from escrow — never before.</p>
        </li>
      </ol>
    </main>
  );
}
