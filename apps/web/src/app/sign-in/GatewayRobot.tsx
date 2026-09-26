'use client';

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import small from '../(public)/_landing/robot/poster/robot-720.webp';
import medium from '../(public)/_landing/robot/poster/robot-1080.webp';
import large from '../(public)/_landing/robot/poster/robot-1600.webp';
import { liveRobotAllowed, whenSettled } from '../(public)/_landing/robot/RobotStage.tsx';
import stage from '../(public)/_landing/robot/robot.module.css';

const RobotCanvas = lazy(() => import('../(public)/_landing/robot/RobotCanvas.tsx'));

/** The width the gateway stands the robot beside the access surface from — the home page's own desktop layout. */
const WIDE = '(min-width: 1200px)';
const POSTER_SRCSET = `${small.src} 720w, ${medium.src} 1080w, ${large.src} 1600w`;
/** The home page's desktop `sizes`, so a desktop fetches the same poster it just showed there. */
const POSTER_SIZES = 'min(max(602px, calc(94vh - 68px)), 808px, 58vw)';
/** One transparent pixel: what a narrow screen is given instead of the poster, so it fetches nothing. */
const NOTHING = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * The home page's robot, standing by the workspace's access surface.
 *
 * The same figure, the same still image and the same live scene as the hero, placed where the hero places it, so
 * arriving here from the home page changes the words and the surface but not the room. It is calmer by what it
 * is given, not by a different drawing: there is no voice and no quote to follow, so it holds position, settles
 * now and then, and glances at the surface's action while the visitor is on it.
 *
 * Only on a desktop. A phone signing in needs the form, not a figure above it: there the still image is swapped for
 * a single transparent pixel before anything is fetched, and three.js is never loaded.
 */
export function GatewayRobot() {
  const box = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState<HTMLElement | null>(null);
  const [live, setLive] = useState(false);
  const [ready, setReady] = useState(false);

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

  return (
    <div ref={box} className={stage.stage} data-state={ready ? 'live' : 'still'}>
      <picture>
        <source media="(max-width: 1199px)" srcSet={NOTHING} />
        <img
          className={stage.poster}
          src={medium.src}
          srcSet={POSTER_SRCSET}
          sizes={POSTER_SIZES}
          width={medium.width}
          height={medium.height}
          alt=""
          fetchPriority="high"
          decoding="async"
        />
      </picture>
      {live ? (
        <Suspense fallback={null}>
          {/* Always drawing while it is here: the gateway is one screen, so the robot is never scrolled away. */}
          <RobotCanvas
            className={stage.canvas}
            scope={scope}
            active
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
