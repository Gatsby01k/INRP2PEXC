import type { ReactNode } from 'react';
import styles from '../shell.module.css';

/**
 * A page's heading, across the top of the workspace: what this page is, in a line, and the page's own actions on
 * the right of it. `status` sits on the title's own line, where the eye lands first — a trade's state is part of
 * its name. `icon` is the section's glyph, drawn on a raised tile in front of the title.
 */
export function PageHead({ eyebrow, title, status, lede, aside, icon }: { eyebrow?: ReactNode; title: ReactNode; status?: ReactNode; lede?: ReactNode; aside?: ReactNode; icon?: ReactNode }) {
  return (
    <header className={styles.pageHead}>
      <div className={styles.pageHeadText}>
        {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
        <div className={styles.titleRow}>
          {icon ? (
            <span className={styles.pageGlyph} aria-hidden="true">
              {icon}
            </span>
          ) : null}
          <h1 className={styles.pageTitle}>{title}</h1>
          {status}
        </div>
        {lede ? <p className={styles.lede}>{lede}</p> : null}
      </div>
      {aside ? <div className={styles.pageHeadAside}>{aside}</div> : null}
    </header>
  );
}
