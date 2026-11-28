'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import type { RobotBrief, RobotFace as Face } from '@inrp2p/robot';
import { type RobotCue, type RobotMood, robotCues } from '../../(public)/_landing/robot/cues.ts';
import { markRobotSeenAction } from '../../../server/actions/robot.ts';
import { Sheet } from '../_workspace/Sheet.tsx';
import { RobotFace } from './RobotFace.tsx';
import { RobotPanel } from './RobotPanel.tsx';
import { ROBOT_OPEN_EVENT } from './open.ts';
import styles from './robot.module.css';

/** The page's own state, as the small robot's face, while the robot itself has nothing more pressing to show. */
const MOOD_FACE: Partial<Record<RobotMood, Face>> = { focused: 'look', waiting: 'dots', verifying: 'dots', success: 'happy', alert: 'alert' };

/** How long a reaction to something the person just did holds the face before it rests again. */
const REACTION_MS = 1800;
/** Moving between pages reads the brief again at most this often; coming back to the tab always does. */
const REREAD_MS = 60_000;

/**
 * The robot in the masthead, on every page of the workspace (ADR 0034 §2.7). It never pops up and never interrupts: it
 * makes a face — the one its brief calls for, or the page's own state while it rests — reacts to what the person does on
 * the page (a hop and `^ ^` when something went through, wide eyes when something needs fixing), and lights its antenna
 * when it has something new to say. Opened, it says it.
 *
 * It reads its brief after the page has drawn (`/api/client/robot`), again when the tab comes back and — at most once a
 * minute — on a move between pages, so no page waits for it and browsing costs nothing; before that it is simply calm.
 */
export function RobotPresence() {
  const pathname = usePathname();
  const [brief, setBrief] = useState<RobotBrief | null>(null);
  const [open, setOpen] = useState(false);
  const [pageMood, setPageMood] = useState<RobotMood>(() => robotCues.mood());
  const [reaction, setReaction] = useState<Face | null>(null);
  // A stage's "Ask me" (`openRobot`): open the conversation with the question box ready, reading the brief first if
  // there is none yet.
  const [askFirst, setAskFirst] = useState(false);
  const timer = useRef<number | null>(null);
  const lastRead = useRef(0);

  const read = useCallback(async () => {
    if (document.visibilityState !== 'visible') return;
    lastRead.current = Date.now();
    try {
      const res = await fetch('/api/client/robot', { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) return;
      const body = (await res.json()) as { brief: RobotBrief | null };
      setBrief(body.brief);
    } catch {
      // A missed read leaves the robot as it was; the next page or the tab coming back reads again.
    }
  }, []);

  useEffect(() => {
    document.addEventListener('visibilitychange', read);
    return () => document.removeEventListener('visibilitychange', read);
  }, [read]);
  useEffect(() => {
    if (Date.now() - lastRead.current >= REREAD_MS) void read();
  }, [pathname, read]);

  // What the person does on the page reaches the robot as the landing's cues; it answers in its face, briefly.
  useEffect(() => {
    const react = (face: Face) => {
      setReaction(face);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setReaction(null), REACTION_MS);
    };
    const off = robotCues.subscribe((cue: RobotCue) => {
      if (cue.kind === 'mood') setPageMood(cue.mood);
      else if (cue.kind === 'submitted' || cue.kind === 'lock') react('happy');
      else if (cue.kind === 'problem') react('alert');
      else if (cue.kind === 'rate') react('star');
      else if (cue.kind === 'wait') setReaction(cue.on ? 'dots' : null);
    });
    return () => {
      off();
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    const onAsk = () => {
      setAskFirst(true);
      if (brief) show();
      else void read().then(() => setOpen(true));
    };
    window.addEventListener(ROBOT_OPEN_EVENT, onAsk);
    return () => window.removeEventListener(ROBOT_OPEN_EVENT, onAsk);
  });

  const resting = !brief || brief.kind === 'REST';
  const face: Face = reaction ?? (resting ? (MOOD_FACE[pageMood] ?? brief?.face ?? 'calm') : brief.face);
  const news = Boolean(brief?.isNew) && !open && brief!.kind !== 'REST';

  function show() {
    setOpen(true);
    if (brief?.isNew) {
      setBrief({ ...brief, isNew: false });
      void markRobotSeenAction({ key: brief.key }).catch(() => {});
    }
  }

  const label = brief && brief.kind !== 'REST' ? `Bhai: ${brief.title}` : 'Bhai, your INRP2P robot';
  return (
    <>
      <button
        type="button"
        className={styles.presence}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={show}
        {...(reaction === 'happy' || reaction === 'alert' ? { 'data-react': '' } : {})}
      >
        <RobotFace face={face} news={news} size={36} />
      </button>
      {brief ? (
        <Sheet
          open={open}
          onClose={() => {
            setOpen(false);
            setAskFirst(false);
          }}
          title="Bhai"
          eyebrow="INRP2P"
          description="Your INRP2P robot: what matters now, and what it is doing for you."
        >
          <RobotPanel brief={brief} onNavigate={() => setOpen(false)} onChange={() => void read()} focusAsk={askFirst} />
        </Sheet>
      ) : null}
    </>
  );
}
