'use client';

import { useState } from 'react';
import { stopRobotByLinkAction } from '../../../server/actions/robot-quiet.ts';
import styles from './quiet.module.css';

export function QuietForm({ link }: { link: string }) {
  const [state, setState] = useState<'ASK' | 'BUSY' | 'DONE' | 'INVALID'>('ASK');
  async function stop() {
    setState('BUSY');
    const out = await stopRobotByLinkAction({ link }).catch(() => ({ stopped: false }));
    setState(out.stopped ? 'DONE' : 'INVALID');
  }
  if (state === 'DONE') return <p className={styles.done} role="status">Done. The robot won’t write to you outside the app.</p>;
  if (state === 'INVALID') return <p className={styles.done} role="alert">This link does not work any more. Change what the robot sends you in the app, under The robot.</p>;
  return (
    <button type="button" className={styles.button} onClick={() => void stop()} disabled={state === 'BUSY'} aria-busy={state === 'BUSY'}>
      Stop its messages
    </button>
  );
}
