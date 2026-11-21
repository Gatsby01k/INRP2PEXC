import { HERO, OWN_DESK } from '../../../content/site.ts';
import { appOrigin, onboardingHref } from '../../../server/site.ts';
import { Halo } from './Halo.tsx';
import { ArrowIcon, PointIcon } from './icons.tsx';
import { QuoteModule } from './QuoteModule.tsx';
import { RobotStage } from './robot/RobotStage.tsx';
import styles from './hero.module.css';

/**
 * The home page's first screen: what this is, the one thing to do here, and the desk's assistant between them.
 *
 * Rendered on the server. Two islands hydrate inside it — the quote module and the robot's stage — and they talk
 * only through `robot/cues.ts`. The words, the headline and the module all work before either island loads and
 * whether or not the robot ever does.
 */
export function Hero() {
  const { eyebrow, headline, lede, points, deal, quote } = HERO;
  return (
    <section className={styles.hero} aria-labelledby="hero-title" data-robot-scope="">
      <div className={styles.frame}>
        <div className={styles.copy}>
          {/* What is new on INRP2P: traders running their own exchange on it, further down this page. */}
          <a className={styles.announce} href="#own-desk">
            <span className={styles.announceTag}>{OWN_DESK.announce.tag}</span>
            <span className={styles.announceText}>{OWN_DESK.announce.text}</span>
            <ArrowIcon className={styles.announceArrow} />
          </a>
          <p className={styles.eyebrow}>{eyebrow}</p>
          <h1 id="hero-title" className={styles.title}>
            <span className={styles.line}>{headline.lead}</span>{' '}
            <span className={styles.line}>
              <span className={styles.accent}>{headline.accent}</span> {headline.tail}
            </span>
          </h1>
          <p className={styles.lede}>{lede}</p>
        </div>

        <ul className={styles.points}>
          {points.map((p) => (
            <li key={p.label} className={styles.point}>
              <PointIcon name={p.icon} className={styles.pointIcon} />
              <span>{p.label}</span>
            </li>
          ))}
        </ul>

        <div className={styles.stage} aria-hidden="true">
          {/* The robot stands in front of the mark's own orange: a sun, and the mark's arcs turning round it. */}
          <Halo />
          <RobotStage />
          {/* A deal, moment by moment, floating beside the robot: each step closes its ring in turn, as the workspace's
              status rings do, and the status on the visor turns to done. */}
          <div className={styles.deal}>
            <p className={styles.dealHead}>
              <span className={styles.dealLive}>{deal.live}</span>
              <span className={styles.dealStatus}>
                <span className={styles.dealStatusRun}>{deal.running}</span>
                <span className={styles.dealStatusDone}>{deal.status}</span>
              </span>
            </p>
            <ol className={styles.dealSteps}>
              {deal.steps.map((step, i) => (
                <li key={step.text} className={styles.dealStep} style={{ ['--i' as string]: i }}>
                  <span className={styles.dealIcon}>
                    <PointIcon name={step.icon} />
                  </span>
                  <span className={styles.dealText}>{step.text}</span>
                  <span className={styles.dealRing}>
                    <svg className={styles.ringWait} viewBox="0 0 20 20">
                      <circle cx="10" cy="10" r="7.2" />
                      <circle cx="10" cy="2.8" r="2.2" />
                    </svg>
                    <svg className={styles.ringDone} viewBox="0 0 20 20">
                      <circle cx="10" cy="10" r="9" />
                      <path d="M6.2 10.4l2.6 2.6 5.1-5.6" />
                    </svg>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </div>

        <div className={styles.quote}>
          <QuoteModule appOrigin={appOrigin()} onboarding={onboardingHref()} copy={quote} />
        </div>
      </div>
    </section>
  );
}
