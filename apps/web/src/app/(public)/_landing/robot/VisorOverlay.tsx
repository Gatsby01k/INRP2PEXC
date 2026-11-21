'use client';

import { useEffect, useRef } from 'react';
import { LED_COLS, LED_ROWS, visorDisplay } from './display.ts';
import styles from './robot.module.css';

/**
 * The visor's display on the still robot — the picture a phone, a busy GPU or a visitor who asked for less motion gets
 * (RobotStage.tsx). It sits exactly on the still's black visor and draws what the live robot's shader would (display.ts):
 * when there are words, the glass darkens over the eyes and the LEDs light; when there are none, it is clear and the
 * still's own eyes show through. It draws only while it is shown and on screen, and stops once the live robot is.
 */
export function VisorOverlay() {
  const host = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = host.current;
    const cv = canvas.current;
    const ctx = cv?.getContext('2d');
    if (!el || !cv || !ctx) return;
    let frame = 0;
    let visible = false;
    let sprite: HTMLCanvasElement | null = null;
    let cell = 0;

    const size = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.max(1, Math.round(cv.clientWidth * dpr));
      cv.height = Math.max(1, Math.round(cv.clientHeight * dpr));
      cell = cv.width / LED_COLS;
      sprite = document.createElement('canvas');
      sprite.width = sprite.height = Math.ceil(cell * 3);
      const g = sprite.getContext('2d')!;
      const c = sprite.width / 2;
      const glow = g.createRadialGradient(c, c, 0, c, c, cell * 1.2);
      glow.addColorStop(0, 'rgba(255, 120, 70, 0.6)');
      glow.addColorStop(1, 'rgba(255, 106, 61, 0)');
      g.fillStyle = glow;
      g.fillRect(0, 0, sprite.width, sprite.height);
      g.beginPath();
      g.arc(c, c, cell * 0.34, 0, Math.PI * 2);
      g.fillStyle = '#ff8a5c';
      g.fill();
      g.beginPath();
      g.arc(c, c, cell * 0.16, 0, Math.PI * 2);
      g.fillStyle = 'rgba(255, 214, 190, 0.9)';
      g.fill();
    };

    const draw = () => {
      const { level, dirty } = visorDisplay.frame();
      el.style.setProperty('--on', level.toFixed(3));
      if (dirty && sprite) {
        ctx.clearRect(0, 0, cv.width, cv.height);
        ctx.globalCompositeOperation = 'lighter';
        const d = visorDisplay.data;
        for (let r = 0; r < LED_ROWS; r++) {
          const base = (LED_ROWS - 1 - r) * LED_COLS;
          for (let c = 0; c < LED_COLS; c++) {
            if (d[base + c]) ctx.drawImage(sprite, (c + 0.5) * cell - sprite.width / 2, (r + 0.5) * cell - sprite.height / 2);
          }
        }
        ctx.globalCompositeOperation = 'source-over';
      }
    };

    const loop = () => {
      frame = 0;
      // The live robot draws the display itself; this one stands down while it does (its stage hides it).
      if (!visible || el.offsetParent === null) return;
      draw();
      frame = requestAnimationFrame(loop);
    };

    const seen = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      if (visible && !frame) frame = requestAnimationFrame(loop);
    });
    const resized = new ResizeObserver(() => size());
    size();
    seen.observe(el);
    resized.observe(cv);
    // The stage turning live or back to still changes whether this is shown; look again when it does.
    const stage = el.closest('[data-state]');
    const watch = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(loop);
    });
    if (stage) watch.observe(stage, { attributes: true, attributeFilter: ['data-state'] });
    return () => {
      cancelAnimationFrame(frame);
      seen.disconnect();
      resized.disconnect();
      watch.disconnect();
    };
  }, []);

  return (
    <span ref={host} className={styles.visor} aria-hidden="true">
      <canvas ref={canvas} className={styles.visorLeds} />
    </span>
  );
}
