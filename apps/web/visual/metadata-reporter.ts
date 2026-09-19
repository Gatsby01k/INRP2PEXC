import { rmSync } from 'node:fs';
import type { FullResult, Reporter } from '@playwright/test/reporter';
import { reconcileBaselines } from '@inrp2p/visual';
import { CAPTURE_FILES } from './captures.ts';
import { BASELINE_DIR, METADATA_FILE, UPDATE_REQUESTED, type VisualEnvironment, record } from './environment.ts';

/**
 * After an intentional update that passed completely: drop baselines nothing expects any more, check that every
 * baseline the manifest does expect was actually recorded, and only then record the environment.
 *
 * The expected set comes from the static manifest (`captures.ts`), never from what the run happened to produce.
 * A reporter that learns the set from the run cannot tell "this baseline is stale" from "this run did not
 * produce it", and the difference is the whole point of the cleanup.
 */
export default class MetadataReporter implements Reporter {
  async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] } | void> {
    if (!UPDATE_REQUESTED || !process.env.VISUAL_ENV_JSON) return;

    if (result.status !== 'passed') {
      rmSync(METADATA_FILE, { force: true });
      console.error('Baseline update failed; ENVIRONMENT.json not written.');
      return;
    }

    const { kept, removed, missing } = reconcileBaselines(BASELINE_DIR, CAPTURE_FILES);
    for (const file of removed) console.log(`Dropped baseline no longer in the capture manifest: ${file}`);

    if (missing.length) {
      // Never bless an incomplete set: metadata over missing baselines is exactly what makes the next compare
      // run fail with "a snapshot doesn't exist" and no way to tell why.
      rmSync(METADATA_FILE, { force: true });
      console.error(`Baseline update incomplete; ENVIRONMENT.json not written. Missing: ${missing.join(', ')}`);
      return { status: 'failed' };
    }

    record(JSON.parse(process.env.VISUAL_ENV_JSON) as VisualEnvironment);
    console.log(`Recorded ${kept.length} operator page baselines.`);
  }
}
