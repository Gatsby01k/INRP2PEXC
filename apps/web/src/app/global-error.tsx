'use client';

import './globals.css';
import { SERVER_ERROR } from '../content/errors.ts';
import styles from './not-found.module.css';

/**
 * The last line under every page: a failure nothing nearer caught — a page that threw while drawing, a script that broke
 * in an old browser — gets this, in the site's room, instead of the framework's "Application error" on a white page.
 * It replaces the root layout while it shows, so it brings its own document. One button loads the page again, which is
 * what a person would do anyway; the other goes home. The error itself is already in the browser's console and, for
 * the server, in the function's log — nothing about it is shown here.
 */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <head>
        <title>{`${SERVER_ERROR.title} | ${SERVER_ERROR.brand}`}</title>
        <meta name="robots" content="noindex" />
      </head>
      <body>
        <div className={styles.room}>
          <header className={styles.bar}>
            <a href="/" className={styles.brand}>
              <span>{SERVER_ERROR.brand}</span>
            </a>
          </header>
          <main className={styles.main}>
            <h1 className={styles.heading}>{SERVER_ERROR.heading}</h1>
            <p className={styles.body}>{SERVER_ERROR.body}</p>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.primary}
                onClick={() => {
                  // A fresh load, not only a re-render: what failed may have been a script this page no longer has.
                  if (typeof window !== 'undefined') window.location.reload();
                  else reset();
                }}
              >
                {SERVER_ERROR.retry}
              </button>
              <a href="/" className={styles.secondary}>
                {SERVER_ERROR.home}
              </a>
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}
