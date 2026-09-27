'use client';

import { useEffect, useRef } from 'react';
import { robotCues } from './cues.ts';
import { RobotScene } from './scene.ts';

export interface RobotCanvasProps {
  readonly scope: HTMLElement | null;
  /** False while the robot is off screen: nothing is drawn and nothing is spent. */
  readonly active: boolean;
  readonly onReady: () => void;
  readonly onLost: () => void;
  readonly className?: string | undefined;
  /** The robot stands to the right of what it attends to (`RobotSceneOptions.mirror`). */
  readonly mirror?: boolean;
}

/**
 * The live robot. Loaded on demand by the stage, so three.js is never part of the page's first bundle; the
 * scene is created once per mount and handed only what changes after that — whether it is on screen.
 */
export default function RobotCanvas({ scope, active, onReady, onLost, className, mirror = false }: RobotCanvasProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<RobotScene | null>(null);
  const callbacks = useRef({ onReady, onLost });
  useEffect(() => {
    callbacks.current = { onReady, onLost };
  });
  const initial = useRef({ scope, active, mirror });

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    // Created a task later: a mount that is undone straight away (React's development double-mount, a stage
    // that unmounts at once) never creates a GL context it would only have to throw away.
    const start = window.setTimeout(() => {
      const s = new RobotScene({
        canvas: el,
        scope: initial.current.scope,
        // The visitor may have changed direction before the robot arrived; it starts facing the same way.
        direction: robotCues.direction(),
        // Likewise the workspace's page may already be in a mood; the home page never sets one.
        mood: robotCues.mood(),
        mirror: initial.current.mirror,
        still: false,
        onFirstFrame: () => callbacks.current.onReady(),
        onLost: () => callbacks.current.onLost(),
      });
      s.setActive(initial.current.active);
      scene.current = s;
    }, 0);
    return () => {
      window.clearTimeout(start);
      scene.current?.dispose();
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    scene.current?.setActive(active);
  }, [active]);

  return <canvas ref={canvas} className={className} />;
}
