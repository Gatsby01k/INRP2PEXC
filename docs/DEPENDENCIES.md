# INRP2P Exchange — Dependency and Version Matrix

Status: Phase 2 (no new external dependencies; six new workspace packages: adapters, clients, inr-accounts, routes, pricing, treasury). Source of truth for approved versions (D-06). Enforced by `pnpm run versions:check` (exact pins in every manifest, installed versions equal pins, Node and pnpm match) and by CI.

## Runtime and platform

| Component | Pinned version | Where pinned |
|---|---|---|
| Node.js (24 LTS line) | 24.21.0 | `.nvmrc`, root `engines.node`, CI `setup-node` |
| pnpm | 12.4.2 | root `packageManager`, `engines.pnpm`, CI |
| PostgreSQL | 18.6 | CI Testcontainers image `postgres:18.6` + `REQUIRE_PG_VERSION=18.6` assertion |

## Packages

| Package | Version | Used by |
|---|---|---|
| typescript | 6.0.3 | all (strict, `erasableSyntaxOnly`, Node type stripping) |
| next | 16.3.5 | apps/web |
| react / react-dom | 19.3.0 | apps/web, packages/ui |
| @types/react / @types/react-dom | 19.3.0 | apps/web, packages/ui |
| server-only | 0.0.1 | apps/web |
| better-auth | 1.7.5 | packages/identity, apps/web |
| @better-auth/utils | 0.4.2 | identity tests (TOTP generation); equals better-auth's own dependency |
| kysely | 0.29.6 | db and all domain packages |
| pg | 8.23.0 | db, outbox, worker |
| graphile-worker | 0.18.0 | outbox, apps/worker |
| vitest | 5.0.1 | tests |
| vite | 8.3.0 | vitest peer, Storybook builder |
| @testcontainers/postgresql | 12.1.0 | integration test global setup |
| eslint | 10.10.0 | lint |
| typescript-eslint | 8.70.0 | lint |
| @eslint/js | 10.0.1 | lint |
| @types/node | 24.13.5 | all |
| @types/pg | 8.23.1 | db |

### Added in Phase 1.5 (packages/ui)

| Package | Version | Used by | License |
|---|---|---|---|
| storybook | 10.6.0 | component gallery (`pnpm --filter @inrp2p/ui storybook` / `build-storybook`) | MIT |
| @storybook/react-vite | 10.6.0 | Storybook framework (React 19 + Vite 8) | MIT |
| @storybook/addon-a11y | 10.6.0 | in-gallery axe panel (`a11y.test = 'error'`) | MIT |
| @playwright/test | 1.56.1 | visual regression + axe + reduced-motion suite (`test:visual`) | Apache-2.0 |
| @axe-core/playwright | 4.13.0 (axe-core 4.13.0) | WCAG 2.2 AA checks per story | MPL-2.0 |
| uqr | 0.1.3 | deposit address QR (pure SVG path generation, no canvas, no network) | MIT |
| lighthouse | 13.4.1 | the quote link's mobile budget (`test:lighthouse`), measured against the built page | Apache-2.0 |
| Geist / Geist Mono | woff2 from npm `geist@1.7.2` (`dist/fonts`), vendored in `packages/ui/fonts` (not an npm dependency) | self-hosted fonts (no Google Fonts / CDN request) | SIL OFL 1.1 (`fonts/OFL-LICENSE.txt`) |

**Lighthouse (approved, Phase 7).** The quote link is the product for someone who has never signed in: a message arrives, they open it on a phone, and a firm price is counting down while it loads. A slow page there is a quote the client could not accept in time, so the budget is measured rather than asserted in review — Lighthouse's own mobile defaults (mid-tier phone, throttled network and CPU), against the **built** page, in the same pinned Chromium the pixel baselines use. Performance, accessibility and best practices are gated at 90; SEO is printed but not gated, because a private quote is deliberately `noindex` and gating on it would mean either lying about the page or making it indexable. Pinned to 13.4.1 rather than the current 13.5.0: that release is a day old, and pnpm's minimum-release-age protection is not something to switch off for a test dependency. Dev/test-only; never shipped in the app.

**Playwright pin (approved; latest is 1.63.0).** Visual baselines are pixel comparisons, so they are only meaningful against a fixed browser build and OS. 1.56.1 bundles Chromium 141.0.7390.37 (revision 1194). The canonical visual environment is the official image `mcr.microsoft.com/playwright:v1.56.1-noble` on linux/amd64, used by the CI `visual` job and by the manual baseline-update workflow (`docs/VISUAL_BASELINES.md`). Upgrading Playwright changes the image tag, `visual/environment.ts` and all baselines in one reviewed change. Playwright is a dev/test-only dependency and never ships in the app.

