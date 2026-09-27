'use client';

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { RobotMood } from '../../(public)/_landing/robot/cues.ts';
import { liveRobotAllowed, whenSettled } from '../../(public)/_landing/robot/RobotStage.tsx';
import stage from '../../(public)/_landing/robot/robot.module.css';
import { STILLS } from './stills.ts';
import styles from './assistant.module.css';

const RobotCanvas = lazy(() => import('../../(public)/_landing/robot/RobotCanvas.tsx'));

/** The width from which the workspace stands the robot beside the page (`shell.module.css`). */
const WIDE = '(min-width: 1200px)';

const MOODS = Object.keys(STILLS) as RobotMood[];

/**
 * The home page's robot, in the workspace: the same figure, still images and live scene, standing to the right of
 * the page as its execution assistant.
 *
 * It lives in the workspace's layout, not in a page, so it stays through client-side navigation — it greets once
 * on arrival and then simply follows what each page reports. A page reports through its status (`AssistantPanel`):
 * the mood goes to the live robot as a cue, and the page's `data-assistant-mood` picks which still is shown until
 * the live robot is in (and instead of it, wherever it never runs). Each still is lazy, so only the one shown is
 * fetched — and the page's server render already names it, so the first paint shows the right face.
 *
 * Only on a desktop. Narrower, the page's status carries a small still of its own and three.js is never loaded.
 */
export function AssistantRobot() {
  const box = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState<HTMLElement | null>(null);
  const [live, setLive] = useState(false);
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState(true);

  useEffect(() => {
    setScope(box.current?.closest<HTMLElement>('[data-robot-scope]') ?? null);
    const wide = window.matchMedia(WIDE);
    let cancel = () => {};
    const start = () => {
      if (!wide.matches || !liveRobotAllowed()) return;
      wide.removeEventListener('change', start);
      cancel = whenSettled(() => setLive(true));
    };
    wide.addEventListener('change', start);
    start();
    return () => {
      wide.removeEventListener('change', start);
      cancel();
    };
  }, []);

  // Scrolled out of view on a long history, the robot stops drawing rather than animating for nobody.
  useEffect(() => {
    const el = box.current;
    if (!el || !live) return;
    const observer = new IntersectionObserver(([entry]) => setActive(Boolean(entry?.isIntersecting)), { rootMargin: '96px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [live]);

  return (
    <div ref={box} className={`${stage.stage} ${styles.stage}`} data-state={ready ? 'live' : 'still'}>
      {MOODS.map((mood) => (
        <img
          key={mood}
          className={`${stage.poster} ${styles.still}`}
          data-mood={mood}
          src={STILLS[mood].src}
          width={STILLS[mood].width}
          height={STILLS[mood].height}
          alt=""
          loading="lazy"
          decoding="async"
        />
      ))}
      {live ? (
        <Suspense fallback={null}>
          <RobotCanvas
            className={stage.canvas}
            scope={scope}
            active={active}
            mirror
            onReady={() => setReady(true)}
            onLost={() => {
              setReady(false);
              setLive(false);
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
