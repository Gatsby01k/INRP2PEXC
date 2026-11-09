import type { ReactNode } from 'react';
import Link from 'next/link';
import styles from '../shell.module.css';
import { ChevronIcon } from './icons.tsx';

/** Every workspace page opens with its heading, so a full load holds its first paint until this has been read (`layout.tsx`). */
export const PAGE_HEAD_ID = 'page-head';

/**
 * A page's heading, across the top of the workspace: where the page sits (`back` and `eyebrow`, as a trail), what
 * this page is, in a line, and the page's own actions on the right of it. `status` sits on the title's own line,
 * where the eye lands first — a trade's state is part of its name. `icon` is accepted for the pages that still pass
 * one; the bar above already says which section this is, so it is not drawn.
 */
export function PageHead({
  eyebrow,
  back,
  title,
  status,
  lede,
  aside,
}: {
  eyebrow?: ReactNode;
  back?: { readonly href: string; readonly label: string };
  title: ReactNode;
  status?: ReactNode;
  lede?: ReactNode;
  aside?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <header id={PAGE_HEAD_ID} className={styles.pageHead}>
      <div className={styles.pageHeadText}>
        {back || eyebrow ? (
          <p className={styles.eyebrow}>
            {back ? <Link href={back.href}>{back.label}</Link> : null}
            {back && eyebrow ? <ChevronIcon className={styles.crumbSep} /> : null}
            {eyebrow ? <span>{eyebrow}</span> : null}
          </p>
        ) : null}
        <div className={styles.titleRow}>
          <h1 className={styles.pageTitle}>{title}</h1>
          {status}
        </div>
        {lede ? <p className={styles.lede}>{lede}</p> : null}
      </div>
      {aside ? <div className={styles.pageHeadAside}>{aside}</div> : null}
    </header>
  );
}
