# Phase 1.5 — Design System: Implementation Report

Status: implemented, awaiting component review sign-off. Revised after CI run 35219115719 (visual baseline environment) — see §7. Base: `367cfd1` (Phase 1 accepted). No Phase 1 financial, database or security semantics changed; no Phase 2 work started.

Scope source: `IMPLEMENTATION_PLAN.md` Phase 1.5, `UX_FLOWS.md §1` (tokens) and `§4` (component inventory), `DECISIONS.md D-10` (brand colour) and `D-11` (INR formatting), `docs/source/DESIGN_SYSTEM_BRIEF.md`.

## 1. What was built — `packages/ui` (`@inrp2p/ui`)

| Area | Location | Notes |
|---|---|---|
| Tokens (source of truth) | `src/tokens/tokens.ts` | Colour, spacing, type scale, weights, families, radii, shadows, motion, density, layout, `CONTRAST_REQUIREMENTS` |
| Generated CSS | `src/styles/tokens.css` (`pnpm --filter @inrp2p/ui tokens:generate`) | Unit test fails if it drifts from `tokens.ts` |
| Fonts | `fonts/` + `src/styles/fonts.css` | Geist 400/500/600, Geist Mono 400/500, self-hosted woff2, OFL licence included |
| Formatting library | `src/format/` (export `@inrp2p/ui/format`) | Deterministic, no `Intl`, no floats for money |
| Components | `src/components/*` (39) | All 36 rows of `UX_FLOWS §4` + `ArcMotif` (three-arc glyph) + `CopyButton` (used by `TransactionHash`, `DepositAddress`) + `StatusGlyph` (○ ◔ ● × as SVG) |
| Storybook | `.storybook/`, `*.stories.tsx` | 130 stories in 27 groups incl. `Foundations/Tokens` and two screen-validation groups |
| Visual + a11y + motion suite | `visual/` | Playwright over the built Storybook index — every story automatically covered |

### Formatting (D-11)
- `formatInr(Money)` → `₹10,200,000` / `₹10,200,000.00` with international three-digit grouping, implemented by string grouping over `bigint` minor units; runtime/browser locale cannot change output (no `Intl`, no `toLocaleString`).
- `formatUsdt` (2 dp summaries, 6 dp deposit instructions/receipts), `formatRate`, `formatInrCompact` / `formatUsdtCompact` (summaries only; unit promotion is exact, e.g. `999,960` never rounds to `₹1M`), `percentString`.
- Masks: `maskAccount` (`•••• 8219`, refuses to render full numbers), `maskUtr`, `maskEmail`, `shortenAddress`, `shortenHash`.
- Time: `formatIstTime` / `formatIstDateTime` (Asia/Kolkata fixed offset, deterministic), `formatCountdown`, `formatDuration`.
- ESLint: float-money bans (`parseFloat`, `Number()`, `toFixed`, `Math.round…`) now also apply to `ui/src/format/money.ts` and `number.ts`.

### Audience separation (client vs operator)
Components that exist on both surfaces take a discriminated `audience` prop (`TradeHeader`, `SettlementLegRow`). The client variant's props type has **no** route, payer, leg-source or counterparty fields, so a client screen cannot be given them by mistake at compile time. `RateDisplay` always renders the rate kind label (client / route / reference) with distinct styling. `RateComparison`, `MarginDisplay`, `RoutePositionRow`, `PayerSelector`, `DepositPoolStatus`, `CommandBar`, `StepUpDialog`, `ActionQueue` are operator-only. Components format values; they compute nothing financial.

### Accessibility and status semantics
- Status is never colour-only: every status renders a text label and a three-arc glyph/icon.
- Visible focus ring (`--brand-primary`, 3:1 graphic), `--touch-min` 44px on client buttons, amount input and verification controls, `autocomplete="one-time-code"` on `OtpInput`, screen-reader text for the countdown (`01:12 remaining`) and for copy buttons.
- Reduced motion: token durations become `0ms` under `prefers-reduced-motion`; the arc loader stops; the quote countdown falls back to text only (arc removed, `UX_FLOWS §4`).

## 2. Tokens: approved values and additions for review

