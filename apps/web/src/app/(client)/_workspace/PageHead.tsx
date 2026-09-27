import type { ReactNode } from 'react';
import styles from '../shell.module.css';

/**
 * A page's heading, across the top of the workspace: what this page is, in a line, and anything that belongs beside
 * it. `status` sits on the title's own line, where the eye lands first — a trade's state is part of its name.
 */
export function PageHead({ eyebrow, title, status, lede, aside }: { eyebrow?: ReactNode; title: ReactNode; status?: ReactNode; lede?: ReactNode; aside?: ReactNode }) {
  return (
    <header className={styles.pageHead}>
      <div className={styles.pageHeadText}>
        {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
        <div className={styles.titleRow}>
          <h1 className={styles.pageTitle}>{title}</h1>
          {status}
        </div>
        {lede ? <p className={styles.lede}>{lede}</p> : null}
      </div>
      {aside}
    </header>
  );
}
