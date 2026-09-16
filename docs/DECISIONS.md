# INRP2P Exchange — Decisions

Revision 3 — 2026-09-16. Founder review of revision 2 applied (direct route settlement, authenticated rejection, approved stack, link timing).
Status values: **Resolved** (founder decision) · **Default** (proposed, not objected to; may be changed without reopening Phase 0) · **Gate** (resolved in principle; a named external fact must be confirmed before a specific implementation step).

| ID | Topic | Status | Blocks |
|---|---|---|---|
| D-01 | Quote link acceptance authentication and link timing | Resolved (rev 3: timing) | — |
| D-02 | USDT deposit attribution | Resolved + **Gate** | Deposit-address implementation (Phase 2) until custody provider capability is confirmed |
| D-03 | Liquidity route settlement model | Resolved (rev 3: obligation recognized at acceptance) | — |
| D-04 | `EXCEPTION` as hold overlay | Resolved | — |
| D-05 | TRON confirmation providers and thresholds | Default | — |
| D-06 | Technology stack | **Resolved (rev 3)** | — |
| D-07 | Compliance scope | Resolved | Production launch (counsel), not engineering |
| D-08 | Client authentication method | Resolved (rev 3, via Better Auth) | — |
| D-09 | Full UTR on client receipts | Default | — |
| D-10 | Brand colour and accessible variants | Resolved | — |
| D-11 | INR number formatting | Resolved | — |
| D-12 | No payouts before client leg confirmed | Resolved (rev 3, applies to route-paid legs too) | — |
| D-13 | Trade `OPEN` state removed | Resolved | — |
| D-14 | Route execution modes and direct-to-client settlement | **Resolved (new, rev 3)** | — |
| D-15 | Quote rejection requires authentication | **Resolved (new, rev 3)** | — |

---

## D-01 — Quote link acceptance — Resolved (timing revised in rev 3)
- Opening or viewing a quote link **never** authorizes acceptance or any other quote state change. The token grants read access to the client projection of one quote, nothing more (see D-15 for rejection).
- Final acceptance through a link requires identity verification by a **short-lived one-time code (OTP)** sent to a **verified contact of an authorized client user** of the quote's client.
- "Authorized client user" = a `client_user` with role `CLIENT_ADMIN` or `CLIENT_TRADER` and `can_accept_quotes = true`. "Verified contact" = that user's login email marked verified by Better Auth (V1 channel: email). Telegram/WhatsApp/SMS OTP delivery later through the same `NotificationAdapter` boundary.
- The link page shows recipients only in masked form (`a•••@acmepay.in`); the code is never displayed on the page.
- OTP: 6 digits, CSPRNG, stored as hash, valid 5 minutes and never beyond the quote's `expires_at`, max 5 verification attempts, max 3 sends per quote per 10 minutes, single use, bound to one quote and one client user. Requesting a new code supersedes the previous one.
- Verification and acceptance run as **one command** (`quote.accept_via_link`): the challenge is consumed and the quote accepted in the same transaction, judged against DB time. OTP delivery time never extends quote validity.
- The acceptance challenge is an **INRP2P domain primitive**, not Better Auth's OTP: it needs quote-specific TTL, attempt limits, actor binding, DB-time validation, idempotency and atomic consumption together with acceptance.
- No per-client "bearer link" opt-out exists.
- In-app acceptance requires an authenticated client session (Better Auth email-OTP login, D-08); the accepting user must hold `can_accept_quotes`.
- **Timing (rev 3):** quotes with a shareable link default to **180 seconds** validity with a **minimum of 120 seconds**. A link may be attached to an already-sent quote only while ≥ 120 seconds remain. In-app authenticated quotes may use shorter validity (minimum 30 seconds). OTP never extends expiry.
- Acceptance records `accepted_by_user_id`, `accepted_via` (`APP` | `LINK`) and `acceptance_challenge_id`.

## D-02 — USDT deposit attribution — Resolved, with Gate
- SELL_USDT trades are attributed **only** by a **unique deposit address per trade**, supplied through the `CustodyAdapter` (wallet adapter) by either address derivation or a provider-managed address pool.
- The adapter declares its capability: `capabilities() → { depositAddress: 'DERIVED' | 'POOL' | 'UNSUPPORTED' }`. The domain calls `allocateDepositAddress(network, tradeRef)` and never knows which mechanism is used.
- An address has at most one open assignment. After the trade reaches a terminal state the address enters `COOLDOWN` (default 7 days) before it can be reassigned (pool mode) or is retired (derived mode, default: never reused).
- There is **no** fallback attribution by shared address, amount matching, sender wallet, or operator guessing. Funds that arrive at an address with no open assignment are recorded to `SUSPENSE:UNALLOCATED` with an exception — that is recording, not attribution.
- If no address can be allocated at acceptance, acceptance fails cleanly (`DEPOSIT_ADDRESS_UNAVAILABLE`) and the desk is alerted.
- **Gate:** before the deposit-address module is implemented (Phase 2), the chosen custody/wallet provider must be confirmed to support derivation or pooling of TRC20 receive addresses, including how funds on those addresses are consolidated and what that requires (e.g. TRX for energy/bandwidth). If it does not, implementation stops and the exact limitation is reported to the founder. No alternative attribution logic is to be designed in its place.
- The application still stores no private keys.

