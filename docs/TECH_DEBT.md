# INRP2P Exchange — Technical Debt Register

Non-blocking items accepted at phase review. Each entry names the phase that must close it. Items here never change financial or security semantics until they are fixed; the fix itself goes through normal review.

| ID | Area | Recorded | Must close before | Status |
|---|---|---|---|---|
| TD-01 | Auth schema: `auth_rate_limit.last_request` type warning | Phase 1 acceptance (2026-09-17) | Production deploy (launch checklist) | Open |
| TD-02 | Auth: cross-surface operator → client OTP rejection surfaces as internal error | Phase 1 acceptance (2026-09-17) | Production client auth (client login enabled on `app.inrp2p.com`) | Open |

## TD-01 — Better Auth schema warning for `auth_rate_limit.last_request`

**Observed.** Better Auth 1.7.5 declares `rateLimit.lastRequest` as `number`; migration 0006 stores `auth_rate_limit.last_request` as PostgreSQL `bigint` (epoch milliseconds do not fit `integer`). Better Auth's schema comparison logs a type-mismatch warning. The migration planner integration test still reports nothing to create or add, and the Phase 1 auth integration tests pass.

**Risk.** Log noise that can hide a real schema drift warning; node-postgres returns `bigint` as a string by default, so the library relies on implicit coercion for this field.

**Resolution (to do).** Keep `bigint` in the database (the value is epoch ms). Either register a Kysely/pg type parser for this column so the adapter returns a number, or map the field via Better Auth's schema `fieldName`/type options, then assert in the Better Auth schema integration test that the planner emits **no warnings** for `auth_rate_limit`. No change to rate-limit windows, limits or keys.

## TD-02 — Cross-surface operator → client OTP rejection causes an internal Better Auth null-session error

**Observed.** An operator identity attempting client email-OTP sign-in is correctly denied: no client session is created and the request fails. The denial is implemented in `packages/identity/src/auth/config.ts` `sessionCreateGuard` (`databaseHooks.session.create.before` returns `false` when `auth_user.kind` ≠ surface). Better Auth then proceeds with a null session and fails internally instead of returning an expected client error. The current test (`packages/identity/test/auth.int.test.ts` "an operator email cannot sign in through client OTP") only asserts status ≥ 400 and that no client session exists.

**Invariant that already holds and must be kept.** No session is ever created for a cross-surface attempt (application guard + database trigger `IX020` rejecting a session whose surface does not match the user kind); operator and client surfaces stay isolated (`SECURITY.md`, `ARCHITECTURE.md §7`).

**Resolution (to do, before production client auth).** Keep the session guard and the `IX020` trigger as defence in depth, and add a surface check before session creation (a `before` hook on `/sign-in/email-otp` and `/email-otp/send-verification-otp` resolving the user kind) that returns a controlled 4xx (`403` with a generic, non-enumerating error body — same response shape as an invalid code) without creating a session. Tests to add: operator email → client OTP verify returns the controlled 4xx; no `auth_session` row is inserted; no `Set-Cookie`; a `session.failed` audit event recorded once; response body and timing do not reveal that the address belongs to an operator.
