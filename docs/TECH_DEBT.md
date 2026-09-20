# INRP2P Exchange — Technical Debt Register

Non-blocking items accepted at phase review. Each entry names the phase that must close it. Items here never change financial or security semantics until they are fixed; the fix itself goes through normal review.

| ID | Area | Recorded | Must close before | Status |
|---|---|---|---|---|
| TD-01 | Auth schema: `auth_rate_limit.last_request` type warning | Phase 1 acceptance (2026-09-17) | Production deploy (launch checklist) | Open |
| TD-02 | Auth: cross-surface operator → client OTP rejection surfaces as internal error | Phase 1 acceptance (2026-09-17) | Production client auth (client login enabled on `app.inrp2p.com`) | Open |
| TD-03 | Encryption: production KMS-backed key-encryption key not implemented | Phase 2 implementation (2026-09-17) | First deployment holding real bank or contact data | Open |
| TD-04 | Notifications: no email provider bound — acceptance codes, client sign-in codes and notification emails | Phase 3 implementation (2026-09-17) | Any environment where a client signs in or accepts a quote through a shareable link | Open — widened at Phase 7 |
| TD-05 | Chain verification: no TRON provider bound; scanning not implemented | Phase 4 implementation (2026-09-18) | Any environment that settles real USDT | Closed in Phase 5 (2026-09-18) |
| TD-06 | Scanner: no tooling for a deliberate historical backfill behind the cursor | Phase 5 implementation (2026-09-18) | First production incident needing a historical rescan | Open (narrowed at Phase 5 review) |
| TD-07 | Scanner: the TRON provider smoke gate has never been executed against real providers | Phase 5 implementation (2026-09-18) | Any environment that settles real USDT | Open — gate exists, **NOT RUN** |
| TD-08 | Visual regression covers the Storybook validation stories, not the built operator pages | Phase 6 implementation (2026-09-19) | Production deploy (launch checklist) | Closed in Phase 6 review (2026-09-19) |
| TD-09 | The page baselines have not been recorded in the canonical environment | Phase 6 review (2026-09-19) | The `visual-pages` CI job can pass | Closed in Phase 7 review (2026-09-19) — 20 baselines recorded, `visual` / `visual-pages` green on main |
| TD-10 | Outbox: the desk's own signals and the receipt trigger are acknowledged, not consumed | Phase 7 implementation (2026-09-19) | A desk push channel (desk signals) and Phase 8 (receipts) | Open |
| TD-11 | Client TOTP enrolment does not exist, so client-side destination management is desk-only | Phase 7 implementation (2026-09-19) | A client managing their own bank accounts or wallets, or granting quote-acceptance authority | Open |
| TD-12 | Receipts are proved by hash, not stored: no object store, and PDF printing is opt-in | Phase 8 implementation (2026-09-20) | A deployment that must serve a receipt without re-rendering it, or print PDFs | Open |
| TD-13 | New page baselines have not been recorded in the canonical environment | Phase 8 implementation (2026-09-20) | The `visual-pages` CI job can pass | Phase 8 recorded (run `35495412975`); reopened for Phase 9's two public captures |
| TD-14 | Reconciliation is a manual statement import; there is no recurring job | Phase 8 implementation (2026-09-20) | A bank feed or statement drop that arrives without an operator | Open |
| TD-15 | The public site cannot be edge-cached while its CSP nonce is per-request | Phase 9 implementation (2026-09-20) | The public site needs to be served from a CDN | Open |
| TD-16 | The backup/restore drill has never been run against real infrastructure | Phase 9 implementation (2026-09-20) | Production launch (launch checklist) | Open — scripted, never executed |
| TD-17 | Audit seals are written but never exported off-site | Phase 9 implementation (2026-09-20) | Production launch (launch checklist) | Open |

## TD-01 — Better Auth schema warning for `auth_rate_limit.last_request`

**Observed.** Better Auth 1.7.5 declares `rateLimit.lastRequest` as `number`; migration 0006 stores `auth_rate_limit.last_request` as PostgreSQL `bigint` (epoch milliseconds do not fit `integer`). Better Auth's schema comparison logs a type-mismatch warning. The migration planner integration test still reports nothing to create or add, and the Phase 1 auth integration tests pass.

