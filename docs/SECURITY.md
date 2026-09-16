# INRP2P Exchange — Security

Status: Phase 0 draft, for review.

## 1. Threat model (V1 priorities)

| # | Threat | Impact | Primary controls |
|---|---|---|---|
| S1 | Operator account takeover | Wrong payouts, margin/route leak, fake confirmations | Mandatory TOTP MFA, step-up for money actions, separate desk host, session revocation, anomaly alerts, two-person rules |
| S2 | Leaked quote link | Unwanted commitment by a third party | Unguessable token, short expiry, funds only to pre-saved client destinations, acceptance verification (D-01), rate limit |
| S3 | Double submission / retries | Double trade, double payout | Idempotency keys, unique constraints, state-guarded commands |
| S4 | Insider manipulation of history | Hidden margin/theft | Append-only ledger + audit, sealed audit hash chain, adjustments two-person, no direct DB access for app users |
| S5 | Client-side data exposure of internals | Route rate / provider / margin leak | Separate client projection types, serializer allow-lists, tests asserting forbidden keys absent |
| S6 | Fake blockchain evidence | Payout against unpaid trade | Only scanner/adapter facts confirm USDT; operator tx-hash submission triggers verification, never confirms by itself; dual provider above threshold |
| S7 | Fake UTR | Trade marked paid when not | UTR uniqueness, proof attachment, step-up, reconciliation against bank statements (manual import V1) |
| S8 | Destination swap | Payout to attacker account | Destinations immutable per quote/trade; changes = archive + new, step-up, `CLIENT_BANK_CHANGED` exception, notify all client admins |
| S9 | Sensitive data in logs/backups | Bank data leak | Envelope encryption, redaction, restricted reveal permission |
| S10 | Abuse of public endpoints | Enumeration, credential stuffing | Rate limits, uniform errors, CAPTCHA-less throttling with backoff |

## 2. Authentication

### Operators (`desk.inrp2p.com`)
- Email + password (Argon2id, memory-hard params, breached-password check) **and** TOTP MFA — required for **every** operator role, including READ_ONLY (read access includes margins and client data).
- WebAuthn/passkeys planned as a second factor option; design session model to allow it.
- Session: opaque 256-bit token in `__Host-` cookie (`Secure`, `HttpOnly`, `SameSite=Strict`), DB-stored hash, idle timeout 30 min, absolute 12 h, re-auth on IP/UA class change.
- **Step-up**: MFA code within the last 10 minutes required for: confirming incoming INR, confirming payouts, changing UTR, cancelling trades, approving adjustments, changing capacity, changing roles, revealing full bank details, sending negative-margin quotes.
- Optional IP allowlist for the desk host.

### Clients (`app.inrp2p.com`)
- Passwordless email OTP (6 digits, 10 min, single use, attempt-limited) as V1 default; optional TOTP per client user; mandatory TOTP for `CLIENT_ADMIN` changing bank accounts/wallets (see D-08).
- Session: `__Host-` cookie, `SameSite=Lax`, idle 60 min, absolute 7 days.

