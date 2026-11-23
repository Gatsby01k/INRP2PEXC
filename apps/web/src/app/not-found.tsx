import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { getImageProps } from 'next/image';
import mark from '../../../../brand/inrp2p-mark.png';
import { NOT_FOUND, SITE_NAME, pageForPath } from '../content/site.ts';
import { hostConfig } from '../server/hosts.ts';
import { TRADERS_PATH, surfaceForHost } from '../server/surface.ts';
import worried from './(public)/_landing/robot/stills/robot-worried.webp';
import styles from './not-found.module.css';

export const metadata: Metadata = {
  title: `${NOT_FOUND.title} | ${SITE_NAME}`,
  robots: { index: false, follow: true },
};

/**
 * Every address nothing answers — a mistyped path, a retired page, a desk handle nobody holds — on every host, instead of
 * the framework's bare line: the robot looking worried, what happened, and the ways back. On the public site it also
 * offers the guides people most often came for; on the app's and the desk's hosts, only the way back to their start.
 * It is drawn on its own, in the site's room, so it reads the same whichever page sent the visitor here.
 */
export default async function NotFound() {
  const surface = surfaceForHost((await headers()).get('host'), hostConfig());
  const site = surface === 'PUBLIC';
  const { props: markProps } = getImageProps({ src: mark, alt: '', width: 32, height: 32 });
  const { props: robot } = getImageProps({ src: worried, alt: '', width: 240, height: 240, sizes: '(max-width: 559px) 180px, 240px' });
  const guides = site ? NOT_FOUND.guidePaths.flatMap((path) => (pageForPath(path) ? [{ path, label: pageForPath(path)!.h1 }] : [])) : [];
  return (
    <div className={styles.room}>
      <header className={styles.bar}>
        <a href="/" className={styles.brand}>
          <img {...markProps} className={styles.mark} />
          <span>{SITE_NAME}</span>
        </a>
      </header>
      <main className={styles.main}>
        <img {...robot} className={styles.robot} fetchPriority="high" />
        <p className={styles.eyebrow}>{NOT_FOUND.eyebrow}</p>
        <h1 className={styles.heading}>{NOT_FOUND.heading}</h1>
        <p className={styles.body}>{NOT_FOUND.body}</p>
        <div className={styles.actions}>
          <a href="/" className={styles.primary}>
            {site ? NOT_FOUND.home : NOT_FOUND.back}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </a>
          {site ? (
            <a href={TRADERS_PATH} className={styles.secondary}>
              {NOT_FOUND.traders}
            </a>
          ) : null}
        </div>
        {guides.length > 0 ? (
          <nav className={styles.guides} aria-label={NOT_FOUND.guides}>
            <p className={styles.guidesLabel}>{NOT_FOUND.guides}</p>
            <ul>
              {guides.map((g) => (
                <li key={g.path}>
                  <a href={g.path}>{g.label}</a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </main>
    </div>
  );
}