**Risk.** Log noise that can hide a real schema drift warning; node-postgres returns `bigint` as a string by default, so the library relies on implicit coercion for this field.

**Resolution (to do).** Keep `bigint` in the database (the value is epoch ms). Either register a Kysely/pg type parser for this column so the adapter returns a number, or map the field via Better Auth's schema `fieldName`/type options, then assert in the Better Auth schema integration test that the planner emits **no warnings** for `auth_rate_limit`. No change to rate-limit windows, limits or keys.

## TD-02 — Cross-surface operator → client OTP rejection causes an internal Better Auth null-session error

**Observed.** An operator identity attempting client email-OTP sign-in is correctly denied: no client session is created and the request fails. The denial is implemented in `packages/identity/src/auth/config.ts` `sessionCreateGuard` (`databaseHooks.session.create.before` returns `false` when `auth_user.kind` ≠ surface). Better Auth then proceeds with a null session and fails internally instead of returning an expected client error. The current test (`packages/identity/test/auth.int.test.ts` "an operator email cannot sign in through client OTP") only asserts status ≥ 400 and that no client session exists.

**Invariant that already holds and must be kept.** No session is ever created for a cross-surface attempt (application guard + database trigger `IX020` rejecting a session whose surface does not match the user kind); operator and client surfaces stay isolated (`SECURITY.md`, `ARCHITECTURE.md §7`).

**Resolution (to do, before production client auth).** Keep the session guard and the `IX020` trigger as defence in depth, and add a surface check before session creation (a `before` hook on `/sign-in/email-otp` and `/email-otp/send-verification-otp` resolving the user kind) that returns a controlled 4xx (`403` with a generic, non-enumerating error body — same response shape as an invalid code) without creating a session. Tests to add: operator email → client OTP verify returns the controlled 4xx; no `auth_session` row is inserted; no `Set-Cookie`; a `session.failed` audit event recorded once; response body and timing do not reveal that the address belongs to an operator.

## TD-03 — Production key-encryption key (KMS) adapter

**Observed.** Bank account numbers (client and exchange INR accounts) and contact phone numbers are envelope-encrypted by `packages/adapters` `createFieldProtector` (fresh AES-256-GCM data key per value, wrapped by a `KeyEncryptionKey`, AAD bound to the field and owner). The only `KeyEncryptionKey` implementation is `LocalKeyEncryptionKey`, which holds the 32-byte KEK in process memory. It is intended for development and tests.

**Risk.** Using the local KEK in a real deployment would put key material in application configuration, contrary to ARCHITECTURE §8 (data key wrapped by cloud KMS).

**Resolution (to do, before any deployment with real data).** Implement a KMS-backed `KeyEncryptionKey` for the chosen hosting provider (wrap/unwrap via KMS API, key id recorded in each sealed value), load the HMAC lookup key from the secret manager, and add a startup check that refuses `LocalKeyEncryptionKey` when `NODE_ENV=production`. Rotation keeps previous KEKs readable through `previous` (already supported and tested).


## TD-04 — No email provider for acceptance codes

**Observed.** Acceptance codes are generated, sealed and queued for delivery by `packages/quotes` (`acceptance_otp.deliver` outbox event → `acceptanceCodeHandler` → `NotificationAdapter`). The only adapters that exist are `UnconfiguredNotificationAdapter`, which throws on every send, and the test fake. The worker wires the unconfigured adapter, so a queued code fails delivery and stays visible as a failed outbox delivery; it is never logged and its sealed copy is erased when the challenge closes.

**Risk.** Link acceptance cannot complete in any environment until a provider is bound. This is deliberate for Phase 3 (a silent or logging adapter would put codes in logs, contrary to SECURITY §2.3), but it is a launch blocker for the client link flow.

**Resolution (to do, before link acceptance is enabled anywhere).** Implement a `NotificationAdapter` for the chosen transactional-email provider (template carrying only code, quote reference and expiry; no amounts, bank or wallet details), load its credentials from the secret manager, record the provider message id on `otp_delivery` (already supported), and add an integration test that a provider failure leaves the challenge PENDING and the outbox delivery retryable without regenerating the code. The same wiring needs the KMS-backed key from TD-03, since the worker must open the sealed code to send it.

