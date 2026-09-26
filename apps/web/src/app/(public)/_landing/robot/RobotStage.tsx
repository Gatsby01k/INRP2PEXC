'use client';

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import small from './poster/robot-720.webp';
import medium from './poster/robot-1080.webp';
import large from './poster/robot-1600.webp';
import styles from './robot.module.css';

const RobotCanvas = lazy(() => import('./RobotCanvas.tsx'));

/**
 * The still robot, rendered from the live robot's own scene in its rest pose (`pnpm --filter @inrp2p/web
 * poster:robot`). `sizes` follows the stage's width in each layout of hero.module.css, so a phone fetches the
 * small image and a large desktop the large one.
 */
const POSTER_SRCSET = `${small.src} 720w, ${medium.src} 1080w, ${large.src} 1600w`;
const POSTER_SIZES = '(max-width: 1199px) min(calc(100vw - 32px), 256px), min(max(487px, calc(76vh - 55px)), 654px, 46vw)';

/**
 * Whether this device should run the live robot or keep the still one it is already showing.
 *
 * The still robot is the same figure in the same pose, so nobody is shown less of the brand — only less motion.
 * It is kept for anyone who asked for reduced motion or for less data, for small devices, and for any browser
 * that can only draw WebGL in software: there, a moving robot would cost the page its responsiveness, which is
 * a bad trade on a page whose whole job is to take a quote request.
 */
export function liveRobotAllowed(): boolean {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  const nav = navigator as Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number };
  if (nav.connection?.saveData) return false;
  if (nav.deviceMemory !== undefined && nav.deviceMemory < 4) return false;
  if (nav.hardwareConcurrency < 4) return false;
  const probe = document.createElement('canvas');
  const gl = probe.getContext('webgl2', { failIfMajorPerformanceCaveat: true });
  if (!gl) return false;
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return !/swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
}

/** Runs once the page has finished loading and the main thread is idle, so the robot never delays the page. */
export function whenSettled(run: () => void): () => void {
  let idle: number | undefined;
  let timer: number | undefined;
  const schedule = () => {
    if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(run, { timeout: 2000 });
    else timer = window.setTimeout(run, 500);
  };
  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule, { once: true });
  return () => {
    window.removeEventListener('load', schedule);
    if (idle !== undefined) window.cancelIdleCallback(idle);
    if (timer !== undefined) window.clearTimeout(timer);
  };
}

export function RobotStage() {
  const box = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState<HTMLElement | null>(null);
  const [live, setLive] = useState(false);
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState(true);

  useEffect(() => {
    setScope(box.current?.closest<HTMLElement>('[data-robot-scope]') ?? null);
    if (!liveRobotAllowed()) return;
    return whenSettled(() => setLive(true));
  }, []);

  // Off screen, the robot stops drawing altogether rather than animating for nobody.
  useEffect(() => {
    const el = box.current;
    if (!el || !live) return;
    const observer = new IntersectionObserver(([entry]) => setActive(Boolean(entry?.isIntersecting)), { rootMargin: '96px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [live]);

  return (
    <div ref={box} className={styles.stage} data-state={ready ? 'live' : 'still'}>
      <img
        className={styles.poster}
        src={medium.src}
        srcSet={POSTER_SRCSET}
        sizes={POSTER_SIZES}
        width={medium.width}
        height={medium.height}
        alt=""
        fetchPriority="high"
        decoding="async"
      />
      {live ? (
        <Suspense fallback={null}>
          <RobotCanvas
            className={styles.canvas}
            scope={scope}
            active={active}
            onReady={() => setReady(true)}
            onLost={() => {
              // The GPU took the context back (a driver reset, a backgrounded tab on a phone): the still robot
              // is already underneath, so it simply takes over again.
              setReady(false);
              setLive(false);
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
