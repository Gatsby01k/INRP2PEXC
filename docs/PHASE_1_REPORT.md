# INRP2P Exchange — Phase 1 Report (Foundation)

Status: implementation complete, awaiting founder review. Phase 1.5 not started.
Scope: `IMPLEMENTATION_PLAN.md` Phase 1 only. No UI pages, quoting, settlement, TRON, notifications delivery or public site.

## 1. What exists

```
apps/web        Next.js 16 skeleton: proxy gate, Better Auth route (host → operator/client), /api/operator/me, /api/client/me
apps/worker     Graphile Worker runner: outbox_dispatch, audit_seal (cron)
packages/kernel     Money, Rate<kind>, currency precision, exact conversion + rounding, trade economics, uuidv7, typed errors
packages/db         SQL migrations 0001–0007, runner (checksummed, advisory-locked), pools (bigint int8), Kysely types, transactions, DB clock, lock order
packages/audit      append-only writer, redaction, hash-chain sealing + verification
packages/ledger     chart of accounts, balanced posting, reversal, balances, trade accept/complete/cancel posting rules
packages/commands   command pipeline with idempotency
packages/outbox     transactional outbox enqueue, dispatcher, queue install + privileges
packages/identity   Better Auth (operator + client), RBAC matrix, authorization, step-up, session guards, role assignment command
scripts             migrate, version check, secret scan
test/global-setup   PostgreSQL (Testcontainers postgres:18.6 or TEST_DATABASE_URL), template DB with migrations + queue
test/integration    cross-package integration tests (audit, ledger, outbox, pipeline) — keeps the workspace graph acyclic
```

## 2. Migrations

| # | File | Contents |
|---|---|---|
| 0001 | foundation | roles `inrp2p_app`, `inrp2p_worker` (member of app), `inrp2p_readonly`; public-schema lockdown; `currency` (INR 2, USDT 6, immutable); `inrp2p_reject_mutation()` |
| 0002 | idempotency | `idempotency_key` (PENDING→COMPLETED only, identity immutable, no delete) |
| 0003 | audit | `audit_event` (append-only, statement-level UPDATE/DELETE/TRUNCATE rejection), `inrp2p_audit_range_hash()`, `audit_seal` (contiguous, chained, append-only) |
| 0004 | ledger | `ledger_account` (per currency, append-only), `ledger_journal` (unique posting key, single reversal, created_txid), `ledger_entry` (positive bigint, account-currency FK, trade + route-obligation dimensions); same-transaction entry trigger; deferred balance/≥2 entries/exact-mirror constraint trigger; balance and global-imbalance views |
| 0005 | outbox | `outbox_event` (content immutable, dispatch-only updates), `outbox_delivery` (append-only per event×handler) |
| 0006 | auth_better_auth | Better Auth 1.7.5 core + twoFactor + emailOTP + rate-limit tables, snake_case; session surface must match user kind |
| 0007 | identity_rbac | `operator_role`, `operator_user_role`, `operator_permission_grant` (operator users only), `step_up_verification`, `session_activity` |
| — | outbox `sql/queue_privileges.sql` (via `installQueue`) | graphile-worker schema owned by `inrp2p_worker`; app gets only `inrp2p_enqueue_outbox_dispatch()` |

## 3. Deviations from Phase 0 and implementation notes

None of these change approved product or financial semantics.

1. **Local PostgreSQL version.** Verified on 18.4 locally (container registries blocked); CI pins and asserts 18.6. See `DEPENDENCIES.md`.
2. **Graphile Worker schema** is installed by graphile-worker's own migrator (not a numbered SQL file), followed by an explicit, idempotent privileges script. Its private tables use row-level security, so the queue schema is owned by `inrp2p_worker`; the migrator must be a member of that role.
3. **`auth_verification.id` is `text`.** Better Auth writes deterministic reservation ids for single-use codes. All other auth ids are UUIDv7.
4. **Better Auth ids** are generated as UUIDv7 in application code (`kernel.uuidv7`) because some plugin paths ignore database-generated ids.
5. **Ledger posting rules for trade accept/complete/cancel** are implemented as pure journal builders plus the generic reversal primitive, so the required cancellation tests run now; the trade commands that call them are Phase 3/4.
6. **D-07 compliance hooks** in Phase 1 are the append-only, sealed audit and redaction. Client-level hooks (`kyc_status`, screening fields) arrive with the `client` table in Phase 2.
7. **Quote-bound acceptance challenges** remain an INRP2P domain primitive (Phase 3). Better Auth email OTP is used only for client login; nothing in Phase 1 routes quote acceptance through Better Auth.
8. **`lockInOrder` helper** validates `ARCHITECTURE §4` lock order; tables for most resources arrive in later phases.

## 4. Better Auth vs SECURITY §2 — verified and gaps

