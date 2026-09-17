# Visual Baselines — Canonical Environment and Update Path

Status: Phase 1.5. Applies to `packages/ui/visual` (Storybook stories → axe WCAG 2.2 AA, bundled-font check, reduced-motion checks, pixel baselines).

## 1. Canonical environment

Pixel baselines are only comparable when rendered by the same browser build, OS, CPU architecture, system libraries and font configuration. There is exactly one canonical environment:

| Property | Value |
|---|---|
| Container image | `mcr.microsoft.com/playwright:v1.56.1-noble` (Ubuntu 24.04, browsers preinstalled at `/ms-playwright`) |
| Platform / architecture | `linux` / `x64` (`linux/amd64`) |
| Playwright | `@playwright/test` 1.56.1 (pinned, `DEPENDENCIES.md`) |
| Browser | Chromium 141.0.7390.37 (revision 1194, headless shell) |
| Fonts | Geist / Geist Mono woff2 bundled in `packages/ui/fonts`; no system font may render any glyph |
| Viewport / scale | 375 (mobile stories), 1440 (desk), 1024 (others); `deviceScaleFactor` 1; `timezoneId` UTC; `locale` en-US; light scheme |

Source of truth in code: `packages/ui/visual/environment.ts` (`CANONICAL`). `packages/ui/visual/__screenshots__/ENVIRONMENT.json` records the environment, git SHA, run URL, time and baseline count of the last recording.

## 2. Environment mismatch guard (`visual/global-setup.ts`)

Before any test runs, the suite refuses to compare or record when:
- the current image, platform, architecture, Playwright version or Chromium version differs from `CANONICAL` (the image is trusted only if `VISUAL_ENV_IMAGE` is set **and** `/ms-playwright` exists);
- `ENVIRONMENT.json` is missing, or was recorded in a different environment;
- the number of committed PNGs differs from `ENVIRONMENT.json` (baselines changed outside the update path);
- `UPDATE_VISUALS=1` is set in GitHub Actions for any event other than `workflow_dispatch`;
- `--update-snapshots` / `-u` is passed on the command line (config throws; only `UPDATE_VISUALS=1` records).

Running `pnpm --filter @inrp2p/ui test:visual` on macOS or any non-canonical machine therefore fails fast with the reason, instead of producing misleading pixel diffs.

## 3. Compare-only CI

`.github/workflows/ci.yml` job **`visual`** runs on every push and pull request inside the canonical image: install → build Storybook → `test:visual`. `updateSnapshots` is `none`, so a missing or different baseline fails. The job never sets `UPDATE_VISUALS`. On failure the Playwright HTML report and `*-actual.png` / `*-diff.png` are uploaded as the `visual-report` artifact.

Tolerance is fixed (`maxDiffPixelRatio 0.002`, `threshold 0.2`) and is not changed to make a run pass.

## 4. Determinism before every capture (`visual/components.spec.ts`)

1. `page.clock.setFixedTime(2026-09-16T10:41:00Z)` (the fixture `NOW`) before navigation — countdown and relative times are fixed.
2. Reduced-motion preference emulated explicitly per test (`no-preference` for the main baseline, `reduce` for the reduced-motion baseline).
3. Every Geist face requested with `document.fonts.load`, then `await document.fonts.ready`, then poll until `document.fonts.status === 'loaded'` and every face `check()`s.
4. Two animation frames to let layout settle after font swap.
5. `toHaveScreenshot` with `animations: 'disabled'` (CSS animations/transitions finished or cancelled) and `caret: 'hide'`.
6. Chrome DevTools Protocol `CSS.getPlatformFontsForNode` on every element: any glyph rendered by a non-bundled (system) font fails the test. Glyphs missing from Geist are drawn as SVG instead (`StatusGlyph` for ○ ◔ ● ×, the ⌘ key icon in `CommandBar`).

## 5. Intentional baseline update — the only way to change baselines

Baselines change only when a visual change is intended (new story, approved design change, Playwright upgrade). Two equivalent paths, both in the canonical image:

### A. GitHub Actions (authoritative)
1. Push the code change.
2. Actions → **Visual baselines (canonical update)** → *Run workflow* on the branch, with a reason.
3. The workflow builds Storybook, records with `UPDATE_VISUALS=1` (axe, bundled-font and reduced-motion assertions still enforced — a failing story records nothing usable), re-runs compare-only to prove stability, uploads the baselines artifact, and pushes branch `visual-baselines/run-<run id>` with one commit containing only `packages/ui/visual/__screenshots__` (PNG + `ENVIRONMENT.json`).
4. Review the image diff of that commit (GitHub's image diff view), then fast-forward the target branch to it. Ordinary CI on the resulting push must be green.

### B. Local Docker (x64 hosts)
```bash
bash packages/ui/visual/docker.sh compare   # reproduce CI
bash packages/ui/visual/docker.sh update    # record into packages/ui/visual/__screenshots__
```
Runs `git archive HEAD` inside `mcr.microsoft.com/playwright:v1.56.1-noble` with `--platform linux/amd64`, so host `node_modules` and uncommitted edits are never used. On Apple Silicon the image runs under emulation; CPU-emulated rendering is expected but not guaranteed to be bit-identical, so a locally recorded update must still pass CI's compare job before merge. Path A is authoritative.

### Review rules
- Every changed PNG is looked at. Differences that come from environment (anti-aliasing, font fallback) are fixed at the source, not accepted.
- Pixel tolerance, axe rules, reduced-motion checks and design tokens are never changed to make baselines pass.
- Upgrading Playwright changes `CANONICAL`, the image tag, `DEPENDENCIES.md` and all baselines in one reviewed change.
