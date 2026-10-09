# INRP2P Exchange — Security

Status: Phase 0, revision 3 (`DECISIONS.md` Revision 3).

## 1. Threat model (V1 priorities)

| # | Threat | Impact | Primary controls |
|---|---|---|---|
| S1 | Operator account takeover | Wrong payouts, margin/route leak, fake confirmations | Mandatory TOTP MFA, step-up for money actions, separate desk host, session revocation, anomaly alerts, two-person rules |
| S2 | Leaked quote link | Unwanted commitment by a third party | View-only token — no unauthenticated state change (accept or reject); acceptance/rejection only after OTP to a verified email of an authorized client user (D-01, D-15); funds only to pre-saved client destinations; rate limits |
| S3 | Double submission / retries | Double trade, double payout | Idempotency keys, unique constraints, state-guarded commands |
| S4 | Insider manipulation of history | Hidden margin/theft | Append-only ledger + audit, sealed audit hash chain, adjustments two-person, no direct DB access for app users |
| S5 | Client-side data exposure of internals | Route rate / provider / margin leak | Separate client projection types, serializer allow-lists, tests asserting forbidden keys absent |
| S6 | Fake blockchain evidence | Payout against unpaid trade | Only scanner/adapter facts confirm USDT; operator tx-hash submission triggers verification, never confirms by itself; dual provider above threshold |
| S7 | Fake UTR | Trade marked paid when not | UTR uniqueness, proof attachment, step-up, reconciliation against bank statements (manual import V1): every confirmed movement on the account is checked; a line matches only when account, reference, direction and amount identify exactly one transfer — otherwise `AMBIGUOUS` or `MISMATCHED` with a review case, never a guess |
| S8 | Destination swap | Payout to attacker account | Destinations immutable per quote/trade; changes = archive + new, step-up, `CLIENT_BANK_CHANGED` exception, notify all client admins. An open trade pays a new destination only through a recorded change (reason + how the client confirmed it) approved by a second operator with step-up, to an ACTIVE destination of the same client; never while a payout to the old one is unresolved; the client is notified (IX092, D1) |
| S9 | Sensitive data in logs/backups | Bank data leak | Envelope encryption, redaction, restricted reveal permission |
| S10 | Misattributed USDT deposit | Payout against another client's funds | Unique per-trade deposit address from CustodyAdapter; no amount/sender heuristics; unassigned-address funds to suspense (D-02) |
| S11 | Regulatory misrepresentation | Legal exposure | No regulatory claims in product or public copy until counsel confirms (D-07); Phase 9 copy review |
| S12 | Abuse of public endpoints | Enumeration, credential stuffing | Rate limits, uniform errors, CAPTCHA-less throttling with backoff |
| S13 | Direct route payout double-counted or misapplied | Client shown as paid twice / route obligation wrong | One movement row per UTR/tx, one journal per movement, dimension-unique allocations, atomic direct confirm (FI-27, FI-28, FI-61) |
| S14 | Route identity exposed to client via direct payout | Provider leak | Client projections show amount, status, masked UTR only — never payer entity; receipts show UTR, not remitter name |

## 2. Authentication

### 2.0 Framework boundary
- Standard authentication uses **Better Auth** (no proprietary auth/session framework): users, sessions, credential login, email verification, client **email-OTP** login, operator **TOTP** two-factor.
- Two Better Auth configurations share the database: *operator* (`desk.inrp2p.com`) and *client* (`app.inrp2p.com`), with distinct cookie names and hosts so an operator session never exists in a client browser context.
- INRP2P owns everything around it: RBAC roles/permissions, command-level authorization, step-up freshness, audit of auth events, rate limits on financial endpoints, and the quote-bound **acceptance challenge** (§2.3), which is a domain primitive and does not use Better Auth's OTP.
- Phase 1 verifies that the pinned Better Auth version satisfies every requirement below; any gap is closed with Better Auth hooks/plugins or reported — not by replacing the framework with custom session code.

### 2.1 Operators (`desk.inrp2p.com`)
- Credential login + mandatory TOTP two-factor for **every** operator role (including READ_ONLY). Breached-password check via plugin or equivalent hook.
- Session cookies: `Secure`, `HttpOnly`, `SameSite=Strict`, host-only; idle timeout 30 min, absolute 12 h; server-side revocation.
- **Step-up**: TOTP verified within the last 10 minutes (INRP2P `step_up_verification`) for: confirming incoming INR, confirming payouts (including direct route payouts), changing UTR, cancelling trades, approving adjustments, route settlement confirm, changing capacity, changing roles, revealing full bank details, sending negative-margin quotes.
- Optional IP allowlist for the desk host.