**Widened at Phase 7 (2026-09-19).** The same missing provider now blocks three things rather than one, and all
three fail the same way — loudly, never into a log:

* **Acceptance codes**, as above.
* **Client sign-in.** The client product authenticates with a code to a known address (SECURITY §2.2). With no
  provider the sender throws, so nobody can sign in to the client app in a deployed environment. The only
  alternative is `INRP2P_CLIENT_OTP_SINK_FILE`, a test-only file sink that the runtime **refuses outright when
  `INRP2P_ENV=production`** and that is off unless a path is named; the end-to-end and page-visual runs use it so
  they can sign in through the real form rather than forge a session row.
* **Client notification emails.** `clientNotificationEmailHandler` carries the in-app inbox's own words to the
  client's verified addresses. It is registered **only** when a provider exists (`isNotificationProviderConfigured`),
  because a handler that throws on every send fails its event, and an unconfigured deployment would retry and
  eventually fail every client event it emits — taking the working in-app channel down with it. The worker says so
  at startup: *client notifications: in-app only — no email provider is configured (TD-04)*.

**Resolution (unchanged in shape, wider in scope).** One `NotificationAdapter` implementation closes all three:
`sendAcceptanceCode`, `sendClientNotification`, and the client sign-in sender in
`apps/web/src/server/client-otp.ts`. Until it exists, the in-app inbox is the client's only channel and the file
sink is the only way to sign a client in outside production.

## TD-05 — No TRON provider behind the chain verifier

**Observed.** Phase 4 confirms a USDT movement only through the `ChainVerifier` port (FI-24: solidified block, `SUCCESS` receipt, configured contract, expected destination, recorded amount, and — at or above the D-05 threshold — at least two providers). The only implementations are `UnconfiguredChainVerifier`, which throws on every lookup, and the in-memory `FakeChainVerifier` used by tests. Block scanning, cursors, reorg handling and automatic detection are Phase 5.

**Risk.** Until a provider is bound, no USDT first leg and no USDT payout can be confirmed in a deployed environment; INR settlement works. This is deliberate — an operator's word must never confirm an on-chain transfer — but it is a launch blocker for anything involving real USDT.

**Resolution (to do, Phase 5).** Implement `ChainVerifier` over two independent TRON providers (full node + an indexer), with the USDT contract and the dual-provider threshold from configuration, plus the scanner and its cursor. Keep the port boundary: the confirmation rules stay in `packages/settlement`, so Phase 5 changes where the facts come from, not what is required of them.

**Closed (Phase 5, 2026-09-18).** `packages/adapters` now carries `TronHttpProvider` (TronGrid-compatible) and `DualProviderChainVerifier`, which returns the providers that reported identical facts in `TransferReceipt.agreedBy` together with their distinct independence groups in `agreedGroups`; `packages/settlement` measures the D-05 quorum on the **groups**, so agreement is a property of the answer rather than of the configuration, and two adapters onto one operator can never form a quorum. `packages/scanner` adds the cursor, detection, confirmation and orphan jobs, wired into the worker by `chainMonitoringFromEnv`, whose state (DISABLED / READY / DEGRADED / UNCONFIGURED) the worker reports rather than no-opping silently. What remains is deployment configuration (the endpoints, keys and contract address are environment values, and the launch checklist still carries "TRON dual provider configured; scanner lag alert tested") plus TD-07 below.

## TD-06 — No tooling for a deliberate historical backfill

**Observed (narrowed at the Phase 5 review).** Ordinary recovery is no longer debt: a run reads a bounded window starting at the cursor minus the rescan overlap and advances the cursor only across what it processed, so a worker that was offline for any length of time walks the entire gap window by window (`packages/scanner/test/scanner.int.test.ts`, "catches up across a gap far wider than the overlap"). What is still missing is reaching **behind** the cursor on purpose: a historical import, or a watched address that was added after funds arrived at it. Today the only route is `crypto.submit_tx_for_verification`, one transaction at a time.

