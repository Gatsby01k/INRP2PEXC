import { TRUST } from '../../../../content/site.ts';
import { Record } from './Record.tsx';
import { TrustStage } from './TrustStage.tsx';
import styles from './trust.module.css';

/**
 * Operational trust: the controls every trade runs under, read one at a time beside the record they leave.
 *
 * The five controls are a single-open accordion: every control's title is always on the page, so the five claims
 * read at a glance, and the one open shows how it works. The record beside them lights the lines the open
 * control is responsible for; on a phone, where there is no room beside, the open control carries its own
 * excerpt of the record instead. The record is a drawing — hidden from assistive technology, because every fact
 * in it is also said, in full, in the control it illustrates.
 *
 * Server markup, with the first control open. One small island (TrustStage.tsx) opens the others and holds the
 * record's switch between a Buy USDT and a Sell USDT example.
 */
export function Trust() {
  const { eyebrow, heading, lede, controls, direction } = TRUST;
  const first = controls[0]!.key;
  return (
    <section id="controls" className={styles.trust} aria-labelledby="trust-title" data-trust="" data-active={first}>
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
            {controls.map((c) => {
              const open = c.key === first;
              return (
                <li key={c.key} className={styles.control} data-trust-control={c.key} data-open={open ? '' : undefined}>
                  <h3 className={styles.controlHead}>
                    <button
                      type="button"
                      id={`control-${c.key}`}
                      className={styles.toggle}
                      aria-expanded={open}
                      aria-controls={`control-${c.key}-body`}
                      {...(open ? { 'aria-disabled': true } : {})}
                      data-trust-toggle={c.key}
                    >
                      <span className={styles.label}>{c.label}</span>
                      <span className={styles.controlTitle}>{c.title}</span>
                    </button>
                  </h3>
                  <div id={`control-${c.key}-body`} className={styles.panel}>
                    <div className={styles.panelInner}>
                      <p className={styles.controlBody}>{c.body}</p>
                      <div className={styles.excerptFrame} aria-hidden="true">
                        <Record only={c.key} />
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>

          <div className={styles.tools}>
            <TrustStage copy={direction} />
          </div>

          <div className={styles.aside} aria-hidden="true">
            <div className={styles.stand}>
              <Record />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
