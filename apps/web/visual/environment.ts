/**
 * This suite's binding to the canonical visual-baseline environment (`docs/VISUAL_BASELINES.md`).
 *
 * The definition of "canonical" and the guard that enforces it live in `@inrp2p/visual`, shared with the
 * component gallery, so the two pixel suites cannot drift on what they will accept.
 */
import path from 'node:path';
import { SELF_CHECK, type VisualEnvironment, guardVisualRun, metadataFile, readMetadata, writeMetadata } from '@inrp2p/visual';

export { CANONICAL, SELF_CHECK, UPDATE_REQUESTED } from '@inrp2p/visual';
export type { BaselineMetadata, VisualEnvironment } from '@inrp2p/visual';

export const SUITE = 'operator pages';
export const APP_DIR = path.resolve(import.meta.dirname, '..');
export const BASELINE_DIR = path.resolve(import.meta.dirname, '__screenshots__');
/** A self-check never touches the committed baselines; its images land here and are not tracked. */
export const SELF_CHECK_DIR = path.resolve(import.meta.dirname, '.selfcheck');
export const SCREENSHOT_DIR = SELF_CHECK ? SELF_CHECK_DIR : BASELINE_DIR;
export const METADATA_FILE = metadataFile(BASELINE_DIR);

export const guard = (): Promise<VisualEnvironment | null> => guardVisualRun({ suite: SUITE, screenshotDir: BASELINE_DIR, fromDir: APP_DIR });
export const metadata = () => readMetadata(BASELINE_DIR);
export const record = (env: VisualEnvironment): void => writeMetadata(BASELINE_DIR, env);