**Risk.** Operational only: nothing is lost (the chain keeps the history and `(network, tx_hash, log_index)` makes re-detection idempotent), but importing an old range is manual.

**Resolution (to do).** A `chain.backfill` system command taking an explicit block range and address set, running the same detection step, audited, and refusing ranges above the solidified head. The cursor stays monotonic; a backfill never rewinds it.

## TD-07 — The provider smoke gate has never been executed

**Observed.** `TronHttpProvider` is tested against recorded TronGrid-shaped JSON (`packages/adapters/test/tron.unit.test.ts`), and the scanner is tested end to end against `FakeTronProvider` over a fake chain. The Phase 5 review added the real gate — `scripts/tron-smoke.ts`, run by `pnpm smoke:tron` or the manual `tron-smoke` GitHub workflow — which checks connectivity, canonical parsing, identical facts across two providers, the finality line and the real `DualProviderChainVerifier` decision for one known transaction with expected sender, destination and amount.

**Status: NOT RUN.** The gate has never been executed against real providers. The development environment that built Phase 5 has no chain access and no provider credentials, and the workflow is deliberately outside CI (it needs secrets and a live network). Running it requires a person with testnet or mainnet endpoints from two different operators.

**Risk.** A provider whose payloads differ from the fixtures fails loudly (every field is parsed and validated — an unreadable answer raises rather than becoming a missing fact), so the failure mode is "the scanner stops", not "money is misread". Still, that failure would first appear in a deployed environment.

**Resolution (to do, before real USDT).** Configure the `tron-smoke` workflow's environment with two genuinely independent endpoints (the gate refuses two providers declaring the same independence group), a reference transaction and its expected facts, run it, and record the result here. **Phase 5 is not fully closed until this gate has passed against real configured providers.**

## TD-08 — Visual regression compares stories, not the pages an operator sees

**Observed.** The operator validation baselines (`validation-operator-desk--*`) were recorded in Phase 1.5 from Storybook stories: hand-built compositions of the design system that stand in for the desk, the clients list, rates, INR accounts, USDT treasury, P&L, quote creation, partial settlement and an exception trade. Phase 6 built the real pages, which assemble the same components from `packages/desk` read models. Nothing compares a screenshot of `/`, `/orders`, `/rates`, `/inr`, `/usdt` or `/clients` as rendered by the built app against a baseline. The end-to-end run asserts behaviour and figures, not layout, and a visual regression in a page — a panel overflowing, a column collapsing at 1440px, a number wrapping mid-figure — would pass every gate.

**Risk.** Presentation only: no financial or security semantics depend on it. The failure mode is a desk that looks wrong or becomes hard to read after an unrelated change, found by an operator rather than by CI.

**Resolution (to do).** Capture the operator pages from the end-to-end run's own seeded world, in the canonical Playwright environment, and compare them the way the component baselines are compared — same image, same platform, same fonts, metadata recorded in `ENVIRONMENT.json`, update only through the deliberate baseline workflow (`docs/VISUAL_BASELINES.md`). The seeded world is already deterministic except for time and identifiers, so the capture needs a frozen clock and stable references before the pixels are stable enough to compare. Keep the Storybook baselines: they cover states the seeded world does not reach.

**Closed (Phase 6 review, 2026-09-19).** `apps/web/visual` captures eleven states of the built product — desk
with strip and grouped queue, trade context panel, payout panel with the payer selector on a direct route,
blocking exception, Orders, Rates with route positions, INR, USDT with the deposit pool and scanner state,
Clients, the command bar and the step-up dialog. The fixture world freezes the business clock for the whole
database, so references and business timestamps are identical on every run and on any day; the few columns that
follow the wall clock by design are pinned, and the one remaining wall-clock string is rewritten before capture.
Every other pixel is compared. The canonical environment and its guard now live once in `@inrp2p/visual`, shared
with the component suite; CI job `visual-pages` is compare-only, and recording happens only through the manual
**Visual baselines (canonical update)** workflow (job `record-pages`). Recording those baselines for the first
time was TD-09, closed at the Phase 7 review.

