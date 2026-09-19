# Visual Baselines — Canonical Environment and Update Path

Status: Phase 7. Two pixel suites, one environment and one update path:

| Suite | What it captures | Where |
|---|---|---|
| Components | every Storybook story → axe WCAG 2.2 AA, bundled-font check, reduced-motion checks, pixel baselines | `packages/ui/visual` |
| Pages | the **built** products driven against a seeded database — the operator validation list (`pages.spec.ts`), the client validation list (`client-pages.spec.ts`) and the public quote link on a phone (`link-pages.spec.ts`) | `apps/web/visual` |

The page suite runs all three surfaces of the built app at once — the desk, the client app and the public host —
because a page captured from the wrong surface would be a baseline of a bug. The client captures are taken under
a session the product itself issued (the real sign-in form); the link captures are taken with no session at all,
which is the whole premise of the shareable link (D-01).

The definition of the canonical environment and the guard that enforces it live once, in `@inrp2p/visual`
(`packages/visual`), so the two suites cannot drift on what they will accept.

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

Source of truth in code: `packages/visual/src/index.ts` (`CANONICAL`). Each suite's
`__screenshots__/ENVIRONMENT.json` records the environment, git SHA, run URL, time and baseline count of its
last recording — `packages/ui/visual/__screenshots__/` for the components, `apps/web/visual/__screenshots__/`
for the pages.

The page suite additionally needs a PostgreSQL 18 server, because its captures come from real seeded rows.

## 2. Environment mismatch guard (`@inrp2p/visual` `guardVisualRun`)

Before any test runs, the suite refuses to compare or record when:
- the current image, platform, architecture, Playwright version or Chromium version differs from `CANONICAL` (the image is trusted only if `VISUAL_ENV_IMAGE` is set **and** `/ms-playwright` exists);
- `ENVIRONMENT.json` is missing, or was recorded in a different environment;
- the number of committed PNGs differs from `ENVIRONMENT.json` (baselines changed outside the update path);
- a baseline the suite expects is not there (the page suite names its twenty in `apps/web/visual/captures.ts`);
- `UPDATE_VISUALS=1` is set in GitHub Actions for any event other than `workflow_dispatch`;
- `--update-snapshots` / `-u` is passed on the command line (config throws; only `UPDATE_VISUALS=1` records).

Running `pnpm --filter @inrp2p/ui test:visual` or `pnpm --filter @inrp2p/web test:visual` on macOS or any non-canonical machine therefore fails fast with the reason, instead of producing misleading pixel diffs.

**Self-check (development aid, never a gate).** `pnpm --filter @inrp2p/web test:visual:selfcheck` runs the page
suite outside the canonical environment, writing its captures to `apps/web/visual/.selfcheck/` — untracked, never
compared against the committed baselines, refused under CI, and announced with a warning banner on every run. It
answers "does the suite reach these states, and does it reach them reproducibly?" It never answers "are the
baselines right"; only the canonical environment answers that.

## 3. Compare-only CI

`.github/workflows/ci.yml` runs two compare-only jobs on every push and pull request, both inside the canonical
image:

- **`visual`** — install → build Storybook → `pnpm --filter @inrp2p/ui test:visual`.
- **`visual-pages`** — install → build the web app → `pnpm --filter @inrp2p/web test:visual`, with a
  `postgres:18.6` service for the fixture world.

`updateSnapshots` is `none` in both, so a missing or different baseline fails. Neither job ever sets
`UPDATE_VISUALS`. On failure the Playwright HTML report and `*-actual.png` / `*-diff.png` are uploaded as the
`visual-report` / `visual-pages-report` artifacts.

Tolerance is fixed (`maxDiffPixelRatio 0.002`, `threshold 0.2`) and is not changed to make a run pass.

## 4. Determinism before every capture (`packages/ui/visual/components.spec.ts`)

1. `page.clock.setFixedTime(2026-09-16T10:41:00Z)` (the fixture `NOW`) before navigation — countdown and relative times are fixed.
2. Reduced-motion preference emulated explicitly per test (`no-preference` for the main baseline, `reduce` for the reduced-motion baseline).
3. Every Geist face requested with `document.fonts.load`, then `await document.fonts.ready`, then poll until `document.fonts.status === 'loaded'` and every face `check()`s.
4. Two animation frames to let layout settle after font swap.
5. `toHaveScreenshot` with `animations: 'disabled'` (CSS animations/transitions finished or cancelled) and `caret: 'hide'`.
6. Chrome DevTools Protocol `CSS.getPlatformFontsForNode` on every element: any glyph rendered by a non-bundled (system) font fails the test, naming the text that did it. Glyphs missing from Geist are drawn as SVG instead (`StatusGlyph` for ○ ◔ ● ×, `StepUpMark` for the ⧗ step-up marker, `ArcMotif` for the ◗ brand mark, the ⌘ key icon in `CommandBar`).