## D-03 — Liquidity route settlement — Resolved (revised in rev 3)
- Route obligations are modelled **separately** from client settlement. A client trade completes when the client obligation is satisfied; it never waits for the route.
- `liquidity_route.settlement_model` ∈ `PER_TRADE` | `PREFUNDED` | `NET_SETTLED`. V1 implements **`PER_TRADE`** only; configuring another model is rejected by validation until that model is implemented. The schema and ledger accounts are designed so the other two can be added without changing trades, client settlement or existing obligations.
- `PER_TRADE`: each accepted trade creates one `route_obligation` (status OPEN) whose amounts and execution mode are frozen from the trade's route economics (SELL: exchange delivers `base` USDT, route delivers `route_value_inr`; BUY: exchange delivers `route_value_inr`, route delivers `base` USDT).
- Actual provider settlement is recorded as `route_settlement` records, each referencing one real movement (TRC20 transfer or INR transfer with UTR), and allocated to obligations through `route_settlement_allocation`. Allocation is many-to-many by design, so net/batch settlement later needs no new model. Execution modes are defined in D-14.
- Provider interaction sits behind a new `RouteAdapter` port. V1 implementation: `ManualRouteAdapter` (operator records, system verifies on-chain evidence where applicable).
- Ledger (rev 3): route receivable/payable are recognized **at acceptance** together with the client obligation, with the margin held in `LIAB:DEFERRED_MARGIN` and moved to `REVENUE:GROSS_MARGIN` at trade completion. This lets route movements (including direct payouts) reduce the route receivable before completion without negative balances. Prefunding (`ASSET:ROUTE_PREFUND:{r}`) is reserved for `PREFUNDED`, unused in V1.

## D-04 — Exception overlay — Resolved
Exceptions are `ExceptionCase` records plus a `hold` flag on the trade. The lifecycle state is preserved; several exceptions may be open at once; the UI shows "Exception" as the primary status while `hold = true`.

## D-05 — TRON confirmation — Default
Primary provider + independent second provider. CONFIRMED requires: solidified block, `SUCCESS` receipt, Transfer log from the configured USDT contract, destination = the expected destination (assigned deposit address for client deposits). Dual-provider agreement required at ≥ 10,000 USDT (configurable). Scanner lag alert > 2 minutes behind the solidified head.

## D-06 — Stack — Resolved (rev 3)
- Node.js 24 LTS · TypeScript 6 (`strict`) · latest patched stable Next.js 16.x with its paired React · PostgreSQL 18.6 · Kysely with explicit SQL migrations · Graphile Worker · pnpm workspaces · Vitest + Testcontainers · Playwright · Storybook.
- **Better Auth** for standard authentication: users, sessions, email verification, client email-OTP login, operator TOTP two-factor. No proprietary general auth/session framework. Better Auth schema is committed as explicit SQL migrations.
- INRP2P keeps: RBAC and every command-level authorization rule from Phase 0, step-up freshness, auth audit, and the quote-bound acceptance challenge (D-01).
- Hosting remains open (managed Postgres 18 with PITR, KMS, private object storage); not a Phase 1 blocker. Data-residency requirements, if any, go to counsel (D-07).

## D-07 — Compliance — Resolved
- Engineering Phase 1 is **not** blocked on legal implementation details.
- Compliance and audit hooks designed in Phase 0 are preserved: client `kyc_status` gating quote acceptance, screening result fields, document attachments, retention policy, append-only audit with sealing, regulator/export capability.
- The product, public site, SEO pages, receipts and notifications make **no regulatory claims** (registration, licence, compliance status, "regulated", "RBI/FIU approved" or similar) until confirmed by India counsel. This is enforced by a content checklist in Phase 9 and code review of all public copy.
- Production launch remains gated on counsel sign-off, including the treatment of direct route payouts to client bank accounts (D-14).