Zod is still not a direct dependency (installed transitively by Better Auth only); it is added with the first HTTP/command boundary that needs it.

### Added for the public home page's hero

| Package | Version | Used by | License |
|---|---|---|---|
| three | 0.186.0 | apps/web — the hero's live robot (WebGL), fetched on demand after the page has loaded | MIT |
| @types/three | 0.186.0 | apps/web type checking; same minor as `three`; dev only | MIT |
| framer-motion | 13.4.3 | apps/web — the hero quote module's term transitions (`LazyMotion` + `domAnimation`, `MotionConfig reducedMotion="user"`) | MIT |

**three (approved for the hero).** The robot is a brand element drawn live: it watches the quote module, reads while an amount is typed and acknowledges it, and shows which way value flows when the direction changes. Only the live path loads three.js (≈140 KB gzip, one lazy chunk, after `load` and an idle callback). The still robot — rendered from the same scene by `pnpm --filter @inrp2p/web poster:robot` and committed as three WebP sizes of 21–47 KB — is what everyone sees on first paint, and all that is shown to reduced-motion and Save-Data visitors, low-memory devices, and browsers that can only draw WebGL in software (`failIfMajorPerformanceCaveat`, SwiftShader/llvmpipe). That includes the headless browsers the e2e, visual and Lighthouse runs use, so those runs are deterministic and measure the page without the robot's cost. Nothing is downloaded at runtime: the environment map is generated from a small studio scene, and there is no model file.

**No React renderer for it.** `@react-three/fiber` was evaluated and not added: 9.7 refuses React 19.3 (peer `<19.3`), 9.8 exists specifically to accept it — a dependency that has to be re-released for every React minor is a poor fit for a matrix pinned this tightly — and with three ≥ r183 it logs a `THREE.Clock` deprecation warning on every page view. For one figure in one fixed shot a reconciler adds nothing; the scene is plain three.js behind a small React component.

