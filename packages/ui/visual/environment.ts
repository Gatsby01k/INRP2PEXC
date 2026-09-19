/**
 * This suite's binding to the canonical visual-baseline environment (`docs/VISUAL_BASELINES.md`).
 *
 * The environment itself — what counts as canonical, and the guard that enforces it — lives in `@inrp2p/visual`,
 * so the component gallery and the built operator pages are held to one definition rather than two that drift.
 */
import path from 'node:path';
import { CANONICAL, type VisualEnvironment, guardVisualRun, metadataFile, readMetadata, writeMetadata } from '@inrp2p/visual';

export { CANONICAL, UPDATE_REQUESTED, SELF_CHECK, detectImage, mismatches, playwrightVersion } from '@inrp2p/visual';
export type { BaselineMetadata, VisualEnvironment } from '@inrp2p/visual';

export const SUITE = 'ui components';
export const SCREENSHOT_DIR = path.resolve(import.meta.dirname, '__screenshots__');
export const PACKAGE_DIR = path.resolve(import.meta.dirname, '..');
export const METADATA_FILE = metadataFile(SCREENSHOT_DIR);

export const guard = (): Promise<VisualEnvironment | null> => guardVisualRun({ suite: SUITE, screenshotDir: SCREENSHOT_DIR, fromDir: PACKAGE_DIR });
export const metadata = () => readMetadata(SCREENSHOT_DIR);
export const record = (env: VisualEnvironment): void => writeMetadata(SCREENSHOT_DIR, env);
export { CANONICAL as CANONICAL_ENVIRONMENT };
