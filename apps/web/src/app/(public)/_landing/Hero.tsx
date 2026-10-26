import { HERO, OWN_DESK } from '../../../content/site.ts';
import { appOrigin, onboardingHref } from '../../../server/site.ts';
import { Halo } from './Halo.tsx';
import { ArrowIcon, CheckIcon, PointIcon } from './icons.tsx';
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
          {/* A deal, moment by moment, floating beside the robot: each step ticks off in turn. */}
          <div className={styles.deal}>
            <p className={styles.dealHead}>
              <span>{deal.title}</span>
              <span className={styles.dealStatus}>{deal.status}</span>
            </p>
            <ol className={styles.dealSteps}>
              {deal.steps.map((step, i) => (
                <li key={step.text} className={styles.dealStep} style={{ ['--i' as string]: i }}>
                  <span className={styles.dealIcon}>
                    <PointIcon name={step.icon} />
                  </span>
                  <span className={styles.dealText}>{step.text}</span>
                  <CheckIcon className={styles.dealCheck} />
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