## 4b. Determinism before every page capture (`apps/web/visual/`)

A page is harder to pin than a story, because it shows what a database says. The fixture world
(`apps/web/visual/world.ts`) is therefore deterministic in three layers:

1. **The business clock is frozen for the whole fixture database.** `alter database … set inrp2p.clock_override`
   (migration 0012, honoured only where the test permit table exists) fixes `inrp2p_now()` at
   `2026-09-19T09:11:00Z`, so every generated reference (`IX-260919-0002`) and every business timestamp is the
   same on every run, on any day. Authentication and session freshness keep using real time, so sign-in, idle
   timeout and step-up behave exactly as in production.
2. **Nothing is random.** Addresses and hashes come from fixed strings; amounts, rates and the order of creation
   are fixed. The world is built by the same domain commands the product uses, so a state can only appear in a
   baseline if the product can really produce it.
3. **The few wall-clock columns are pinned.** A rate snapshot's age is measured against real time by design, and
   the settlement day is a wall-clock concept; those columns (`world.ts` `WALL_CLOCK_COLUMNS`) are moved to the
   frozen instant after seeding. The single piece of text that still follows the wall clock — the INR page's
   `YYYY-MM-DD IST` day — is rewritten in the DOM immediately before the capture (`support.ts`
   `pinWallClockText`). Nothing else is masked: every other pixel is compared.

The twenty capture names live in one static manifest, `apps/web/visual/captures.ts`, read by all three page spec
files, by the
compare guard and by the update reporter. It is static because the reporter has to know the whole expected set
*before* any test runs, in order to drop baselines nothing expects any more without touching the ones that are
simply about to be recorded; an update that does not produce every name in the manifest records no metadata and
fails, rather than blessing a partial set.

Each capture then waits for the bundled fonts, settles layout over two animation frames, asserts no system-font
fallback, and is taken with `animations: 'disabled'` and `caret: 'hide'`. The browser clock is fixed to the same
instant as the business clock. The suite signs in once and shares the session, because the desk rate-limits
repeated verification on purpose.

## 5. Intentional baseline update — the only way to change baselines

Baselines change only when a visual change is intended (new story, approved design change, Playwright upgrade). Two equivalent paths, both in the canonical image:

### A. GitHub Actions (authoritative)
1. Push the code change.
2. Actions → **Visual baselines (canonical update)** → *Run workflow* on the branch, with a reason.
3. Two jobs run: `record` for the components and `record-pages` for the operator, client and link pages. Each builds what it
   needs, records with `UPDATE_VISUALS=1` (axe, bundled-font and reduced-motion assertions still enforced — a failing story records nothing usable), re-runs compare-only to prove stability, uploads the baselines artifact, and pushes a review branch with one commit containing only that suite's
   `__screenshots__` (PNG + `ENVIRONMENT.json`): `visual-baselines/run-<run id>` for the components,
   `visual-baselines/pages-run-<run id>` for the pages.
4. Review the image diff of that commit (GitHub's image diff view), then fast-forward the target branch to it. Ordinary CI on the resulting push must be green.

### B. Local Docker (x64 hosts)
```bash
bash packages/ui/visual/docker.sh compare   # reproduce CI
bash packages/ui/visual/docker.sh update    # record into packages/ui/visual/__screenshots__

TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres \
  bash apps/web/visual/docker.sh compare    # the operator, client and link pages; needs a reachable PostgreSQL 18
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres \
  bash apps/web/visual/docker.sh update
```
Runs `git archive HEAD` inside `mcr.microsoft.com/playwright:v1.56.1-noble` with `--platform linux/amd64`, so host `node_modules` and uncommitted edits are never used. On Apple Silicon the image runs under emulation; CPU-emulated rendering is expected but not guaranteed to be bit-identical, so a locally recorded update must still pass CI's compare job before merge. Path A is authoritative.

### Review rules
- Every changed PNG is looked at. Differences that come from environment (anti-aliasing, font fallback) are fixed at the source, not accepted.
- Pixel tolerance, axe rules, reduced-motion checks and design tokens are never changed to make baselines pass.
- Upgrading Playwright changes `CANONICAL`, the image tag, `DEPENDENCIES.md` and all baselines in one reviewed change.
