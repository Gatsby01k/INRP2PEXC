import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COLOR, CONTRAST_REQUIREMENTS, tokensToCss } from '../src/tokens/tokens.ts';
import { contrastRatio } from '../src/tokens/contrast.ts';

const SRC = path.resolve(import.meta.dirname, '../src');

function walk(dir: string, pred: (f: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full, pred) : pred(full) ? [full] : [];
  });
}

const tokensCss = readFileSync(path.join(SRC, 'styles/tokens.css'), 'utf8');
const definedVars = new Set([...tokensCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const moduleCss = walk(SRC, (f) => f.endsWith('.module.css'));
const rel = (f: string) => path.relative(SRC, f);

/** Declarations as [file, line, property, value], comments stripped. */
function declarations(file: string): Array<[string, number, string, string]> {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const out: Array<[string, number, string, string]> = [];
  text.split('\n').forEach((line, i) => {
    const m = /^\s*([a-z-]+)\s*:\s*(.+?);\s*$/.exec(line);
    if (m) out.push([rel(file), i + 1, m[1]!, m[2]!]);
  });
  return out;
}
const decls = moduleCss.flatMap(declarations);
const fmt = (d: [string, number, string, string]) => `${d[0]}:${d[1]} ${d[2]}: ${d[3]}`;

describe('tokens', () => {
  it('generated tokens.css is in sync with tokens.ts (run pnpm --filter @inrp2p/ui tokens:generate)', () => {
    expect(tokensCss).toBe(tokensToCss());
  });

  it('brand colours are the approved values (D-10)', () => {
    expect(COLOR['brand-primary']).toBe('#F04E23');
    expect(COLOR['brand-action']).toBe('#C8401A');
  });

  it.each(CONTRAST_REQUIREMENTS.map((r) => [`${r.fg} on ${r.bg} ≥ ${r.min}:1 (${r.use})`, r] as const))('WCAG AA contrast: %s', (_n, r) => {
    expect(contrastRatio(COLOR[r.fg], COLOR[r.bg])).toBeGreaterThanOrEqual(r.min);
  });

  it('reduced motion zeroes every transition duration token', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(tokensCss)?.[1] ?? '';
    for (const t of ['--dur-fast', '--dur-base', '--dur-complete']) expect(reduced).toContain(`${t}: 0ms;`);
  });
});

describe('CSS modules use tokens only', () => {
  it('found the component styles', () => {
    expect(moduleCss.length).toBeGreaterThan(30);
  });

  it('no raw colour literals', () => {
    const bad = decls.filter((d) => /#[0-9a-f]{3,8}\b|\b(rgb|rgba|hsl|hsla|oklch|lab)\(/i.test(d[3]));
    expect(bad.map(fmt)).toEqual([]);
  });

  it('colour properties use tokens or currentColor/transparent', () => {
    const colorProps = /^(color|background|background-color|border-color|border(-top|-right|-bottom|-left)?-color|outline-color|fill|stroke|caret-color|accent-color|text-decoration-color)$/;
    const bad = decls.filter((d) => colorProps.test(d[2]) && !/var\(--|^(currentColor|transparent|none|inherit)$/.test(d[3]));
    expect(bad.map(fmt)).toEqual([]);
  });

  it('typography uses the type scale', () => {
    const bad = decls.filter(
      (d) => /^(font-size|font-weight|font-family|line-height|font)$/.test(d[2]) && !/^(var\(--[a-z0-9-]+\)|inherit|1|0)$/.test(d[3]),
    );
    expect(bad.map(fmt)).toEqual([]);
  });

  it('spacing uses the spacing scale', () => {
    const bad = decls.filter((d) => {
      if (!/^(margin|padding|gap|row-gap|column-gap)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$/.test(d[2])) return false;
      return d[3].split(/\s+/).some((part) => !/^(0|auto|var\(--[a-z0-9-]+\)|calc\(.*var\(--.*\)|-?1px)$/.test(part));
    });
    expect(bad.map(fmt)).toEqual([]);
  });

  it('radii, shadows and motion use tokens', () => {
    const bad = decls.filter((d) => {
      if (d[2] === 'border-radius') return !/^(var\(--[a-z0-9-]+\)|0|50%|1px|2px)$/.test(d[3]);
      // Shadow tokens, or the active/exception rail: inset hairline (≤3px) in a token colour.
      if (d[2] === 'box-shadow') return !d[3].split(/,\s*/).every((p) => /^(none|var\(--shadow-[a-z]+\)|inset -?[0-3](px)? -?[0-3](px)? 0 var\(--[a-z0-9-]+\))$/.test(p));
      if (/^(transition|transition-duration|animation|animation-duration)$/.test(d[2])) return /\d+m?s\b/.test(d[3]) && d[3] !== 'none';
      return false;
    });
    expect(bad.map(fmt)).toEqual([]);
  });

  it('every referenced custom property is defined in tokens.css', () => {
    const bad = decls.flatMap((d) => [...d[3].matchAll(/var\((--[a-z0-9-]+)/g)].filter((m) => !definedVars.has(m[1]!)).map(() => fmt(d)));
    expect(bad).toEqual([]);
  });

  it('components that animate provide a reduced-motion variant', () => {
    const missing = moduleCss.filter((f) => {
      const css = readFileSync(f, 'utf8');
      return /@keyframes|animation\s*:/.test(css) && !/prefers-reduced-motion/.test(css);
    });
    expect(missing.map(rel)).toEqual([]);
  });
});

describe('component source', () => {
  const tsx = walk(path.join(SRC, 'components'), (f) => f.endsWith('.tsx') && !f.endsWith('.stories.tsx'));

  it('no inline colour literals in components', () => {
    const bad = tsx.filter((f) => /['"`]#[0-9a-f]{3,8}['"`]|\brgba?\(/i.test(readFileSync(f, 'utf8'))).map(rel);
    expect(bad).toEqual([]);
  });

  it('no runtime locale formatting in components (D-11)', () => {
    const bad = tsx.filter((f) => /toLocaleString|Intl\.|toFixed\(|parseFloat\(/.test(readFileSync(f, 'utf8'))).map(rel);
    expect(bad).toEqual([]);
  });

  it('every component is rendered in at least one story', () => {
    const stories = walk(SRC, (f) => f.endsWith('.stories.tsx')).map((f) => readFileSync(f, 'utf8')).join('\n');
    const dirs = readdirSync(path.join(SRC, 'components'));
    const missing = dirs.filter((d) => !new RegExp(`<${d}[\\s/>]|component: ${d}\\b`).test(stories));
    expect(missing).toEqual([]);
  });
});