All approved values in `UX_FLOWS §1` / `D-10` are implemented unchanged (`#F04E23`, `#C8401A`, hover `#B83A16`, `#6B6F77` muted, `#91959D` disabled-only, status colours, radii, shadows, motion, 64…11 scale, weights 400/500/600).

Additions required to meet the spec's own AA rule — **please confirm in review**:

| Token | Value | Why |
|---|---|---|
| `--border-control` | `#82858C` | Input outlines and meter tracks are meaningful UI graphics (WCAG 1.4.11, 3:1). `--border-default #E8E4DC` is 1.27:1 on white, so it is kept for dividers only. `#82858C` = 3.7:1 on white, 3.4:1 on `#F7F5F0` |
| `--status-success-soft` `#E8F4EC` · `--status-warning-soft` `#FBF3E2` · `--status-danger-soft` `#FCEBEA` | tints | Background for status banners/rows; every text colour used on them is contrast-checked |
| `--overlay-scrim` | `rgba(18,19,23,0.40)` | Step-up dialog backdrop |
| `--dur-loop` | `1100ms` | Continuous arc-loader rotation; loader is stopped (not zeroed) under reduced motion |
| Density | `--row-h` / `--cell-px` / `--cell-font`, switched by `[data-density="comfortable" \| "compact"]` (56px / 36px as approved) | Same values as `--row-h-comfortable` / `--row-h-compact`, expressed as one variable per mode so components don't branch |
| Layout | `--client-exchange-max 560px`, `--client-list-max 960px`, `--operator-sidebar 220px`, `--operator-panel 380px`, `--touch-min 44px` | From UX_FLOWS wireframes / responsive rules |

Contrast adjustments made while implementing (no approved value changed): `--text-muted` is not used for readable text on tinted surfaces (`brand-soft`, status soft tints) — `--text-secondary` is used there instead; white text is never placed on `--brand-primary` at body size (primary buttons use `--brand-action`).

## 3. Verification — exit criteria

| Exit criterion | Evidence |
|---|---|
| AA contrast automated check green | `packages/ui/test/design-system.unit.test.ts`: every pair in `CONTRAST_REQUIREMENTS` (text 4.5:1, graphics 3:1) computed from token values; **and** axe (`wcag2a/2aa/21a/21aa/22aa`, incl. `color-contrast`) on every rendered story: 0 violations |
| Reduced-motion variants present | Unit test: every CSS module with an animation has a `prefers-reduced-motion` block; token durations zeroed. Playwright: each `motion`-tagged story (15) is checked to animate normally, to have no running animation/transition with `reducedMotion: 'reduce'`, and has its own reduced-motion baseline; the countdown arc is asserted hidden |
| Visual regression baselines for every component state | 145 baselines: one per story (130, default motion preference) + 15 reduced-motion variants, recorded only in the canonical environment (`docs/VISUAL_BASELINES.md`) with `ENVIRONMENT.json` metadata |
| All §4 components in Storybook with realistic values | Unit test fails if any component directory is not rendered in a story; values use UX_FLOWS canon (100,000 USDT, ₹10,200,000, ₹102.00 / ₹104.20, ₹220,000, UTRs, TRC20 addresses) |
| Component review sign-off | **Pending — founder review** (Storybook, section 5) |

Token-only styling is enforced by the same unit test: no raw colours in CSS modules or component TSX; colour, typography, spacing, radius, shadow and motion declarations must use tokens (only structural `0`/`auto`/`1px` hairlines and ≤3px inset rails are allowed); every `var(--…)` must exist in `tokens.css`; no `Intl`/`toLocaleString`/`toFixed`/`parseFloat` in components.

### Local gate (all green)
| Step | Result |
|---|---|
| `pnpm install --frozen-lockfile` | up to date, supply-chain policy passes |
| `workspace:graph` | acyclic; `@inrp2p/ui ← @inrp2p/kernel` only |
| `versions:check` | OK (11 manifests) |
| `secret-scan` | clean |
| `lint` | 0 problems (boundary rule: `ui` may import `kernel` only; no package may import `ui`) |
| `typecheck` | root + apps/web + packages/ui |
| `test:unit` | 178 passed (incl. 63 ui: formatting + design-system checks) |
| `test:integration` | 362 passed (local PostgreSQL 18.4; CI enforces 18.6 as in Phase 1) |
| `@inrp2p/web build` | success |
| `@inrp2p/ui build-storybook` | success |
| `@inrp2p/ui test:visual` | 161 tests: 130 × (axe + bundled-font check + visual baseline), 30 motion checks (15 stories × allowed / reduced incl. reduced baseline), 1 guard that motion stories exist. Runs only in the canonical image (§7) |

