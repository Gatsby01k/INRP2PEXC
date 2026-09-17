import type { FullResult, Reporter } from '@playwright/test/reporter';
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { SCREENSHOT_DIR, UPDATE_REQUESTED, type VisualEnvironment } from './environment.ts';
import { writeMetadata } from './global-setup.ts';
import { loadStories } from './stories.ts';

/**
 * After an intentional update that passed completely (axe, font, reduced-motion assertions included):
 * drop baselines of stories that no longer exist and record environment metadata. A failed update
 * writes no metadata, so the compare guard rejects the partial set.
 */
export default class MetadataReporter implements Reporter {
  onEnd(result: FullResult): void {
    if (!UPDATE_REQUESTED || !process.env.VISUAL_ENV_JSON) return;
    if (result.status !== 'passed') {
      rmSync(path.join(SCREENSHOT_DIR, 'ENVIRONMENT.json'), { force: true });
      console.error('Baseline update failed; ENVIRONMENT.json not written.');
      return;
    }
    const expected = new Set(loadStories().flatMap((s) => [`${s.id}.png`, ...(s.tags.includes('motion') ? [`${s.id}--reduced-motion.png`] : [])]));
    for (const f of readdirSync(SCREENSHOT_DIR).filter((n) => n.endsWith('.png') && !expected.has(n))) rmSync(path.join(SCREENSHOT_DIR, f));
    writeMetadata(JSON.parse(process.env.VISUAL_ENV_JSON) as VisualEnvironment);
  }
}
