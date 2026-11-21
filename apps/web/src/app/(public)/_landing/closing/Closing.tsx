import { getImageProps } from 'next/image';
import { CLOSING, ONBOARDING, TELEGRAM, TRADER_ENTRY, telegramUrl } from '../../../../content/site.ts';
import { appOrigin, onboardingHref, siteContacts } from '../../../../server/site.ts';
import { ArrowIcon, TelegramIcon } from '../icons.tsx';
import { Led } from '../led/Led.tsx';
import wave from '../robot/stills/robot-wave.webp';
import styles from './closing.module.css';

/**
 * The page's last word, on the mark's orange: one call to action for a client, the robot waving beside it, and under
 * them the two ways in for someone who is not a client yet — opening an account, or applying as a trader — and
 * INRP2P on Telegram: its two channels and the CEO. No second pair of Buy and Sell buttons: the direction is chosen
 * in the request itself.
 */
export function Closing() {
  const { heading, body, cta, newClient } = CLOSING;
  const { desk } = siteContacts();
  const onboarding = onboardingHref();
  const { props: robot } = getImageProps({ src: wave, alt: '', width: 460, height: 460, sizes: '(max-width: 1099px) 260px, 460px' });
  return (
    <section className={styles.closing} aria-labelledby="closing-title" data-field-light="">
      {/* The room's dotted orbits, turning slowly behind the robot: light and texture, never the mark itself. */}
      <svg className={styles.mark} viewBox="0 0 1400 1400" fill="none" aria-hidden="true" focusable="false">
        <g stroke="currentColor" strokeLinecap="round" strokeWidth="2">
          <circle cx="700" cy="700" r="380" strokeDasharray="2 13" />
          <circle cx="700" cy="700" r="520" strokeDasharray="2 17" opacity="0.75" />
          <circle cx="700" cy="700" r="660" strokeDasharray="2 22" opacity="0.5" />
        </g>
        <circle cx="431.3" cy="968.7" r="7" fill="currentColor" />
        <circle cx="1067.7" cy="332.3" r="6" fill="currentColor" opacity="0.8" />
        <circle cx="233.3" cy="233.3" r="6" fill="currentColor" opacity="0.7" />
      </svg>
      <div className={styles.inner}>
        <div className={styles.main}>
          <h2 id="closing-title" className={styles.title}>
            {heading}
          </h2>
          <p className={styles.body}>{body}</p>
          <a className={styles.cta} href={`${appOrigin()}${cta.appPath}`}>
            <span className={styles.ctaSheen} aria-hidden="true" />
            {cta.label}
            <ArrowIcon className={styles.ctaArrow} />
          </a>
        </div>
        {/* The robot waves goodbye, and its visor says whose move it is now — the workspace's own words for it. */}
        <div className={styles.robot} aria-hidden="true">
          <img {...robot} className={styles.robotImg} loading="lazy" decoding="async" />
          <span className={styles.visor}>
            <Led text={`${CLOSING.robot} →`} mode="marquee" pitch={7} rows={15} speed={14} className={styles.visorLed} />
          </span>
        </div>
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
        <nav className={styles.telegram} aria-label={TELEGRAM.title}>
          <p className={styles.telegramTitle}>{TELEGRAM.title}</p>
          <ul className={styles.telegramList}>
            {[...TELEGRAM.channels, TELEGRAM.ceo].map((t) => (
              <li key={t.handle}>
                <a className={styles.telegramLink} href={telegramUrl(t.handle)} target="_blank" rel="noopener">
                  <span className={styles.telegramIcon}>
                    <TelegramIcon />
                  </span>
                  <span className={styles.telegramText}>
                    <span className={styles.telegramLabel}>{t.label}</span>
                    <span className={styles.telegramHandle}>@{t.handle}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </section>
  );
}
