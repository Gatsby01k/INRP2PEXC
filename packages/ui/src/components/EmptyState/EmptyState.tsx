import type { ReactNode } from 'react';
import { ArcMotif } from '../ArcMotif/ArcMotif.tsx';
import styles from './EmptyState.module.css';

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <section className={styles.root} aria-label={title}>
      <ArcMotif completed={0} size={32} />
      <h3 className={styles.title}>{title}</h3>
      {body ? <p className={styles.body}>{body}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </section>
  );
}