The suite paid for itself before it had a baseline: it found three layout defects (the strip stretched down the
whole workspace, its wrapped second line separated by a hole, the queue sliding under an open panel) and two
glyphs rendered by a system font (`◗` in the sidebar, `⧗` on step-up actions), all fixed in the same change.

## TD-09 — The page baselines had never been recorded

**Observed (at the time).** `apps/web/visual` was complete: the fixture world, the determinism, the captures,
the compare-only CI job (`visual-pages`) and the recording job in the manual baseline workflow (`record-pages`).
`apps/web/visual/__screenshots__` held no PNG and no `ENVIRONMENT.json`, so the guard refused the comparison
with "No canonical baselines" and the `visual-pages` job failed.

The environment that built this could not record them: pulling
`mcr.microsoft.com/playwright:v1.56.1-noble` is refused by the organization's egress policy (`mcr.microsoft.com`,
`registry-1.docker.io` and `ghcr.io` all answer `connect_rejected` on CONNECT), and baselines recorded anywhere
else are not comparable — which is exactly what `docs/VISUAL_BASELINES.md §1` exists to prevent. The suite was
instead proved with the self-check path (§2): eleven captures, reproduced pixel-for-pixel against a freshly
re-seeded database.

**Risk.** CI was red on `visual-pages` until the baselines existed. That was the intended failure mode — the
alternative, a job that records what it finds, is how a wrong baseline becomes the reference — but it did mean
the pages were not yet protected from visual regression.

**The component baselines needed the same run.** That change added one story (`Operator/StepUpMark`, for the drawn
step-up marker), so `packages/ui`'s baseline count no longer matched its `ENVIRONMENT.json` and the `visual` job
failed too until it was re-recorded. One dispatch covered both: `record` and `record-pages` run together.

**First attempt (2026-09-19): `record` passed, `record-pages` failed before any capture.** The desk started and
reported ready, and the harness could not reach it: `did not become ready at http://localhost:3220/sign-in`. The
harness bound and browsed the *name* `localhost`, which a container resolves — to `::1`, to `127.0.0.1`, or to
both in an order that need not agree between the server's `listen` and the client's `connect`. Fixed in the
harness only: one literal IPv4 loopback address for the bind, the desk's own `DESK_HOST`, the origin its auth
trusts and the address each suite browses, plus a readiness check that now reports the last status or transport
error, the attempts, the elapsed time and the server's own output instead of one opaque line. No product, domain
or UI semantics changed, and no origin or host check was loosened — they were made to agree
(`apps/web/test/harness.unit.test.ts`).

**Second attempt (run `35434518680`): the desk started, all eleven screenshots were written, and the compare
step that follows found none of them.** The reporter built its expected set from `test.info().annotations` in
`onBegin`, which runs *before* any test — so the set was empty, every freshly recorded baseline was deleted as
stale, and metadata was written claiming zero baselines. The expected set is now a static manifest
(`apps/web/visual/captures.ts`, the eleven canonical names) shared by the suite and the reporter, an incomplete
set is refused instead of blessed, and `apps/web/test/visual-manifest.unit.test.ts` holds both halves: the
manifest and the suite agree in both directions, and a successful update keeps the eleven, drops only what the
manifest no longer names, counts eleven in `ENVIRONMENT.json` and leaves a set the next compare run accepts.

**Phase 7 widened the same run, and did not change its shape.** The page suite now covers **twenty** states, not
eleven: the nine new ones are the client product's own screens (Exchange with a firm quote counting down, a trade
awaiting the client's USDT, a trade paying out, a settled trade, History, Accounts, Notifications) and the public
quote link on a phone, before and at the code step. They are captured in the same canonical environment, from the
same fixture world, under a session the product itself issued. The self-check path proved all twenty reproduce
pixel-for-pixel against a freshly re-seeded database, which left one dispatch between the suite and a baseline.

