# INRP2P Exchange — Technical Debt Register

Non-blocking items accepted at phase review. Each entry names the phase that must close it. Items here never change financial or security semantics until they are fixed; the fix itself goes through normal review.

| ID | Area | Recorded | Must close before | Status |
|---|---|---|---|---|
| TD-01 | Auth schema: `auth_rate_limit.last_request` type warning | Phase 1 acceptance (2026-09-17) | Production deploy (launch checklist) | Open |
| TD-02 | Auth: cross-surface operator → client OTP rejection surfaces as internal error | Phase 1 acceptance (2026-09-17) | Production client auth (client login enabled on `app.inrp2p.com`) | Open |
| TD-03 | Encryption: production KMS-backed key-encryption key not implemented | Phase 2 implementation (2026-09-17) | First deployment holding real bank or contact data | Open |
| TD-04 | Notifications: no email provider bound for acceptance codes | Phase 3 implementation (2026-09-17) | Any environment where a client accepts a quote through a shareable link | Open |
| TD-05 | Chain verification: no TRON provider bound; scanning not implemented | Phase 4 implementation (2026-09-18) | Any environment that settles real USDT | Closed in Phase 5 (2026-09-18) |
| TD-06 | Scanner: no tooling for a deliberate historical backfill behind the cursor | Phase 5 implementation (2026-09-18) | First production incident needing a historical rescan | Open (narrowed at Phase 5 review) |
| TD-07 | Scanner: the TRON provider smoke gate has never been executed against real providers | Phase 5 implementation (2026-09-18) | Any environment that settles real USDT | Open — gate exists, **NOT RUN** |
| TD-08 | Visual regression covers the Storybook validation stories, not the built operator pages | Phase 6 implementation (2026-09-19) | Production deploy (launch checklist) | Open |

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
