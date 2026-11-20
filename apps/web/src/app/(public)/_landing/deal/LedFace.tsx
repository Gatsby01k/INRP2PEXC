'use client';

import { useEffect, useRef } from 'react';
import { rateFor, useMarket } from '../market.ts';
import styles from './deal.module.css';

/**
 * The robot's face as the deal's display: its black visor is a matrix of orange LEDs, the same light as its eyes, and it
 * shows the moment being read (`data-step` on the section, DealSteps.tsx) — the market's rate running across it while
 * the price is asked, a lock as the USDT goes into its chest, rupee signs streaming left while the rupees travel, and
 * hearts once the USDT is released. Before any of that, and without script, its two eyes.
 *
 * Drawn on one canvas, at a dozen frames a second and only while it is on screen and moving; under reduced motion each
 * face is drawn once and stands still. Decorative: the moments' words say everything it shows.
 */

const COLS = 21;
const ROWS = 14;

type Bitmap = readonly string[];

/** A 5 × 7 face for the figures the visor runs, and the rupee sign. */
const FONT: Record<string, Bitmap> = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '.': ['.', '.', '.', '.', '.', '.', '#'],
  ' ': ['..', '..', '..', '..', '..', '..', '..'],
  '₹': ['#####', '...#.', '#####', '...#.', '###..', '..#..', '...##'],
};

const EYES: Bitmap = blank().map((_, r) => (r >= 4 && r <= 8 ? '......' + pill(r - 4) + '...' + pill(r - 4) + '......' : '.'.repeat(COLS)));
function pill(r: number): string {
  return r === 0 || r === 4 ? '.#.' : '###';
}

const LOCK: Bitmap = center([
  '...#####...',
  '..##...##..',
  '..#.....#..',
  '..#.....#..',
  '###########',
  '###########',
  '#####.#####',
  '####...####',
  '#####.#####',
  '#####.#####',
  '###########',
  '###########',
]);

/** The lock a moment before it shuts: the shackle one row higher. */
const LOCK_OPEN: Bitmap = center([
  '...#####...',
  '..##...##..',
  '..#.....#..',
  '..#.....#..',
  '..#........',
  '###########',
  '#####.#####',
  '####...####',
  '#####.#####',
  '#####.#####',
  '###########',
  '###########',
]);

const HEARTS: Bitmap = center(
  ['.##.##....##.##.', '#######..#######', '#######..#######', '.#####....#####.', '..###......###..', '...#........#...'].map((r) => r),
);

function blank(): string[] {
  return Array.from({ length: ROWS }, () => '.'.repeat(COLS));
}

/** A bitmap set in the middle of the visor. */
function center(bitmap: Bitmap): Bitmap {
  const w = Math.max(...bitmap.map((r) => r.length));
  const top = Math.floor((ROWS - bitmap.length) / 2);
  const left = Math.floor((COLS - w) / 2);
  return blank().map((row, r) => {
    const line = bitmap[r - top];
    if (!line) return row;
    return '.'.repeat(left) + line.padEnd(w, '.') + '.'.repeat(COLS - left - w);
  });
}

/** Words set in the 5 × 7 face as one long strip, on the visor's middle rows, to run across it. */
function strip(text: string): string[] {
  const glyphs = [...text].map((c) => FONT[c] ?? FONT[' ']!);
  const rows = Array.from({ length: 7 }, (_, r) => glyphs.map((g) => g[r] + '.').join(''));
  const top = Math.floor((ROWS - 7) / 2);
  return Array.from({ length: ROWS }, (_, r) => (r >= top && r < top + 7 ? rows[r - top]! : '.'.repeat(rows[0]!.length)));
}

/** A window of `COLS` columns onto a strip, starting at `offset` and wrapping round. */
function window_(s: string[], offset: number): Bitmap {
  const w = s[0]!.length;
  return s.map((row) => {
    let out = '';
    for (let c = 0; c < COLS; c++) out += row[(offset + c) % w];
    return out;
  });
}

export function LedFace() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const market = useMarket();
  const rate = rateFor(market, 'SELL_USDT');
  const rateRef = useRef<string | null>(null);
  rateRef.current = rate ? Number(rate).toFixed(2) : null;

  useEffect(() => {
    const el = canvas.current;
    const deal = el?.closest<HTMLElement>('[data-deal]');
    const ctx = el?.getContext('2d');
    if (!el || !deal || !ctx) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let tick = 0;
    let timer = 0;
    let visible = false;
    let step = -1;
    let since = 0;

    const draw = (bitmap: Bitmap, level = 1) => {
      const { width, height } = el;
      ctx.clearRect(0, 0, width, height);
      const pitchX = width / COLS;
      const pitchY = height / ROWS;
      const r = Math.min(pitchX, pitchY) * 0.34;
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          const on = bitmap[y]?.[x] === '#';
          ctx.beginPath();
          ctx.arc((x + 0.5) * pitchX, (y + 0.5) * pitchY, on ? r * 1.06 : r * 0.82, 0, Math.PI * 2);
          if (on) {
            ctx.fillStyle = `rgba(255, 130, 80, ${0.72 + 0.28 * level})`;
            ctx.shadowColor = 'rgba(255, 106, 61, 0.95)';
            ctx.shadowBlur = r * 2.6;
          } else {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.045)';
            ctx.shadowBlur = 0;
          }
          ctx.fill();
        }
      }
    };

    const face = (): { bitmap: Bitmap; moving: boolean; level?: number } => {
      const t = tick - since;
      if (!deal.hasAttribute('data-live')) return { bitmap: EYES, moving: false };
      if (step === 0) {
        const r = rateRef.current;
        if (!r) return { bitmap: t % 40 < 37 ? EYES : blank(), moving: true };
        return { bitmap: window_(strip(`₹${r}   `), t), moving: true };
      }
      if (step === 1) return { bitmap: t < 5 ? LOCK_OPEN : LOCK, moving: t < 6, level: 0.85 + 0.15 * Math.sin(t / 3) };
      if (step === 2) return { bitmap: window_(strip('₹ ₹ ₹ ₹ '), t), moving: true };
      if (step === 3) return { bitmap: HEARTS, moving: true, level: 0.75 + 0.25 * Math.abs(Math.sin(t / 4)) };
      return { bitmap: EYES, moving: false };
    };

    const render = () => {
      const f = face();
      draw(f.bitmap, f.level ?? 1);
      return f.moving;
    };

    const loop = () => {
      timer = 0;
      tick++;
      const moving = render();
      if (moving && visible && !still) timer = window.setTimeout(loop, 80);
    };

    const size = () => {
      const box = el.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      el.width = Math.max(1, Math.round(box.width * dpr));
      el.height = Math.max(1, Math.round(box.height * dpr));
      render();
    };

    const onStep = () => {
      const next = Number(deal.dataset.step ?? 0);
      if (next === step) return;
      step = next;
      since = tick;
      if (!timer) loop();
    };

    const seen = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      if (visible && !timer) loop();
    });
    const watch = new MutationObserver(onStep);
    const resized = new ResizeObserver(size);
    seen.observe(el);
    watch.observe(deal, { attributes: true, attributeFilter: ['data-step', 'data-live'] });
    resized.observe(el);
    size();
    onStep();
    return () => {
      window.clearTimeout(timer);
      seen.disconnect();
      watch.disconnect();
      resized.disconnect();
    };
  }, []);

  return <canvas ref={canvas} className={styles.led} aria-hidden="true" />;
}
