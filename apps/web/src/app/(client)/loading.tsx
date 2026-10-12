import shell from './shell.module.css';
import styles from './_workspace/skeleton.module.css';

/**
 * What the workspace shows in the instant between a click and the server's answer: the page's own shape, drawn in
 * quiet placeholders, so a section change feels immediate and nothing jumps when the real page arrives.
 */
export default function Loading() {
  return (
    <>
      <header className={shell.pageHead} aria-hidden="true">
        <div className={shell.pageHeadText}>
          <span className={styles.title} />
          <span className={styles.line} />
        </div>
      </header>
      <main className={shell.main} aria-busy="true" aria-label="Loading">
        <div className={styles.block} data-size="lg" />
        <div className={styles.block} />
      </main>
      <aside className={shell.aside} aria-hidden="true">
        <div className={styles.block} data-size="sm" />
      </aside>
    </>
  );
}
