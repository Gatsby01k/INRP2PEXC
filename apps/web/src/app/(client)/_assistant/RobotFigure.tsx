'use client';

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { RobotMood } from '../../(public)/_landing/robot/cues.ts';
import { liveRobotAllowed, whenSettled } from '../../(public)/_landing/robot/RobotStage.tsx';
import stage from '../../(public)/_landing/robot/robot.module.css';
import { STILLS } from './stills.ts';
import styles from './assistant.module.css';

const RobotCanvas = lazy(() => import('../../(public)/_landing/robot/RobotCanvas.tsx'));

/** The width from which the figure may come alive; narrower, its still is enough and three.js is never loaded. */
const WIDE = '(min-width: 900px)';

const MOODS = Object.keys(STILLS) as RobotMood[];

/**
 * The home page's robot, standing on a stage of its own inside a page: where a new client is welcomed, and where
 * something they did has just come right. Its still for `mood` is drawn first — the server render already names
 * it — and on a capable desktop the live figure takes over from it without a seam. The live figure takes its mood
 * from the page's cues (`useAssistantState`), and follows the pointer inside the workspace.
 *
 * Everywhere else in the workspace the robot is a face beside a status (`AssistantPanel`): the work is the page.
 */
export function RobotFigure({ mood, className, live: allowLive = true }: { mood: RobotMood; className?: string | undefined; live?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState<HTMLElement | null>(null);
  const [live, setLive] = useState(false);
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState(true);

  useEffect(() => {
    if (!allowLive) return;
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
  }, [allowLive]);

  // Scrolled out of view, the figure stops drawing rather than animating for nobody.
  useEffect(() => {
    const el = box.current;
    if (!el || !live) return;
    const observer = new IntersectionObserver(([entry]) => setActive(Boolean(entry?.isIntersecting)), { rootMargin: '96px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [live]);

  return (
    <div ref={box} className={`${styles.figure}${className ? ` ${className}` : ''}`} data-mood={mood} aria-hidden="true">
      <div className={`${stage.stage} ${styles.stage}`} data-state={ready ? 'live' : 'still'}>
        {MOODS.map((m) => (
          <img
            key={m}
            className={`${stage.poster} ${styles.still}`}
            data-mood={m}
            src={STILLS[m].src}
            width={STILLS[m].width}
            height={STILLS[m].height}
            alt=""
            loading={m === mood ? 'eager' : 'lazy'}
            decoding="async"
          />
        ))}
        {live ? (
          <Suspense fallback={null}>
            <RobotCanvas
              className={stage.canvas}
              scope={scope}
              active={active}
              onReady={() => setReady(true)}
              onLost={() => {
                setReady(false);
                setLive(false);
              }}
            />
          </Suspense>
        ) : null}
      </div>
    </div>
  );
}
