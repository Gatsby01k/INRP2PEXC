import { CLOSING, ONBOARDING } from '../../../../content/site.ts';
import { appOrigin, onboardingHref, siteContacts } from '../../../../server/site.ts';
import { ArrowIcon } from '../icons.tsx';
import styles from './closing.module.css';

/**
 * The page's last word, on the dark field the footer continues: one call to action for a client, and the way in
 * for someone who is not one yet — what the desk sets up before a first trade, and a message to the desk asking
 * for it, when an address to write to has been configured. No second pair of Buy and Sell buttons: the direction
 * is chosen in the request itself.
 */
export function Closing() {
  const { heading, body, cta, newClient } = CLOSING;
  const { desk } = siteContacts();
  const onboarding = onboardingHref();
  return (
    <section className={styles.closing} aria-labelledby="closing-title">
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
        <div className={styles.newClient}>
          <h3 className={styles.newTitle}>{newClient.title}</h3>
          <p className={styles.newBody}>{newClient.body}</p>
          {onboarding && desk ? (
            <a className={styles.contact} href={onboarding}>
              <span className={styles.contactLabel}>{ONBOARDING.label}</span>
              <span className={styles.contactAddress}>{desk}</span>
            </a>
          ) : null}
        </div>
      </div>
    </section>
  );
}
