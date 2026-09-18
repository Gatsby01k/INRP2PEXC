import { inrView } from '@inrp2p/desk';
import { can, operatorPage } from '../../../server/operator.ts';
import { InrClient } from './InrClient.tsx';
import styles from '../shell.module.css';

export const dynamic = 'force-dynamic';

export default async function InrPage() {
  const ctx = await operatorPage();
  const view = await inrView(ctx.db);
  return (
    <>
      <header className={styles.header}>
        <h1 className={styles.title}>INR</h1>
        <span className="ix-muted">{view.istDay} IST</span>
      </header>
      <div className={styles.content}>
        <InrClient view={view} canChangeCapacity={can(ctx, 'capacity:change')} />
      </div>
    </>
  );
}
