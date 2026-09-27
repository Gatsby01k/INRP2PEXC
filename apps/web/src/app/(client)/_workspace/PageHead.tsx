import type { ReactNode } from 'react';
import styles from '../shell.module.css';

/** A page's heading, across the top of the workspace: what this page is, in a line, and anything that belongs beside it. */
export function PageHead({ eyebrow, title, lede, aside }: { eyebrow?: ReactNode; title: ReactNode; lede?: ReactNode; aside?: ReactNode }) {
  return (
    <header className={styles.pageHead}>
      <div className={styles.pageHeadText}>
        {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
        <h1 className={styles.pageTitle}>{title}</h1>
        {lede ? <p className={styles.lede}>{lede}</p> : null}
      </div>
      {aside}
    </header>
  );
}