### CI changes
`ci.yml` adds, after integration tests: Build Storybook → `playwright install --with-deps chromium` (pinned 1.56.1) → `test:visual`, uploading the Playwright report and diffs as an artifact on failure. Job timeout 30 → 45 min.

## 4. Deviations and risks

1. **Playwright pinned to 1.56.1** (latest 1.63.0) so CI uses the same Chromium revision (1194) as the recorded baselines — `DEPENDENCIES.md`.
2. Visual baselines are environment-bound; see §7 and `docs/VISUAL_BASELINES.md`.
3. `esbuild` postinstall is not allowed (`allowBuilds: false`, justified in `DEPENDENCIES.md`).
4. The `Validation/*` stories compose components into UX_FLOWS wireframes for review only; they are not app routes and hold no data fetching. App screens are built in later phases.

## 5. How to review

```bash
pnpm install --frozen-lockfile
pnpm --filter @inrp2p/ui storybook          # http://localhost:6006
# or reproduce the automated checks
pnpm --filter @inrp2p/ui build-storybook
pnpm --filter @inrp2p/ui exec playwright install chromium
pnpm --filter @inrp2p/ui test:visual
```
Suggested order: `Foundations/Tokens` → `Validation/Client` → `Validation/Operator Desk` → individual component groups (each state is a separate story).

## 6. Technical debt recorded
`docs/TECH_DEBT.md`: TD-01 (Better Auth `auth_rate_limit.last_request` number vs `bigint` warning) and TD-02 (cross-surface operator → client OTP denial returns an internal null-session error; convert to a controlled 4xx without a session before production client auth). Not fixed in this phase, by instruction.

## 7. Revision — canonical visual baseline environment (after CI run 35219115719)

**Failure.** Run 35219115719 passed every gate up to the component visual/accessibility step, which failed. The committed baselines had been recorded in the implementation sandbox (Ubuntu 24.04 x86_64, Playwright's Chromium 1194 build) rather than in a declared, reproducible environment, and the suite had no guard against comparing across environments.

**Genuine rendering issue found and fixed.** Three characters used in components are not in Geist: `◔` U+25D4 (`QuoteStatus`, `TradeProgress`), `⌘` U+2318 (`CommandBar`) and `⧗` U+29D7 (a code comment only). The browser rendered `◔` and `⌘` with whatever system font the machine had, so those pixels differ between machines regardless of browser version. Fixed at the source: new `StatusGlyph` SVG component (○ ◔ ● ×, `currentColor`) used by `QuoteStatus` and `TradeProgress`, and an SVG command-key icon in `CommandBar`. A new per-story check (`CSS.getPlatformFontsForNode`) fails if any glyph is rendered by a non-bundled font. No token, tolerance, axe rule or reduced-motion check changed.

**Changes.**
- Canonical environment: `mcr.microsoft.com/playwright:v1.56.1-noble`, linux/amd64, Playwright 1.56.1, Chromium 141.0.7390.37 (`visual/environment.ts`).
- Environment mismatch guard (`visual/global-setup.ts`) — see `VISUAL_BASELINES.md §2`.
- CI: visual suite moved to its own compare-only job `visual` running in the canonical image; `UPDATE_VISUALS` rejected for push / pull_request.
- Intentional update path: manual workflow `Visual baselines (canonical update)` (records, re-verifies, pushes `visual-baselines/run-<id>` for review) and `visual/docker.sh compare|update`.
- Determinism: fixed clock, explicit font loading + `document.fonts.ready`, two frames, animations disabled, caret hidden, bundled-font assertion.
- Non-canonical sandbox baselines removed from the repository; canonical baselines are recorded by the workflow.
