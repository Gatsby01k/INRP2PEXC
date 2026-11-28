import type { Metadata } from 'next';
import { QuietForm } from './QuietForm.tsx';
import { RobotFace } from '../../(client)/_robot/RobotFace.tsx';
import styles from './quiet.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Stop the robot’s messages · INRP2P', robots: { index: false, follow: false }, referrer: 'no-referrer' };

/**
 * The link at the foot of the robot's email (ADR 0034 §2.4). Opening it changes nothing — mail scanners open links — the
 * person presses the button. It stops the robot's messages outside the app to the one person the email was for; deal
 * alerts, codes and the inbox are untouched.
 */
export default async function RobotQuietPage({ params }: { params: Promise<{ link: string }> }) {
  const { link } = await params;
  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <RobotFace face="sleep" size={72} />
        <h1 className={styles.title}>Stop Bhai’s messages?</h1>
        <p className={styles.body}>
          Bhai, the INRP2P robot, will not email or message you with suggestions any more. Your deal alerts, sign-in codes and everything in the app stay as they are — and you can turn its
          messages back on in the app at any time.
        </p>
        <QuietForm link={decodeURIComponent(link)} />
      </section>
    </main>
  );
}
