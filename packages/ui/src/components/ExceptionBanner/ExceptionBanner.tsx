import type { ReactNode } from 'react';
import { cx } from '../../cx.ts';
import styles from './ExceptionBanner.module.css';

export interface ExceptionBannerProps {
  severity: 'blocking' | 'warning';
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}

/** Calm, explicit exception notice. Blocking = trade on hold (D-04). No flashing, no theatrics. */
export function ExceptionBanner({ severity, title, description, action }: ExceptionBannerProps) {
  return (
    <div role={severity === 'blocking' ? 'alert' : 'status'} className={cx(styles.root, styles[severity])}>
      <span className={styles.badge}>{severity === 'blocking' ? 'Exception · on hold' : 'Needs attention'}</span>
      <div className={styles.text}>
        <p className={styles.title}>{title}</p>
        {description ? <div className={styles.description}>{description}</div> : null}
      </div>
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
