import { TRUST } from '../../../../content/site.ts';
import { Record } from './Record.tsx';
import { TrustStage } from './TrustStage.tsx';
import styles from './trust.module.css';

/**
 * Operational trust: the controls every trade runs under, read beside the record they leave.
 *
 * On a wide screen the controls scroll past a trade record that stays in view, and the control being read lights
 * the lines it is responsible for (TrustStage.tsx marks which one that is). On a phone each control carries its
 * own excerpt of the record instead. The record is a drawing — hidden from assistive technology, because every
 * fact in it is also said, in full, in the control it illustrates.
 */
export function Trust() {
  const { eyebrow, heading, lede, controls } = TRUST;
  return (
    <section id="controls" className={styles.trust} aria-labelledby="trust-title" data-trust="">
      <div className={styles.inner}>
        <header className={styles.head}>
          <div>
            <p className={styles.eyebrow}>{eyebrow}</p>
            <h2 id="trust-title" className={styles.title}>
              {heading}
            </h2>
          </div>
          <p className={styles.lede}>{lede}</p>
        </header>

        <div className={styles.layout}>
          <ol className={styles.controls}>
            {controls.map((c) => (
              <li key={c.key} className={styles.control} data-trust-control={c.key}>
                <p className={styles.label}>{c.label}</p>
                <h3 className={styles.controlTitle}>{c.title}</h3>
                <p className={styles.controlBody}>{c.body}</p>
                <div className={styles.excerptFrame} aria-hidden="true">
                  <Record only={c.key} />
                </div>
              </li>
            ))}
          </ol>

          <div className={styles.aside} aria-hidden="true">
            <div className={styles.stand}>
              <Record />
            </div>
          </div>
        </div>
        <TrustStage />
      </div>
    </section>
  );
}