### Quote link (`/q/{token}`)
- Token: 128 bits CSPRNG, base62, only SHA-256 hash stored; constant-time lookup by hash.
- Viewing: token alone. Page shows client projection only; `Referrer-Policy: no-referrer`; `noindex`; no third-party scripts.
- Accepting: see `DECISIONS.md D-01` (recommended: token + one-time code sent to the client's registered contact, or an existing client session).
- Token dies with quote terminal state; revocable by dealer; open count and first-open audited.
- Why not a signed JWT-style link: an opaque DB token is revocable, carries no data, and cannot outlive a cancelled quote.

## 3. RBAC permission matrix

Legend: ✔ allowed · ⧗ allowed with step-up MFA · ✱ requires second approver (different user) · — denied.

| Permission | OWNER | DEALER | SETTLEMENT_OP | FINANCE | SUPPORT | READ_ONLY |
|---|---|---|---|---|---|---|
| `desk:view` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `economics:view` (route rate, margin) | ✔ | ✔ | — | ✔ | — | — (grantable) |
| `rates:update_route` | ✔ | ✔ | — | — | — | — |
| `request:create` / `request:decline` | ✔ | ✔ | — | — | create only | — |
| `quote:create` / `quote:send` / `quote:cancel` | ✔ | ✔ | — | — | — | — |
| `quote:send_negative_margin` | ⧗ | — | — | — | — | — |
| `quote_link:create` / `revoke` | ✔ | ✔ | — | — | — | — |
| `settlement:reserve_capacity` | ✔ | — | ✔ | — | — | — |
| `settlement:create_payout` / `send_payout` | ✔ | — | ✔ | — | — | — |
| `settlement:record_utr` | ✔ | — | ✔ | — | — | — |
| `settlement:change_utr` | ⧗ | — | ⧗ | — | — | — |
| `settlement:confirm_payout` / `confirm_incoming` | ⧗ | — | ⧗ | — | — | — |
| `settlement:fail_payout` / `cancel_payout` | ⧗ | — | ⧗ | — | — | — |
| `crypto:submit_tx_for_verification` | ✔ | — | ✔ | ✔ | — | — |
| `trade:cancel` | ⧗ | ⧗ | — | — | — | — |
| `exception:open` | ✔ | ✔ | ✔ | ✔ | ✔ | — |
| `exception:resolve` (non-financial) | ✔ | ✔ | ✔ | ✔ | — | — |
| `adjustment:request` | ✔ | ✔ | ✔ | ✔ | — | — |
| `adjustment:approve` | ⧗✱ | — | — | ⧗✱ | — | — |
| `refund:approve` | ⧗✱ | — | — | ⧗✱ | — | — |
| `inr_account:manage` / `capacity:change` | ⧗ | — | — | ⧗ | — | — |
| `treasury:manage_wallets` | ⧗ | — | — | ⧗ | — | — |
| `client:manage` / contacts | ✔ | ✔ | — | — | ✔ | — |
| `client_bank:add` (operator on behalf) | ⧗ | — | — | — | ⧗ | — |
| `bank_account:reveal` | ⧗ | — | ⧗ | ⧗ | — | — |
| `ledger:view` / `pnl:view` / `export` | ✔ | pnl only | — | ✔ | — | — |
| `receipt:view` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `audit:view` | ✔ | — | — | ✔ | — | — |
| `users:manage` / `roles:assign` | ⧗ | — | — | — | — | — |

Rules:
- Authorization is checked inside the command (server), never inferred from the UI.
- Query-level redaction: users without `economics:view` receive DTOs where route rate / margin fields do not exist (not nulled — absent).
- OWNER role assignment requires another OWNER's approval (✱) once more than one OWNER exists.
- `created_by ≠ approved_by` enforced by DB CHECK on `financial_adjustment`.

## 4. Separation of duties (V1 defaults)

| Action | Rule |
|---|---|
| Financial adjustment | requester ≠ approver |
| Refund of confirmed client funds | requester ≠ approver |
| Payout confirmation | configurable: above threshold (default ₹2,500,000 per leg) the user who marked a leg sent cannot confirm it |
| Capacity increase | audited; above threshold requires approver |

A single-person desk can run V1 by disabling thresholds explicitly in Settings (audited action, OWNER only).

## 5. Data protection

- Encryption at rest: managed Postgres storage encryption + application envelope encryption for account numbers, TOTP secrets, client contact phone numbers.
- Keyed HMAC (separate key) for bank account dedup and UTR lookup.
- Masking helpers are the only way to render account numbers (`•••• 8219`) and UTRs (`••••7118`); raw values never enter logs, audit `before/after`, notifications or receipts beyond last 4 (receipts show full UTR — see D-09).
- Attachments in private object storage, served via short-lived signed URLs after permission check; SHA-256 recorded.
- Backups encrypted; restore drills in launch checklist.
- No wallet private keys or seed phrases anywhere in V1 — enforced by review checklist and a secret scanner in CI (pattern for hex-64 / mnemonic words in code and fixtures).

## 6. Database hardening

- Roles: `app_rw` (DML limited per table: INSERT-only on `ledger_*`, `audit_event`, `trade_economics`, `rate_snapshot`, `*_transition`; no DELETE anywhere on financial tables), `worker` (same as app plus job schema), `migrator` (DDL, CI only), `readonly_reporting`.
- Triggers reject UPDATE/DELETE on append-only tables even for `app_rw`.
- Status columns updated only via `SECURITY DEFINER` transition functions that validate the whitelist (defense in depth behind the TS state machine).
- No human production DB write access; break-glass procedure: OWNER + FINANCE, time-boxed credentials, full session logging.

## 7. Web / API

- CSRF: `SameSite` cookies + Origin/Host verification on every mutation + per-form token.
- CSP: strict (`default-src 'self'`, nonces for scripts, no inline eval), `frame-ancestors 'none'`, HSTS preload.
- Rate limits (Postgres/edge token bucket): login 5/15min per account+IP, OTP verify 5 attempts per code, quote link open 30/min per IP, quote accept 5/min per token, financial mutations 60/min per user.
- Idempotency-Key header required on all financial mutation endpoints; UI generates a key per intent (not per click).
- Uniform error messages on auth and link lookup (no token/email enumeration).
- Dependency scanning, lockfile pinning, SBOM in CI.

## 8. Audit coverage (must emit)

`rate.changed` · `quote.created/sent/accepted/rejected/expired/cancelled` · `quote_link.created/opened/revoked` · `capacity.reserved/consumed/released/changed` · `settlement_account.selected` · `usdt.detected/confirmed/failed` · `utr.entered/changed` · `leg.*` · `trade.*` transitions · `adjustment.requested/approved/rejected` · `exception.opened/resolved/voided` · `client_bank.added/archived` · `client_wallet.added/archived` · `user.role_granted/revoked` · `user.mfa_enrolled/reset` · `session.login/logout/step_up/failed` · `bank_account.revealed` · `settings.threshold_changed` · `export.generated`.

Stored: actor, time, action, entity, redacted before/after, correlation id, idempotency key, session id, hashed IP. Sealed hourly into `audit_seal` hash chain; seal hashes exported daily to an external write-once location.

## 9. Compliance boundary (not legal advice — requires counsel before launch)

INRP2P Exchange operates in a regulated area. Before production launch, counsel must confirm at minimum: registration obligations for virtual-digital-asset service providers in India (FIU-IND under PMLA), KYC/AML/sanctions screening requirements for clients and settlement entities, tax obligations on VDA transfers (e.g. TDS), and banking-partner terms for INR settlement accounts. The product must support (V1 hooks, `DECISIONS.md D-07`): client KYC status gating trading, record retention, suspicious-activity escalation, and export for regulators. The system must never provide features whose purpose is structuring payments below thresholds.