### 2.2 Clients (`app.inrp2p.com`)
- Passwordless **email-OTP login** (Better Auth); successful login marks the email verified. Optional TOTP per client user; TOTP required for `CLIENT_ADMIN` adding/archiving bank accounts or wallets (D-08).
- Session cookies: `Secure`, `HttpOnly`, `SameSite=Lax`, host-only; idle 60 min, absolute 7 days.
- Only client users with `can_accept_quotes` may accept or reject quotes. The flag is granted or revoked by a `CLIENT_ADMIN` of that client or by an operator with `client_user:grant_accept_quotes` (⧗); every change is audited (`client_user.accept_permission_changed`).
- Granting or revoking quote-acceptance authority is a **sensitive client-admin action**: the `CLIENT_ADMIN` must have TOTP enrolled and a fresh TOTP step-up (verified within the last 10 minutes) in the current session. A client admin without TOTP must enroll it before performing this action; there is no email-OTP-only path. The operator-side `client_user:grant_accept_quotes` step-up is unchanged.
- Adding or archiving client destinations (bank accounts, wallets) by a `CLIENT_ADMIN` likewise requires fresh TOTP step-up (D-08). Operators act on behalf through `client_bank:add` (bank accounts) and `client_wallet:manage` (wallets), both ⧗.
- **Client authenticator (TD-11).** A client user sets up TOTP on the Destinations screen (Better Auth `twoFactor`, `allowPasswordless`, `skipVerificationOnEnable: false`): only within ten minutes of signing in with an email code, never over an existing one, and it is enrolled only once a code from it is accepted. One-time recovery codes are shown once. The client surface offers no way to **remove** an authenticator or show its secret again, no new recovery codes without a fresh step-up with the current authenticator, and no trusted devices — so a stolen session cannot swap the authenticator for its own. A verified code (or recovery code) is that session's step-up. A lost authenticator is removed by the desk after confirming the person out of band (`client_user.reset_mfa`, OWNER/SUPPORT ⧗, with a reason; it ends every session of that user) — never by a public bypass. TOTP is a step-up factor for clients, not a second sign-in factor: client sign-in stays the email code.
- **Cross-surface addresses (TD-02).** On the client surface an address that is not an active client's — an operator's, or a disabled one — gets no code and no session, and exactly the answer an unknown address or a wrong code gets; each such refusal is audited once (`session.failed`, `NOT_A_CLIENT_ADDRESS`). The session guard and the database trigger (IX020) stay behind it.

### 2.3 Quote link (`/q/{token}`) and acceptance challenge
- Token: 128 bits CSPRNG, base62, only SHA-256 hash stored; constant-time lookup by hash; `Referrer-Policy: no-referrer`; `noindex`; no third-party scripts.
- **The token is view-only. No quote state can be changed by an unauthenticated viewer.** Opening the page records link telemetry (`open_count`, first open) but never mutates the quote.
- The link page's unauthenticated **"Decline"** is a local UI dismissal only; the quote stays SENT until authenticated rejection, desk cancellation, supersession or expiry.
- Accepting or formally rejecting requires an `acceptance_challenge` (`DECISIONS.md D-01`, `D-15`):
  - Viewer picks a masked recipient among the client's authorized users with verified email; the page never reveals full addresses or the code.
  - OTP: 6 digits CSPRNG, stored as salted hash, valid 5 min and never beyond the quote's `expires_at`, 5 verify attempts, 3 sends per quote per 10 min, single use, bound to `(quote_id, client_user_id)`; a new send supersedes the previous challenge.
  - `quote.accept_via_link` / `quote.reject_via_link` verify the code and change the quote in one transaction against DB time; the challenge is consumed atomically. OTP delivery never extends quote validity.
  - Shareable-link quotes: default validity 180 s, minimum 120 s (in-app quotes may be shorter).
  - An existing client session does not bypass the link OTP; authenticated users can act inside the app instead.
  - OTP emails contain only the code, quote reference and expiry — no amounts, bank or wallet details.
- Token dies with the quote's terminal state; revocable by dealer.
- Why an opaque DB token and not a signed link: revocable, carries no data, cannot outlive a cancelled quote.

## 3. RBAC permission matrix

Legend: ✔ allowed · ⧗ allowed with step-up MFA · ✱ requires second approver (different user) · — denied.

