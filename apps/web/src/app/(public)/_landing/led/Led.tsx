'use client';

import { type CSSProperties, useEffect, useRef } from 'react';
import { onRows, strip } from './font.ts';
import styles from './led.module.css';

/**
 * Words in the robot's LEDs: orange dots on whatever black glass holds them, the dark dots drawn by the stylesheet and
 * the lit ones on one canvas. `static` sets the words in the middle; `marquee` runs them right to left, round and round,
 * a column of dots at a time, as an exchange's board does.
 *
 * A marquee is cheap: the whole strip is drawn once into a tape, and a frame only slides the tape — one image per frame
 * however long the words. It runs only while it is on screen; under reduced motion it stands still at its start. The
 * words are always also in the page as text (`label`), so the dots are decoration.
 */
export function Led({
  text,
  mode = 'static',
  pitch = 6,
  rows = 9,
  speed = 20,
  fit = false,
  label,
  className,
}: {
  text: string;
  mode?: 'static' | 'marquee';
  /** One dot's cell, in CSS pixels. */
  pitch?: number;
  rows?: number;
  /** Columns a second, for a marquee. */
  speed?: number;
  /** As wide as the words (static only), so the server's markup already has the width and nothing moves. */
  fit?: boolean;
  /** The words for a reader that does not see the dots; omit when the page says them nearby. */
  label?: string;
  className?: string | undefined;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const width = fit ? (strip(text)[0]!.length + 1) * pitch : undefined;

  useEffect(() => {
    const el = host.current;
    const cv = canvas.current;
    const ctx = cv?.getContext('2d');
    if (!el || !cv || !ctx) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    let visible = false;
    let tape: HTMLCanvasElement | null = null;
    let tapeCols = 0;
    let cols = 0;
    let unit = pitch;
    let started = 0;

    const sprite = (size: number): HTMLCanvasElement => {
      const s = document.createElement('canvas');
      s.width = s.height = Math.ceil(size * 3);
      const g = s.getContext('2d')!;
      const c = s.width / 2;
      const glow = g.createRadialGradient(c, c, 0, c, c, size * 1.3);
      glow.addColorStop(0, 'rgba(255, 120, 70, 0.55)');
      glow.addColorStop(1, 'rgba(255, 106, 61, 0)');
      g.fillStyle = glow;
      g.fillRect(0, 0, s.width, s.height);
      g.beginPath();
      g.arc(c, c, size * 0.36, 0, Math.PI * 2);
      g.fillStyle = '#ff8a5c';
      g.fill();
      g.beginPath();
      g.arc(c - size * 0.08, c - size * 0.08, size * 0.14, 0, Math.PI * 2);
      g.fillStyle = 'rgba(255, 220, 200, 0.85)';
      g.fill();
      return s;
    };

    const paint = (target: CanvasRenderingContext2D, bitmap: readonly string[], dot: HTMLCanvasElement, offsetCols = 0) => {
      target.globalCompositeOperation = 'lighter';
      for (let y = 0; y < bitmap.length; y++) {
        const row = bitmap[y]!;
        for (let x = 0; x < row.length; x++) {
          if (row[x] !== '#') continue;
          target.drawImage(dot, (x + offsetCols + 0.5) * unit - dot.width / 2, (y + 0.5) * unit - dot.height / 2);
        }
      }
      target.globalCompositeOperation = 'source-over';
    };

    const setup = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      unit = pitch * dpr;
      cols = Math.max(1, Math.floor(el.clientWidth / pitch));
      cv.width = Math.round(cols * unit);
      cv.height = Math.round(rows * unit);
      cv.style.width = `${cols * pitch}px`;
      cv.style.height = `${rows * pitch}px`;
      const dot = sprite(unit);
      const bitmap = onRows(strip(text), rows);
      const w = bitmap[0]!.length;
      if (mode === 'marquee') {
        // The words and a gap, twice over, so a window of `cols` can slide anywhere along one round.
        tapeCols = w + Math.max(8, Math.round(cols * 0.15));
        tape = document.createElement('canvas');
        tape.width = Math.round((tapeCols + cols) * unit);
        tape.height = cv.height;
        const t = tape.getContext('2d')!;
        for (let start = 0; start < tapeCols + cols; start += tapeCols) paint(t, bitmap, dot, start);
      } else {
        tape = null;
        ctx.clearRect(0, 0, cv.width, cv.height);
        paint(ctx, bitmap, dot, Math.floor((cols - w) / 2));
      }
      draw(performance.now());
    };

    const draw = (now: number) => {
      if (!tape) return;
      const offset = still ? 0 : Math.floor(((now - started) / 1000) * speed) % tapeCols;
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(tape, offset * unit, 0, cv.width, cv.height, 0, 0, cv.width, cv.height);
    };

    const loop = (now: number) => {
      frame = 0;
      draw(now);
      if (visible && !still && tape) frame = requestAnimationFrame(loop);
    };

    const seen = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      if (visible && !frame && tape && !still) frame = requestAnimationFrame(loop);
    });
    const resized = new ResizeObserver(() => setup());
    started = performance.now();
    setup();
    seen.observe(el);
    resized.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      seen.disconnect();
      resized.disconnect();
    };
  }, [text, mode, pitch, rows, speed]);

  return (
    <span
      ref={host}
      className={`${styles.led} ${className ?? ''}`}
      style={{ '--pitch': `${pitch}px`, height: rows * pitch, ...(width ? { width } : {}) } as CSSProperties}
    >
      <canvas ref={canvas} className={styles.canvas} aria-hidden="true" />
      {label ? <span className="ix-visually-hidden">{label}</span> : null}
    </span>
  );
}