**Closed (Phase 7 review, 2026-09-19).** Canonical baseline workflow run
[`35448728745`](https://github.com/Gatsby01k/INRP2PEXC/actions/runs/35448728745) passed both jobs — `record` for
the components and `record-pages` for the pages — and its reviewed baselines were merged into `main`.
`apps/web/visual/__screenshots__` now holds **20** PNGs and an `ENVIRONMENT.json` recorded in the canonical
environment (`mcr.microsoft.com/playwright:v1.56.1-noble`, linux/x64, Playwright 1.56.1, Chromium
141.0.7390.37, `gitSha b07a738`, `baselines: 20`), and `packages/ui/visual/__screenshots__` was re-recorded in
the same dispatch.

Ordinary CI on the resulting `main` (`66cc214`), run
[`35449053191`](https://github.com/Gatsby01k/INRP2PEXC/actions/runs/35449053191), is green on every job,
including compare-only `visual` and `visual-pages`. Nothing in the code changed to close this: the third
dispatch recorded what the second one had already proved reproducible.

Both products' pages are now protected from visual regression by the same gate as the components. This item
stays closed; the next change that alters what a page looks like goes through the same one-run update path
(`docs/VISUAL_BASELINES.md §5`).

## TD-10 — The desk's own signals and the receipt trigger are acknowledged, not consumed

**Observed.** The outbox dispatcher refuses to mark an event dispatched when no handler claims it — "an event
nobody handles is a wiring bug" — which is how this was found: `desk.new_request`, `desk.request_needs_action`,
`desk.quote_rejected`, `desk.acceptance_failed`, `desk.exception_opened`, `desk.leg_failed`,
`desk.payout_actionable`, `desk.adjustment_requested`, `desk.route_settlement_failed`,
`capacity.over_committed` and `receipt.generate` had no handler at all, so every one of them retried ten times
and failed for good. Nothing was lost — the desk's queue, the INR screen and the exception list are all derived
from the rows themselves, and receipts have not been built — but a permanently failing outbox is a bad place to
look for a real problem.

`packages/notifications/src/signals.ts` now names each type with what it is waiting for, and acknowledges exactly
those. A type that is **not** on the list still fails loudly, which is the behaviour worth keeping.

**Risk.** None to money or to the desk's work today; the signals carry no information the screens do not already
read from the rows. The debt is that two real features are named but not built.

**Resolution (to do).** A desk push channel (the `desk.*` signals and `capacity.over_committed` become something
an operator is actually told, rather than something they find by looking) and Phase 8's receipts
(`receipt.generate`). Each one removes its types from the acknowledged list as it starts consuming them.

**Half closed in Phase 8 (2026-09-20).** `receipt.generate` now has a real handler: `receiptHandler` from
`@inrp2p/reporting` takes the snapshot, issues the receipt and records its hashes, and the worker runs it. It has
left `ACKNOWLEDGED_SIGNALS`, so a failure to issue a receipt is now a failing outbox delivery that retries —
which is what it should always have been. The `desk.*` signals and `capacity.over_committed` are still
acknowledged and still waiting for a push channel; this item stays open for them.

## TD-11 — Client TOTP enrolment is not built, so sensitive client-admin actions cannot be performed by a client

**Observed.** SECURITY §2.2 specifies optional TOTP per client user, **required** for a `CLIENT_ADMIN` adding or
archiving a bank account or wallet (D-08) and for granting or revoking `can_accept_quotes`. The domain enforces
it: `authorizeClientAdmin` raises `MFA_ENROLLMENT_REQUIRED` without an enrolled authenticator and
`STEP_UP_REQUIRED` without a fresh verification. What does not exist is the enrolment: `clientAuthOptions`
carries the email-OTP plugin and no `twoFactor` plugin, so a client user has no way to enrol an authenticator and
no endpoint to verify one against. There is therefore no code a client could type that would satisfy the rule.

**Consequence, and what Phase 7 did about it.** The client Accounts screen shows destinations and says plainly
that changes are made with the desk; there are no add/archive controls and **no client server actions** for them.
An action that every call would refuse is not a smaller gap than no action — it is the same gap with an attack
surface. Destinations are managed today by operators through `client_bank:add` and `client_wallet:manage` (both
⧗), which is what every fixture and every test already does, and which D-08 allows.

**Risk.** Product completeness only. No rule is weakened: the commands still refuse, and the desk path is fully
audited. What a client cannot do is act on their own destinations without the desk.

**Resolution (to do).** Add the `twoFactor` plugin to the client Better Auth configuration with its own issuer
and enrolment flow (an Account screen: enrol, verify, recovery), keep `skipVerificationOnEnable: false`, decide
deliberately whether client users may use trusted devices (operators may not), then bring back the client
destination actions and the `can_accept_quotes` grant behind the existing step-up dialog. The RBAC and command
side needs no change — it has been waiting for this since Phase 2.

## TD-12 — Receipts are proved by hash, not stored

**Observed.** The `receipt` table holds the canonical snapshot and the sha256 of every artifact rendered from
it — JSON, CSV, HTML — but not the artifacts themselves. `json_key`, `csv_key` and `pdf_key` exist and are
null, because V1 has no object store to put a key in. Serving a receipt regenerates it from the snapshot and
checks the result against the recorded hash; a mismatch is refused rather than served.

Separately, PDF rendering is a port with one implementation (`ChromiumPdfRenderer`) that is **off unless
`INRP2P_PDF_RENDERER=chromium` names it**, because printing needs a browser binary that a deployment has to
install and supervise. Without it the route answers 503 and names the three formats that do work.

**Risk.** Low, and deliberately shaped that way. The snapshot is immutable, the renderers are pure, and the hash
is what proves the document — so "regenerate and verify" is a stronger guarantee than "fetch what we stored",
not a weaker one. What is missing is the ability to hand someone a URL that does not re-render, and the ability
to print a PDF in a deployment that has no browser.

**Resolution (to do).** When object storage exists: write each artifact once at issue time, record its key in the
column already reserved for it, serve from storage, and keep the regenerate-and-compare path as the check that
what was stored is still what was issued. Bind a PDF renderer in the deployments that need one (a browser in the
worker image, or a rendering service behind the same port), and keep the unconfigured renderer as the default so
an environment without one refuses loudly.

## TD-13 — The Phase 8 page baselines have not been recorded

**Observed (Phase 8).** Phase 8 added two captures to the page manifest — `operator-pnl` and
`operator-statement` — and changed one page that already had a baseline: the INR screen now carries the
statement reconciliation panel.

**Closed for Phase 8 (2026-09-20).** The canonical update workflow
[`35495412975`](https://github.com/Gatsby01k/INRP2PEXC/actions/runs/35495412975) recorded the pages at
`36700c4`, and its reviewed baselines are merged: `apps/web/visual/__screenshots__` holds **22** PNGs and an
`ENVIRONMENT.json` recorded in the canonical environment (`mcr.microsoft.com/playwright:v1.56.1-noble`,
linux/x64, Playwright 1.56.1, Chromium 141.0.7390.37).

**Reopened for Phase 9 (2026-09-20).** Phase 9 adds two more captures for the public site,
`public-home-mobile` and `public-usdt-to-inr-mobile`, so the manifest now expects 24 and the committed set
holds 22. Compare-only CI reports two missing baselines until the same one-run update path is taken again. The
self-check reproduces all 24 in the development environment, which is what it is for, but it is not a baseline
(`docs/VISUAL_BASELINES.md §5`).

A related defect was fixed rather than recorded: `istToday` in `@inrp2p/inr-accounts` read `statement_timestamp()`
while the rest of the system read `inrp2p_now()`, so the INR screen printed the *wall-clock* IST day. In a
deployed database the two are identical, but in the pinned-clock fixture the page printed whatever day the
baseline happened to be recorded on — which would have made `operator-inr` fail every day after it was recorded.
Both now read the business clock.

**Risk.** CI's `visual-pages` job cannot pass until the baselines are recorded. No product risk.

**Resolution (to do, at Phase 8 review).** Dispatch the canonical update workflow, review the recorded images,
merge them, and confirm ordinary CI is green on the resulting `main` — the same one-run path that closed TD-09.

## TD-14 — Reconciliation has no recurring job

**Observed.** The plan line for Phase 8 reads "reconciliation job + manual bank statement import". The manual
import exists and is the control that matters (SECURITY §5 S7); the ledger-side reconciliation query
(`routeObligationMismatches`, FI-64) exists and is asserted by the properties suite. What does not exist is
anything that runs on a timer.

**Why it was not built.** A recurring job needs something new to read. With no bank API, the only input is a
file a person uploads, and a scheduler re-reading the files already imported would report the same answer on a
timer — activity, not information. The import is already idempotent (unique on the file's hash per account; a
case that is open is found rather than opened again), so it is ready to be driven by a job the moment there is a
feed to drive it.

**Risk.** Reconciliation happens when an operator does it, not on a schedule. A fake UTR is therefore caught at
the next import rather than within a fixed window. The audit trail records exactly when each import happened, so
the gap is visible rather than assumed.

**Resolution (to do).** Either a bank feed (an adapter that fetches statements on a schedule and hands them to
the same command) or a watched drop location, plus a Graphile Worker cron entry that runs the ledger-side
reconciliation and opens a case for anything `routeObligationMismatches` returns rather than leaving it to a
test.

## TD-15 — The public site cannot be edge-cached while its nonce is per-request

**Observed.** Every public page is `force-dynamic`, because it reads the request's CSP nonce to put on the one
inline script it serves (its structured data). A nonce is only a control if it is unpredictable and used once,
so a cached page carries a nonce that no longer matches the `Content-Security-Policy` header the viewer
received — and the browser correctly refuses the script.

**Risk.** Cost and latency, not correctness. Six small server-rendered pages are cheap, and the pages measure in
the mid-nineties on Lighthouse's throttled mobile profile as they are. It becomes a real constraint the day the
site is expected to absorb a campaign's worth of traffic from one region.

**Resolution (to do).** Serve the public pages with a **hash-based** policy instead: the structured data for a
given page is deterministic, so its sha256 can be computed at build time and named in `script-src`, leaving the
page cacheable and the nonce for the surfaces that actually need one. The desk and the client app keep the
per-request nonce — they are never cached and their scripts are not static.

## TD-16 — The backup and restore drill has never been executed

**Observed.** `scripts/backup-drill.ts` dumps, restores into a fresh database and verifies the restore — the
same migration, a ledger that nets to zero, an audit chain that recomputes, completed trades that are still
fully settled, and matching counts. The checks it runs are separated into `scripts/restore-checks.ts` and are
tested against databases corrupted in each of those ways.

What has not happened is the drill itself, against real infrastructure. It could not be run in the development
environment: the container's `pg_dump` is version 16 against a server at 18, which `pg_dump` refuses outright,
and the embedded PostgreSQL distribution here ships `initdb`, `pg_ctl` and `postgres` and no client tools. The
script takes `PG_BIN` for exactly this reason.

**Risk.** The one that matters. Every property of a backup — that it is taken, that it completes, that it can be
restored, that the restore is usable, how long it takes — is unverified until a drill runs. A backup nobody has
restored is a hope.

**Resolution (to do, before launch).** Run it against staging with client tools of the server's major version,
record the wall-clock time and the dump size, and repeat it on a schedule and after any change to the database's
shape or hosting (`docs/RUNBOOKS.md § backup-restore-drill`). Point-in-time recovery needs its own drill beyond
this one: this proves a dump restores, not that the WAL archive can roll forward to a chosen moment.

## TD-17 — Audit seals are written but never exported

**Observed.** The audit trail is sealed hourly into a hash chain and `verifyAuditSeals` recomputes the whole
chain on demand (SECURITY §8); the health check `audit_seal_age_seconds` alarms when sealing stops. What SECURITY
§8 also requires — "seal hashes exported daily to an external write-once location" — does not exist. Every copy
of the chain currently lives in the same database as the events it attests.

**Risk.** The chain detects tampering, but an attacker with enough access to edit audit rows can re-seal them.
The export is what makes that impossible to hide: a hash written somewhere the database cannot reach is the
difference between "we would notice" and "we can prove".

**Resolution (to do, before launch).** A daily job that appends the latest seal hashes to write-once external
storage (object lock, or an append-only log service), plus a verification step that compares the exported chain
against the database's own and alarms on divergence. The data is tiny — a few hashes a day — so the work is
entirely in the destination and its credentials, not in the producing.
