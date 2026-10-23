import type { ReactNode } from 'react';
import { PageHead } from '../../_workspace/PageHead.tsx';
import { DeskTabs } from './DeskTabs.tsx';
import styles from '../desk.module.css';

/** A desk page's heading: the page head, then the desk's sections. Takes the workspace's heading row. */
export function DeskHead({ eyebrow = 'Your desk', title, status, lede, aside, waiting }: { eyebrow?: ReactNode; title: ReactNode; status?: ReactNode; lede?: ReactNode; aside?: ReactNode; waiting?: number }) {
  return (
    <div className={styles.head}>
      <PageHead eyebrow={eyebrow} title={title} status={status} lede={lede} aside={aside} />
      <DeskTabs {...(waiting === undefined ? {} : { waiting })} />
    </div>
  );
}
