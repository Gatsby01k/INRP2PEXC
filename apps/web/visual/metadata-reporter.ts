import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { FullResult, Reporter, Suite } from '@playwright/test/reporter';
import { BASELINE_DIR, METADATA_FILE, UPDATE_REQUESTED, type VisualEnvironment, record } from './environment.ts';

/**
 * After an intentional update that passed completely: drop baselines for captures that no longer exist and
 * record the environment. A failed update writes no metadata, so the compare guard rejects the partial set.
 */
export default class MetadataReporter implements Reporter {
  private expected = new Set<string>();

  onBegin(_config: unknown, suite: Suite): void {
    for (const test of suite.allTests()) for (const name of test.annotations.filter((a) => a.type === 'capture')) this.expected.add(`${name.description}.png`);
  }

  onEnd(result: FullResult): void {
    if (!UPDATE_REQUESTED || !process.env.VISUAL_ENV_JSON) return;
    if (result.status !== 'passed') {
      rmSync(METADATA_FILE, { force: true });
      console.error('Baseline update failed; ENVIRONMENT.json not written.');
      return;
    }
    for (const f of readdirSync(BASELINE_DIR).filter((n) => n.endsWith('.png') && !this.expected.has(n))) rmSync(path.join(BASELINE_DIR, f));
    record(JSON.parse(process.env.VISUAL_ENV_JSON) as VisualEnvironment);
  }
}