**Versions.** three 0.186.0 rather than 0.186.1, which was a day old. framer-motion 13.4.3 rather than 13.4.4: 13.4.4 and its `motion-dom` were younger than pnpm's minimum release age, and this repository takes no release-age exclusions (`motion-dom` resolves to 13.4.2). framer-motion's peers are `react`/`react-dom ^18 || ^19`; three has none. None of the added packages or their dependencies (`motion-dom`, `motion-utils`, `tslib`; `@types/three`'s type-only dependencies) has an install script, so `allowBuilds` is unchanged.

**Tree-shaking the workspace packages.** `@inrp2p/ui` declares `"sideEffects": ["*.css"]` and `@inrp2p/kernel` `"sideEffects": false`; neither has a module-level side effect other than a component importing its own CSS module. Without them, any client component importing from either barrel shipped the whole package: every public page carried all forty design-system components (158 KB gzip) through the masthead's `ArcMotif`, and anything importing `Money` pulled in the kernel's `node:crypto` users (TRON checksums, id generation) and the browser polyfill that replaces them (138 KB gzip). Measured on the production build: SEO pages now load only the framework (138 KB gzip); the home page adds ≈35 KB gzip for the hero's two islands.

## Compatibility verification (performed 2026-09-17 from registry metadata and local execution)

| Check | Evidence |
|---|---|
| next 16.3.5 on Node 24 | `engines.node >=20.9.0`; `next build` succeeds on Node 24.21.0 with TypeScript 6.0.3 |
| next 16.3.5 ↔ react 19.3.0 | peer `react ^18.2.0 \|\| ^19.0.0`; react-dom 19.3.0 peer `react ^19.3.0` |
| better-auth 1.7.5 ↔ next / react / pg / vitest | peers `next ^14 \|\| ^15 \|\| ^16`, `react ^18 \|\| ^19`, `pg ^8`, `vitest ^2…^5` |
| better-auth 1.7.5 ↔ kysely 0.29.6 | dependency `kysely ^0.28.17 \|\| ^0.29.0`; lockfile resolves a single kysely 0.29.6 |
| graphile-worker 0.18.0 on Node 24 / pg 8.23 | `engines.node >=22.18.0`; dependency `pg ^8.11.3` |
| kysely 0.29.6 on Node 24 | `engines.node >=22.0.0` |
| vitest 5.0.1 | `engines.node ^24.0.0`; peers `vite ^8`, `@types/node >=24` |
| typescript-eslint 8.70.0 ↔ TypeScript 6.0.3 / ESLint 10 | peers `typescript >=4.8.4 <6.1.0`, `eslint ^10` |
| PostgreSQL 18 features used | `uuidv7()`, `uuid_extract_version()`, `pg_current_xact_id()`/`xid8`, deferrable constraint triggers, statement-level `TRUNCATE` triggers |
| storybook 10.6.0 ↔ react 19.3.0 / vite 8.3.0 / TypeScript 6.0.3 | `@storybook/react-vite` peers `react ^16.8…^19`, `vite ^5…^8`, `typescript >= 4.9`, `storybook ^10.6.0`; `build-storybook` succeeds on Node 24.21.0 |
| @axe-core/playwright 4.13.0 ↔ @playwright/test 1.56.1 | peer `playwright-core >= 1.0.0` |
| Storybook addon-a11y + Playwright axe | addon panel is set to manual inside the test run (`globals=a11y.manual:!true`) so only one axe run executes per page |
| Better Auth schema | integration test runs Better Auth's migration planner against migration 0006 and asserts nothing to create or add |
| framer-motion 13.4.3 ↔ react 19.3.0 | peers `react ^18.0.0 \|\| ^19.0.0`, `react-dom ^18.0.0 \|\| ^19.0.0` |
| three 0.186.0 ↔ next 16.3.5 (Turbopack) / TypeScript 6.0.3 | no peers; `next build` succeeds with three in its own lazy chunk; `@types/three` 0.186.0 typechecks under the repository's strict settings |
| Workspace `sideEffects` declarations | `next build` and every unit test pass; production home page script 329 → 174 KB gzip on the still path |

## Build scripts (pnpm `allowBuilds`)

pnpm 12.4.2 blocks every dependency lifecycle script unless `pnpm-workspace.yaml` lists the package under `allowBuilds`; in CI an unlisted package with a script aborts the install with `ERR_PNPM_IGNORED_BUILDS`. The policy is explicit and minimal: **no dependency build script is allowed**, because none is required.

| Package | Pulled in by | Script | Decision | Why |
|---|---|---|---|---|
| ssh2 1.17.0 | `@testcontainers/postgresql` → testcontainers → dockerode / docker-modem, ssh-remote-port-forward | `install`: node-gyp build of an optional crypto binding; exits 0 on failure | `false` | Pure-JS fallback is built in; Testcontainers uses the local Docker socket, SSH transport is not used |
| cpu-features 0.0.10 | optionalDependency of ssh2 | `install`: node-gyp native build | `false` | Only feeds the optional ssh2 binding above |
| protobufjs 7.6.6 | dockerode → @grpc/proto-loader | `postinstall`: prints a version-scheme warning | `false` | No build output; runtime unaffected |
| esbuild | storybook, vite (Phase 1.5) | `postinstall`: replaces the JS launcher with the platform binary from the optional `@esbuild/<platform>` package | `false` | The optional platform package is installed and used by the JS launcher; Storybook build and Vitest work without the script |

Adding a dependency with an install script fails CI until an explicit entry (with justification here) is added. `true` requires review of the script source.

`minimumReleaseAgeExclude: [kysely@0.29.6]`, which pnpm had written locally while kysely 0.29.6 was less than one day old, was removed: the release now satisfies pnpm's default minimum release age, so the supply-chain release-age check applies to every package without exceptions.

## Workspace dependency graph

`pnpm run workspace:graph` (CI step) fails on any cycle across dependencies, devDependencies, optionalDependencies or peerDependencies, on any `packages/*` → `apps/*` edge, and on workspace dependencies not using `workspace:`. Tests that compose several packages (pipeline + ledger + audit + outbox) live in root `test/integration/`, so packages never need a dev dependency on a package above them.

## Environment limitation during Phase 1 implementation

The implementation sandbox could not pull container images (Docker Hub, ECR Public, GCR mirror and GHCR are blocked by egress policy) and could not reach postgresql.org. Local verification therefore ran against **PostgreSQL 18.4** binaries (`@embedded-postgres/linux-x64@18.4.0-beta.17`, via `TEST_DATABASE_URL`). The repository still pins 18.6: CI uses Testcontainers `postgres:18.6` and fails if the server version is not exactly 18.6. First green CI run on GitHub is the 18.6 evidence.
