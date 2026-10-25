import { getImageProps } from 'next/image';
import { CLOSING, ONBOARDING, TRADER_ENTRY } from '../../../../content/site.ts';
import { MarkArt } from '../../../../components/MarkArt.tsx';
import { appOrigin, onboardingHref, siteContacts } from '../../../../server/site.ts';
import { ArrowIcon } from '../icons.tsx';
import wave from '../robot/stills/robot-wave.webp';
import styles from './closing.module.css';

/**
 * The page's last word, on the mark's orange: one call to action for a client, the robot waving beside it, and under
 * them the two ways in for someone who is not a client yet — opening an account, or applying as a trader. No second
 * pair of Buy and Sell buttons: the direction is chosen in the request itself.
 */
export function Closing() {
  const { heading, body, cta, newClient } = CLOSING;
  const { desk } = siteContacts();
  const onboarding = onboardingHref();
  const { props: robot } = getImageProps({ src: wave, alt: '', width: 460, height: 460, sizes: '(max-width: 1099px) 260px, 460px' });
  return (
    <section className={styles.closing} aria-labelledby="closing-title">
      <MarkArt className={styles.mark} hub={false} />
      <div className={styles.inner}>
        <div className={styles.main}>
          <h2 id="closing-title" className={styles.title}>
            {heading}
          </h2>
          <p className={styles.body}>{body}</p>
          <a className={styles.cta} href={`${appOrigin()}${cta.appPath}`}>
            {cta.label}
            <ArrowIcon className={styles.ctaArrow} />
          </a>
        </div>
        <img {...robot} className={styles.robot} loading="lazy" decoding="async" aria-hidden="true" />
        <div className={styles.ways}>
          <div className={styles.way}>
            <h3 className={styles.wayTitle}>{newClient.title}</h3>
            <p className={styles.wayBody}>{newClient.body}</p>
            <a className={styles.contact} href={onboarding}>
              <span className={styles.contactLabel}>{ONBOARDING.label}</span>
              <span className={styles.contactAddress}>{desk ? `Questions first? ${desk}` : 'With your work email'}</span>
            </a>
          </div>
          <div className={styles.way}>
            <h3 className={styles.wayTitle}>{TRADER_ENTRY.title}</h3>
            <p className={styles.wayBody}>{TRADER_ENTRY.body}</p>
            <a className={styles.contact} href={`${appOrigin()}${TRADER_ENTRY.appPath}`}>
              <span className={styles.contactLabel}>{TRADER_ENTRY.label}</span>
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
