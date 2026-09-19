import type { FullResult, Reporter } from '@playwright/test/reporter';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { reconcileBaselines } from '@inrp2p/visual';
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
    // Expected from the built Storybook index — a static list by the time this runs, not something collected
    // from the tests as they went.
    const expected = loadStories().flatMap((s) => [`${s.id}.png`, ...(s.tags.includes('motion') ? [`${s.id}--reduced-motion.png`] : [])]);
    const { removed } = reconcileBaselines(SCREENSHOT_DIR, expected);
    for (const file of removed) console.log(`Dropped baseline of a story that no longer exists: ${file}`);
    writeMetadata(JSON.parse(process.env.VISUAL_ENV_JSON) as VisualEnvironment);
  }
}
