import { workspacePage } from '../../../server/client.ts';
import { robotBriefFor } from '../../../server/robot.ts';
import { PageHead } from '../_workspace/PageHead.tsx';
import { RobotPanel } from '../_robot/RobotPanel.tsx';
import styles from '../_robot/robot.module.css';

export const dynamic = 'force-dynamic';

/**
 * The robot's own page (ADR 0034): what it shows in the masthead, with room — where a note from it or the desk's answer
 * to a question links to, and where a phone opens it.
 */
export default async function RobotPage() {
  const ctx = await workspacePage();
  const brief = await robotBriefFor(ctx.db, ctx.access);
  return (
    <>
      <PageHead title="Bhai" lede="Your INRP2P robot: what matters now, what it is doing for you, and what it may send you outside the app." />
      <div className={styles.page}>{brief ? <RobotPanel brief={brief} /> : null}</div>
    </>
  );
}
