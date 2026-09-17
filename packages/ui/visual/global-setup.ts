import { chromium, type FullConfig } from '@playwright/test';
import { readdirSync, writeFileSync } from 'node:fs';
import { CANONICAL, METADATA_FILE, SCREENSHOT_DIR, UPDATE_REQUESTED, detectImage, mismatches, playwrightVersion, readMetadata, type VisualEnvironment } from './environment.ts';

const HOW = 'See docs/VISUAL_BASELINES.md: compare/update only inside the canonical image (CI job "visual", workflow "Visual baselines (canonical update)", or `pnpm --filter @inrp2p/ui visual:docker`).';

async function currentEnvironment(): Promise<VisualEnvironment> {
  const browser = await chromium.launch();
  try {
    return { image: detectImage(), platform: process.platform, arch: process.arch, playwright: playwrightVersion(), chromium: browser.version() };
  } finally {
    await browser.close();
  }
}

/** Environment mismatch guard: refuses to compare or record pixels outside the canonical environment. */
export default async function globalSetup(_config: FullConfig): Promise<void> {
  const env = await currentEnvironment();
  const envProblems = mismatches(env);
  if (envProblems.length) {
    throw new Error(`Visual suite refused: not the canonical baseline environment.\n  ${envProblems.join('\n  ')}\n${HOW}`);
  }

  if (UPDATE_REQUESTED) {
    // Ordinary pushes and pull requests are compare-only; only a manual dispatch (or a local docker run) may record.
    const event = process.env.GITHUB_EVENT_NAME;
    if (process.env.CI && event !== 'workflow_dispatch') {
      throw new Error(`UPDATE_VISUALS=1 is not allowed for GitHub event "${event ?? 'unknown'}". ${HOW}`);
    }
    process.env.VISUAL_ENV_JSON = JSON.stringify(env);
    return;
  }

  const meta = readMetadata();
  if (!meta) throw new Error(`No canonical baselines: ${METADATA_FILE} is missing. ${HOW}`);
  const metaProblems = mismatches(meta, CANONICAL);
  if (metaProblems.length) {
    throw new Error(`Committed baselines were not recorded in the canonical environment.\n  ${metaProblems.join('\n  ')}\n${HOW}`);
  }
  const pngs = readdirSync(SCREENSHOT_DIR).filter((f) => f.endsWith('.png')).length;
  if (pngs !== meta.baselines) {
    throw new Error(`Baseline count ${pngs} does not match ENVIRONMENT.json (${meta.baselines}); baselines were changed outside the canonical update path. ${HOW}`);
  }
}

export function writeMetadata(env: VisualEnvironment): void {
  const baselines = readdirSync(SCREENSHOT_DIR).filter((f) => f.endsWith('.png')).length;
  const server = process.env.GITHUB_SERVER_URL;
  const runUrl = server && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID ? `${server}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
  const meta = { ...env, recordedAt: new Date().toISOString(), gitSha: process.env.GITHUB_SHA ?? process.env.VISUAL_GIT_SHA ?? null, runUrl, baselines };
  writeFileSync(METADATA_FILE, `${JSON.stringify(meta, null, 2)}\n`);
}