| Permission | OWNER | DEALER | SETTLEMENT_OP | FINANCE | SUPPORT | READ_ONLY |
|---|---|---|---|---|---|---|
| `desk:view` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `economics:view` (route rate, margin) | ✔ | ✔ | — | ✔ | — | — (grantable) |
| `rates:update_route` | ✔ | ✔ | — | — | — | — |
| `request:create` / `request:decline` | ✔ | ✔ | — | — | create only | — |
| `request:withdraw` (withdraw a request on behalf of the client) | ✔ | ✔ | — | — | — | — |
| `quote:create` / `quote:send` / `quote:cancel` | ✔ | ✔ | — | — | — | — |
| `quote:send_negative_margin` | ⧗ | — | — | — | — | — |
| `quote_link:create` / `revoke` | ✔ | ✔ | — | — | — | — |
| `settlement:reserve_capacity` | ✔ | — | ✔ | — | — | — |
| `settlement:create_payout` / `send_payout` | ✔ | — | ✔ | — | — | — |
| `settlement:record_incoming` (record a client's incoming INR reference, T2) | ✔ | — | ✔ | — | — | — |
| `settlement:record_utr` | ✔ | — | ✔ | — | — | — |
| `settlement:record_route_payout_sent` (direct legs) | ✔ | — | ✔ | — | — | — |
| `settlement:change_utr` | ⧗ | — | ⧗ | — | — | — |
| `settlement:confirm_payout` / `confirm_incoming` | ⧗ | — | ⧗ | — | — | — |
| `settlement:fail_payout` / `cancel_payout` | ⧗ | — | ⧗ | — | — | — |
| `crypto:submit_tx_for_verification` | ✔ | — | ✔ | ✔ | — | — |
| `trade:cancel` | ⧗ | ⧗ | — | — | — | — |
| `trade:request_destination_change` (an open trade pays to another verified destination of its client, TD-18; changes nothing until approved) | ⧗ | — | ⧗ | ⧗ | ⧗ | — |
| `trade:approve_destination_change` (approve or decline it — never the requester) | ⧗✱ | — | — | ⧗✱ | — | — |
| `exception:open` | ✔ | ✔ | ✔ | ✔ | ✔ | — |
| `exception:resolve` (non-financial) | ✔ | ✔ | ✔ | ✔ | — | — |
| `adjustment:request` | ✔ | ✔ | ✔ | ✔ | — | — |
| `adjustment:approve` | ⧗✱ | — | — | ⧗✱ | — | — |
| `refund:approve` | ⧗✱ | — | — | ⧗✱ | — | — |
| `inr_account:manage` / `capacity:change` | ⧗ | — | — | ⧗ | — | — |
| `treasury:manage_wallets` | ⧗ | — | — | ⧗ | — | — |
| `client:manage` / contacts | ✔ | ✔ | — | — | ✔ | — |
| `client_bank:add` (operator on behalf) | ⧗ | — | — | — | ⧗ | — |
| `client_wallet:manage` (add or archive client wallets, operator on behalf) | ⧗ | — | — | — | ⧗ | — |
| `client_user:grant_accept_quotes` | ⧗ | — | — | — | ⧗ | — |
| `client_user:reset_mfa` (remove a client user's authenticator after verifying the person out of band; ends their sessions, TD-11) | ⧗ | — | — | — | ⧗ | — |
| `routes:configure` (incl. settlement model) | ⧗ | — | — | — | — | — |
| `route_settlement:record` | ✔ | — | — | ✔ | — | — |
| `route_settlement:confirm` (confirms the movement and allocates the obligation side it was recorded against) | ⧗ | — | — | ⧗ | — | — |
| `route_positions:view` | ✔ | ✔ | — | ✔ | — | — |
| `custody:configure` (adapter, deposit pool) | ⧗ | — | — | ⧗ | — | — |
| `chain:backfill` (read a historical block range again for named exchange addresses, TD-06) | ⧗ | — | — | ⧗ | — | — |
| `custody:refresh_balance` (read what an exchange address holds now, from the configured providers, B2) | ✔ | — | ✔ | ✔ | — | — |
| `bank_account:reveal` | ⧗ | — | ⧗ | ⧗ | — | — |
| `ledger:view` / `pnl:view` / `export` | ✔ | pnl only | — | ✔ | — | — |
| `statement:import` (manual bank statement, reconciled against recorded UTRs — S7) | ⧗ | — | — | ⧗ | — | — |
| `traders:view` (traders, their rates, capacity, orders and reserve) | ✔ | ✔ | — | ✔ | — | — |
| `traders:assign` (route a request to a trader; release an accepted order) | ✔ | ✔ | — | — | — | — |
| `traders:pause` (pause or resume a trader; disable or enable new assignments) | ⧗ | ⧗ | — | ⧗ | — | — |
| `traders:configure` (approve or reject; limits, Security Reserve, reward, settlement details, programme settings) | ⧗ | — | — | ⧗ | — | — |
| `trader_payout:record` (record a reserve withdrawal or reward payout sent) | ✔ | — | — | ✔ | — | — |
| `trader_payout:confirm` (confirm or reject it — posts the movement) | ⧗ | — | — | ⧗ | — | — |
| `trader_reserve:apply` (ask to apply a trader's Security Reserve to USDT one of its orders did not deliver, TD-21; withdraw the request) | ⧗ | — | — | ⧗ | — | — |
| `trader_reserve:approve` (approve or decline it — never the requester; end an approved one before its USDT moves) | ⧗✱ | — | — | ⧗✱ | — | — |
| `receipt:view` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `audit:view` | ✔ | — | — | ✔ | — | — |
| `users:manage` / `roles:assign` | ⧗ | — | — | — | — | — |
| `settings:payout_approval` (the payout second-person threshold, §4; on, off or moved, with a reason) | ⧗ | — | — | — | — | — |
| `settings:new_business` (pause or resume new requests, quotes, acceptances and trader offers; started trades continue) | ⧗ | — | — | ⧗ | — | — |
| `operations:restore_fence` (hold outgoing payments by hand after records were lost, or record the reconciliation that asks to release them) | ⧗ | — | — | ⧗ | — | — |
| `operations:approve_restore_fence_lift` (approve or decline releasing outgoing payments after a restore — never the person who reconciled) | ⧗✱ | — | — | ⧗✱ | — | — |

Rules:
- Authorization is checked inside the command (server), never inferred from the UI.
- Query-level redaction: users without `economics:view` receive DTOs where route rate / margin fields do not exist (not nulled — absent).
- OWNER role assignment requires another OWNER's approval (✱) once more than one OWNER exists: one OWNER requests it (`identity.request_owner`), another OWNER approves it in their own session (`identity.approve_owner`) and the grant is made in that transaction; a name in a payload approves nothing. With exactly one active OWNER, that OWNER grants it alone (single-OWNER mode, audited as such). Nobody grants themselves a role. The first OWNER — and the recovery of a lost sole OWNER — exist only through the protected procedure `scripts/operator-admin.ts`, run with the infrastructure database credential; the database refuses the application role any other way to an OWNER row, and any removal of one (IX091). See RUNBOOKS `operator-access`.
- Every operator command re-checks, in its own transaction, that the account is ACTIVE and the session it came from is still open (`assertLiveOperator`): disabling an account or revoking a session stops the next command, not just the next page.
- An idempotent replay (the same key, the same request) returns its stored result only after the command's authorization passes again for the caller now; the request identity includes the caller and the surface, so another person's — or another surface's — use of a key is refused (`IDEMPOTENCY_KEY_REUSED`).
- `created_by ≠ approved_by` enforced by DB CHECK on `financial_adjustment`.
- Route obligations and route settlements reveal route economics, so every `route_*` permission is limited to roles that already hold `economics:view` (OWNER, FINANCE; DEALER read-only positions). Exception: confirming a direct (`payer = ROUTE`) payout leg needs only `settlement:confirm_payout`; the route allocation is computed by the system and its amounts are not shown to users without `economics:view`.

## 4. Separation of duties (V1 defaults)

| Action | Rule |
|---|---|
| Financial adjustment | requester ≠ approver |
| Refund of confirmed client funds | requester ≠ approver |
| Payout confirmation | above a threshold (default ₹2,500,000 per leg; a USDT leg valued at its trade's frozen client rate) the user who marked a leg sent cannot confirm it, and the system never does. The sender and confirmer are recorded from the verified actor (`settlement_leg.sent_by` / `confirmed_by`); a leg sent before they were recorded falls back to its creator. Enforced in the command and by the database (IX090). The threshold is `settings:payout_approval` (OWNER ⧗, with a reason, append-only history) |
| Capacity increase | audited; above threshold requires approver |

A single-person desk can run V1 by disabling thresholds explicitly in Settings (audited action, OWNER only).

## 5. Data protection

- Encryption at rest: managed Postgres storage encryption + application envelope encryption for account numbers and client contact phone numbers; TOTP secrets are stored encrypted as Better Auth's two-factor plugin manages them (verified in Phase 1).
- **Key-encryption key (TD-03).** Each sealed value has its own AES-256-GCM data key, bound to its field and owner as AAD; the data key is wrapped by an **AWS KMS** symmetric key (`INRP2P_KEK_PROVIDER=aws-kms`, `INRP2P_KMS_KEY_ARN`) under the fixed encryption context `{app: inrp2p, purpose: field-data-key}`, so the application never holds the KEK and KMS will not unwrap a data key under any other context. Calls are signed (SigV4) with the workload's role credentials; a KMS that cannot be reached fails the operation — never a plaintext fallback. Every sealed value names its key id, so a new KMS key is introduced with the old one listed in `INRP2P_KEK_PREVIOUS` and old values stay readable. With `INRP2P_ENV=production` the process refuses to start on a locally held KEK (current or previous), a missing configuration, or one of the repository's own test keys. Provisioning, the minimal IAM policy and rotation: RUNBOOKS `field-encryption-keys`.
- Keyed HMAC (separate key, from the secret manager) for bank account dedup and UTR lookup.
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
- Rate limits (Postgres/edge token bucket): login 5/15min per account+IP, OTP verify 5 attempts per code, quote link open 30/min per IP, quote-link OTP send 3 per quote per 10 min and 10/hour per IP, OTP verify 5 attempts per challenge, quote accept/reject 5/min per token, financial mutations 60/min per user.
- Idempotency-Key header required on all financial mutation endpoints; UI generates a key per intent (not per click).
- Uniform error messages on auth and link lookup (no token/email enumeration).
- Dependency scanning, lockfile pinning, SBOM in CI.

## 8. Audit coverage (must emit)

`rate.changed` · `quote.created/sent/accepted/rejected/expired/cancelled` · `quote_link.created/opened/revoked` · `acceptance_otp.sent/verified/failed/superseded` · `client_user.accept_permission_changed` · `deposit_address.assigned/released/retired` · `custody.capability_changed` · `route_obligation.created/partially_settled/settled/cancelled` · `route_settlement.recorded/confirmed/allocated/failed` (DIRECT_TO_CLIENT with actor SYSTEM and the leg's correlation id) · `leg.payer_reclassified` · `quote_link.local_decline` is **not** audited (no server call) · `routes.settlement_model_changed` · `capacity.reserved/consumed/released/changed` · `settlement_account.selected` · `usdt.detected/confirmed/failed` · `utr.entered/changed` · `leg.*` · `trade.*` transitions · `adjustment.requested/approved/rejected` · `exception.opened/resolved/voided` · `client_bank.added/archived` · `client_wallet.added/archived` · `user.role_granted/revoked` · `user.mfa_enrolled/reset` · `session.login/logout/step_up/failed` · `bank_account.revealed` · `settings.threshold_changed` · `export.generated` (kind, period, row count and the sha256 of the bytes served) · `receipt.generated` (the snapshot's hashes, never the document) · `statement.imported` (the file's name and sha256, its period and what it reconciled — never its contents).

Stored: actor, time, action, entity, redacted before/after, correlation id, idempotency key, session id, hashed IP. Sealed hourly into `audit_seal` hash chain; seal hashes exported daily to an external write-once location (an S3 bucket under Object Lock in compliance mode, `audit_seal_export`, migration 0034), and the trail is verified against that archive every day — the seals here and the events re-hashed — so a database rewritten and re-sealed to agree with itself is still caught (FI-53). After a restore, outgoing payments are held until two people have reconciled (FI-54, RUNBOOKS `restore-fence`).

## 9. Compliance boundary (not legal advice — requires counsel before launch)

INRP2P Exchange operates in a regulated area. Before production launch, counsel must confirm at minimum: registration obligations for virtual-digital-asset service providers in India (FIU-IND under PMLA), KYC/AML/sanctions screening requirements for clients and settlement entities, tax obligations on VDA transfers (e.g. TDS), banking-partner terms for INR settlement accounts, and the treatment of direct payouts made by a liquidity route to client bank accounts (`DIRECT_TO_CLIENT`). Engineering Phase 1 is not blocked on these details (`DECISIONS.md D-07`), but production launch is. Until counsel confirms, the product, public site, SEO pages, receipts and notifications make **no regulatory claims** (registration, licence, "regulated", approvals or compliance status). The product must support (V1 hooks): client KYC status gating trading, record retention, suspicious-activity escalation, and export for regulators. The system must never provide features whose purpose is structuring payments below thresholds.