| Requirement | Result |
|---|---|
| Operator credential login + mandatory TOTP | Better Auth `emailAndPassword` (no sign-up) + `twoFactor`; INRP2P guard refuses sessions until TOTP enrolled **and** verified in that session |
| No trusted-device bypass for operators | Blocked by before-hook (403); guard also requires a recorded TOTP verification per session |
| Client email-OTP login, no sign-up, hashed codes | Better Auth `emailOTP` (`disableSignUp`, `storeOTP: 'hashed'`, 5 attempts, 10 min) |
| Separate operator/client cookies and secrets | distinct `cookiePrefix`, secrets and Better Auth instances; DB trigger forbids session surface ≠ user kind |
| Secure, HttpOnly, SameSite Strict (desk) / Lax (app), host-only | verified from `Set-Cookie` in tests (`__Secure-` prefix; no `Domain`) |
| Absolute lifetime 12 h / 7 d | Better Auth `expiresIn` with `disableSessionRefresh` |
| Idle timeout 30 / 60 min | **Not native in Better Auth** → closed by INRP2P guard (`session_activity`), revokes on timeout |
| Step-up within 10 min | **Not native** → after-hook records every successful TOTP verification; `authorizeOperator` checks freshness in DB time |
| Server-side revocation | session rows deleted on idle timeout / disable; Better Auth sign-out |
| Rate limiting | Better Auth database rate limiter with stricter rules for sign-in, TOTP verify and OTP endpoints |
| TOTP brute force inside an existing session | **Gap:** Better Auth counts failed TOTP attempts only during sign-in; in-session step-up relies on the IP rate limit (5 / 5 min). Recommend per-user step-up attempt limiting in Phase 6 when step-up dialogs ship |
| Breached-password check | **Gap:** Better Auth's HIBP plugin calls an external API; not enabled pending a decision on that egress |
| Client IP for rate limits | **Deployment note:** configure trusted proxy headers (`advanced.ipAddress`) for the production edge |
| Auth failure audit | sign-in/TOTP/OTP failures audited as `session.failed` (code only, no credentials) |

## 5. Exit matrix

| Phase 1 exit criterion (`IMPLEMENTATION_PLAN.md`) | Evidence | Result |
|---|---|---|
| Canonical money: 100k @ 102.00 / 104.20 → ₹10,200,000 / ₹220,000 | `packages/kernel/test/economics.unit.test.ts` | ✅ |
| Reverse direction | BUY base-fixed and INR-fixed, SELL INR-fixed, negative-margin sign | ✅ |
| Rounding table | `divRound` table + per-direction rounding-by-payer table (independently computed) | ✅ |
| Unbalanced journal rejected | app-level `UNBALANCED_JOURNAL`; DB-level IX012 at commit with app bypassed; <2 entries IX011; late entries IX010; currency mismatch | ✅ |
| Ledger/audit UPDATE/DELETE rejected at DB | owner → IX001 (incl. TRUNCATE, empty tables); app role → 42501; audit seal tamper detection | ✅ |
| Idempotent replay | same key replays stored result once; different payload rejected; 6 concurrent duplicates post once; failure releases key | ✅ |
| RBAC tests for every matrix cell | matrix parsed from SECURITY.md == code; 49 permissions × 6 roles through `authorizeOperator` with fresh/stale step-up and second-approver checks | ✅ |
| MFA enforced for every operator route | guard tests + built Next.js app: all desk paths 401 → 403 `MFA_ENROLLMENT_REQUIRED` → 200 only after TOTP | ✅ |
| Operator and client sessions isolated by host/cookie | cross-cookie, forged cookie-name, OTP login for operator email, DB surface trigger | ✅ |
| Cancellation reversal leaves nothing orphaned (added requirement) | SELL/BUY/negative/zero margin: all trade and route-obligation balances zero; single reversal; no reversal of reversal; partial reversal rejected by DB (IX014) | ✅ |
| CI: typecheck, lint, unit, integration with Testcontainers, secret scan | `.github/workflows/ci.yml`; all steps green locally (integration on PG 18.4, see §3.1) | ✅ locally · ⏳ first GitHub run |

## 5a. CI fix (after first GitHub run of `e57e0c2`)

- `ERR_PNPM_IGNORED_BUILDS`: explicit `allowBuilds` policy, see `DEPENDENCIES.md` "Build scripts".
- Workspace cycle `audit ⇄ commands` (and latent `ledger ⇄ commands`, `outbox ⇄ commands` via devDependencies): composition tests moved to `test/integration/`; `identity` no longer lists `commands` as a runtime dependency; `pnpm run workspace:graph` added to CI.

## 6. Test results (local, Node 24.21.0, PostgreSQL 18.4)

| Suite | Files | Tests |
|---|---|---|
| Unit | 6 | 113 passed |
| Integration | 9 | 362 passed |
| Lint / typecheck / secret scan / version check / `next build` | — | clean |
