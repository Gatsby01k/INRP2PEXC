import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CANONICAL, type BaselineMetadata, baselineFiles, reconcileBaselines, recordedBaselineProblems, writeMetadata } from '@inrp2p/visual';
import { CAPTURES, CAPTURE_FILES, isCaptureName } from '../visual/captures.ts';

/**
 * The operator page baselines are reconciled against a **static** manifest. They were not: the reporter built
 * its expected set from annotations added while the tests ran, so at `onBegin` it saw none, and after a
 * successful canonical update it deleted all eleven freshly recorded baselines as stale and then wrote metadata
 * claiming zero. The compare step that followed was right to fail.
 *
 * These tests hold the two halves of the fix: the manifest and the suite agree, and a successful update leaves
 * a set a compare run can actually use.
 */
const SPECS = ['pages', 'client-pages', 'link-pages'].map((name) => readFileSync(fileURLToPath(new URL(`../visual/${name}.spec.ts`, import.meta.url)), 'utf8'));
const SPEC = SPECS.join('\n');
const REPORTER = readFileSync(fileURLToPath(new URL('../visual/metadata-reporter.ts', import.meta.url)), 'utf8');
const SUPPORT = readFileSync(fileURLToPath(new URL('../visual/support.ts', import.meta.url)), 'utf8');
const capturedInSpec = [...SPEC.matchAll(/\bcapture\(page,\s*'([^']+)'/g)].map((m) => m[1]!);

describe('capture manifest', () => {
  it('names every validation state of both products', () => {
    expect(CAPTURES).toHaveLength(20);
    expect(new Set(CAPTURES).size).toBe(20);
    expect(CAPTURE_FILES).toEqual(CAPTURES.map((n) => `${n}.png`));
    expect(CAPTURES.filter((n) => n.startsWith('operator-'))).toHaveLength(11);
    expect(CAPTURES.filter((n) => n.startsWith('client-'))).toHaveLength(7);
    expect(CAPTURES.filter((n) => n.startsWith('link-'))).toHaveLength(2);
  });

  it('matches what the suite captures, in both directions', () => {
    expect([...capturedInSpec].sort()).toEqual([...CAPTURES].sort());
    for (const name of capturedInSpec) expect(isCaptureName(name), `${name} is captured but not in the manifest`).toBe(true);
  });

  it('rejects a name it has never heard of', () => {
    expect(isCaptureName('operator-desk')).toBe(true);
    expect(isCaptureName('operator-something-else')).toBe(false);
  });
});

describe('the reporter takes its expected set from the manifest', () => {
  it('reconciles against the manifest', () => {
    expect(REPORTER).toContain("from './captures.ts'");
    expect(REPORTER).toMatch(/reconcileBaselines\(BASELINE_DIR,\s*CAPTURE_FILES\)/);
  });

  it('does not learn what to keep from the run itself', () => {
    // `onBegin` runs before any test, so annotations pushed inside a test are invisible to it. Collecting the
    // expected set that way is what deleted every recorded baseline.
    expect(REPORTER).not.toContain('onBegin');
    expect(REPORTER).not.toContain('annotations');
    expect(SUPPORT).not.toContain('annotations');
  });
});

describe('baseline reconciliation after a canonical update', () => {
  let dir: string;
  const record = () => writeMetadata(dir, CANONICAL);
  const meta = (): BaselineMetadata => JSON.parse(readFileSync(path.join(dir, 'ENVIRONMENT.json'), 'utf8')) as BaselineMetadata;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'inrp2p-baselines-'));
    // What a successful update leaves behind: every expected capture, plus one baseline from a capture that
    // has since been removed from the manifest.
    for (const file of CAPTURE_FILES) writeFileSync(path.join(dir, file), 'png');
    writeFileSync(path.join(dir, 'operator-retired-screen.png'), 'png');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps every expected baseline and drops only the stale one', () => {
    const { kept, removed, missing } = reconcileBaselines(dir, CAPTURE_FILES);
    expect(kept).toEqual([...CAPTURE_FILES].sort());
    expect(removed).toEqual(['operator-retired-screen.png']);
    expect(missing).toEqual([]);
    expect(baselineFiles(dir)).toEqual([...CAPTURE_FILES].sort());
  });

  it('records metadata counting exactly those', () => {
    reconcileBaselines(dir, CAPTURE_FILES);
    record();
    expect(meta().baselines).toBe(CAPTURE_FILES.length);
    expect(readdirSync(dir).filter((f) => f.endsWith('.png'))).toHaveLength(CAPTURE_FILES.length);
  });

  it('leaves a set the next compare run can use', () => {
    reconcileBaselines(dir, CAPTURE_FILES);
    record();
    expect(recordedBaselineProblems(dir, CAPTURE_FILES)).toEqual([]);
  });

  it('reports an incomplete set instead of blessing it', () => {
    rmSync(path.join(dir, 'operator-step-up.png'));
    const { kept, missing } = reconcileBaselines(dir, CAPTURE_FILES);
    expect(missing).toEqual(['operator-step-up.png']);
    expect(kept).toHaveLength(CAPTURE_FILES.length - 1);

    // What the old reporter did — record anyway — is exactly what a compare run must refuse.
    record();
    expect(recordedBaselineProblems(dir, CAPTURE_FILES)).toContain('expected baseline operator-step-up.png is missing');
  });

  it('refuses a set whose count was changed outside the update path', () => {
    reconcileBaselines(dir, CAPTURE_FILES);
    record();
    writeFileSync(path.join(dir, 'operator-smuggled-in.png'), 'png');
    expect(recordedBaselineProblems(dir, CAPTURE_FILES)).toContain(`baseline count ${CAPTURE_FILES.length + 1} does not match ENVIRONMENT.json (${CAPTURE_FILES.length})`);
  });

  it('refuses baselines recorded somewhere other than the canonical environment', () => {
    reconcileBaselines(dir, CAPTURE_FILES);
    writeMetadata(dir, { ...CANONICAL, chromium: '140.0.0.1' });
    expect(recordedBaselineProblems(dir, CAPTURE_FILES)).toContain(`chromium: expected ${CANONICAL.chromium}, got 140.0.0.1`);
  });

  it('refuses when nothing was recorded at all', () => {
    for (const file of baselineFiles(dir)) rmSync(path.join(dir, file));
    expect(recordedBaselineProblems(dir, CAPTURE_FILES)[0]).toContain('ENVIRONMENT.json is missing');
  });
});