## D-08 — Client authentication — Resolved (rev 3)
Passwordless email-OTP login for client users through Better Auth (verifies the email, satisfying D-01's "verified contact"). Optional TOTP per client user; TOTP required for `CLIENT_ADMIN` when adding/archiving bank accounts or wallets.

## D-09 — UTR visibility — Default
Masked `••••7118` in UI rows; full UTR on the client's own receipt; full view for operators with permission.

## D-10 — Brand colour — Resolved
- `--brand-primary` = **`#F04E23`** (sampled from the supplied logo) for brand signal, arcs, active rails, focus rings, selection, large display elements.
- `--brand-action` = **`#C8401A`** (5.00:1 with white) for any orange surface that carries text (primary buttons) and for orange text; hover `#B83A16`.
- Readable muted text uses **`#6B6F77`** (≥ 4.5:1 on both `#FFFFFF` and `#F7F5F0`); `#91959D` is limited to disabled/decorative use. Secondary text `#656A73` already passes.
- The logo asset is used as supplied.

## D-11 — INR formatting — Resolved
- Client and operator UI display INR with **international three-digit grouping**: `₹10,200,000.00` / `₹10,200,000`. (Founder clarified on 2026-09-16 after the review message mentioned both formats: international grouping applies.)
- Storage and computation are locale-free: `BIGINT` minor units; JSON as plain decimal strings without grouping (`"10200000.00"`).
- Formatting is done by a single deterministic formatter in `packages/ui/format` that does not depend on the runtime/browser locale (no `Intl` locale defaults that could produce lakh/crore grouping).
- Compact forms (`₹6.5M`, `₹800k`) are allowed only in summaries, never where the exact amount is the evidence (legs, receipts, quotes).
- CSV/JSON exports carry ungrouped decimals.

## D-12 — Credit — Resolved
No payout before the client's incoming leg is confirmed in V1 — this applies equally to exchange-paid and route-paid (`DIRECT_TO_CLIENT`) payout legs. Pre-funding trusted clients would be a separately designed feature.

## D-13 — Trade `OPEN` state — Resolved
Removed. Acceptance creates the trade directly in `AWAITING_FIRST_LEG`.

## D-14 — Route execution modes and direct-to-client settlement — Resolved (rev 3)
**Problem.** The primary real-world route is: client sends USDT → the liquidity route sends INR **directly to the client's bank account**. One real INR transfer (one UTR) then satisfies both the client payout obligation and part of the route's INR obligation to the exchange.

**Decision.**
- `liquidity_route.execution_mode` ∈ **`DIRECT_TO_CLIENT`** | **`TO_EXCHANGE`**, frozen per trade at acceptance (`trade_economics.route_execution_mode`, `route_obligation.execution_mode`). It is orthogonal to `settlement_model` (D-03). V1: `PER_TRADE` × both modes.
  - `DIRECT_TO_CLIENT`: the route delivers the client's payout asset straight to the client's saved destination (SELL: INR to bank; BUY: USDT to wallet). Exchange accounts may still top up (mixed payers).
  - `TO_EXCHANGE`: the route delivers to exchange INR accounts / treasury; the exchange pays the client.
- **One movement, one evidence row, one journal.** Every real transfer is a single `fiat_transfer` (unique UTR) or `crypto_transfer` (unique tx/log) and posts exactly one journal keyed by the movement. Legs and route settlements are links (`transfer_allocation`, dimensions CLIENT and ROUTE) and never post.
- A payout leg has `payer` `EXCHANGE_ACCOUNT` or `ROUTE`. Confirming a `ROUTE` leg is one atomic command: movement confirmed → leg COMPLETED (CLIENT dimension) → system-created `route_settlement` (flow `DIRECT_TO_CLIENT`) allocated to the trade's route obligation (ROUTE dimension) → journal **Dr CLIENT_PAYABLE / Cr ROUTE_RECEIVABLE** → trade completion if the client obligation is met. Any precondition failure rolls back all of it.
- The trade completes on client obligations alone; route residuals stay on the route obligation.
- Example: SELL 100,000 USDT, client ₹102.00, route ₹104.20. Route pays ₹10,200,000 directly to the client (one UTR). The trade is COMPLETED and ₹220,000 margin realized; the route obligation is PARTIALLY_SETTLED with ₹220,000 INR still receivable (and the 100,000 USDT exchange-side delivery open until sent). The residual is closed by a `FROM_ROUTE_TO_EXCHANGE` settlement or an approved financial adjustment.
- Direct payouts consume no exchange INR account capacity. Client-facing views and receipts never reveal the route or remitter identity.
- Out of V1: client pays the route directly.

## D-15 — Quote rejection requires authentication — Resolved (rev 3)
- An unauthenticated viewer of a quote link cannot change quote state.
- The link page's **"Decline"** without verification is a **local UI dismissal** only (no server mutation, no audit event). The quote stays SENT until authenticated rejection, desk cancellation, supersession or expiry.
- Formal rejection (`REJECTED`) requires either an authenticated client session of a user with `can_accept_quotes` (`quote.reject`) or a consumed OTP acceptance challenge on the link (`quote.reject_via_link`).
