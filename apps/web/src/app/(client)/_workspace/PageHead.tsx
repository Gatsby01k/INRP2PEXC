import type { ReactNode } from 'react';
import Link from 'next/link';
import styles from '../shell.module.css';
import { ChevronIcon } from './icons.tsx';
import { Hint } from './Hint.tsx';

/** Every workspace page opens with its heading, so a full load holds its first paint until this has been read (`layout.tsx`). */
export const PAGE_HEAD_ID = 'page-head';

/**
 * A page's heading, across the top of the workspace: where the page sits (`back` and `eyebrow`, as a trail), what
 * this page is, in a line, and the page's own actions on the right of it. `status` sits on the title's own line,
 * where the eye lands first — a trade's state is part of its name. `icon` is accepted for the pages that still pass
 * one; the bar above already says which section this is, so it is not drawn.
 *
 * A page says what is happening, not what the page is for: a `lede` given as words is kept one tap away, on the
 * ring beside the title (`Hint`), and only a lede that carries the page's state (anything but a string) is printed.
 */
export function PageHead({
  eyebrow,
  back,
  title,
  display,
  status,
  lede,
  aside,
}: {
  eyebrow?: ReactNode;
  back?: { readonly href: string; readonly label: string };
  title: ReactNode;
  /**
   * What the page is about right now, set large — "Sell 10,000 USDT" — while `title` stays the page's name, set as the
   * line above it (still the page's one heading, so its name never changes as its state does).
   */
  display?: ReactNode;
  status?: ReactNode;
  lede?: ReactNode;
  aside?: ReactNode;
  icon?: ReactNode;
}) {
  if (display) {
    return (
      <header id={PAGE_HEAD_ID} className={styles.pageHead}>
        <div className={styles.pageHeadText}>
          <div className={styles.eyebrow}>
            <h1 className={styles.eyebrowHeading}>{title}</h1>
            {eyebrow ? <span>· {eyebrow}</span> : null}
          </div>
          <div className={styles.titleRow}>
            <p className={styles.pageTitle}>{display}</p>
            {status}
            {typeof lede === 'string' ? <Hint label={`About ${typeof title === 'string' ? title : 'this page'}`}>{lede}</Hint> : null}
          </div>
          {lede && typeof lede !== 'string' ? <p className={styles.lede}>{lede}</p> : null}
        </div>
        {aside ? <div className={styles.pageHeadAside}>{aside}</div> : null}
      </header>
    );
  }
  return (
    <header id={PAGE_HEAD_ID} className={styles.pageHead}>
      <div className={styles.pageHeadText}>
        {back || eyebrow ? (
          <p className={back ? styles.crumb : styles.eyebrow}>
            {back ? <Link href={back.href}>{back.label}</Link> : null}
            {back && eyebrow ? <ChevronIcon className={styles.crumbSep} /> : null}
            {eyebrow ? <span>{eyebrow}</span> : null}
          </p>
        ) : null}
        <div className={styles.titleRow}>
          <h1 className={styles.pageTitle}>{title}</h1>
          {status}
          {typeof lede === 'string' ? <Hint label={`About ${typeof title === 'string' ? title : 'this page'}`}>{lede}</Hint> : null}
        </div>
        {lede && typeof lede !== 'string' ? <p className={styles.lede}>{lede}</p> : null}
      </div>
      {aside ? <div className={styles.pageHeadAside}>{aside}</div> : null}
    </header>
  );
}
