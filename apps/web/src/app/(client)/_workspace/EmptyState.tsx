import type { ReactNode } from 'react';
import styles from './workspace.module.css';

/**
 * What a page says when there is nothing to show: what would be here, how it gets here, and — where the client can
 * do something about it — the one way to do it. Never a dead end, never a promise the product does not keep.
 */
export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyIcon} aria-hidden="true">
        {icon}
      </span>
      <p className={styles.emptyTitle}>{title}</p>
      <p className={styles.emptyBody}>{body}</p>
      {action ? <div className={styles.emptyAction}>{action}</div> : null}
    </div>
  );
}
