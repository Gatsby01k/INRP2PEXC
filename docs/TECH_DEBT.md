# INRP2P Exchange — Technical Debt Register

Non-blocking items accepted at phase review. Each entry names the phase that must close it. Items here never change financial or security semantics until they are fixed; the fix itself goes through normal review.

| ID | Area | Recorded | Must close before | Status |
|---|---|---|---|---|
| TD-01 | Auth schema: `auth_rate_limit.last_request` type warning | Phase 1 acceptance (2026-09-17) | Production deploy (launch checklist) | Open |
| TD-02 | Auth: cross-surface operator → client OTP rejection surfaces as internal error | Phase 1 acceptance (2026-09-17) | Production client auth (client login enabled on `app.inrp2p.com`) | Open |
| TD-03 | Encryption: production KMS-backed key-encryption key not implemented | Phase 2 implementation (2026-09-17) | First deployment holding real bank or contact data | Open |
| TD-04 | Notifications: no email provider bound for acceptance codes | Phase 3 implementation (2026-09-17) | Any environment where a client accepts a quote through a shareable link | Open |

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
