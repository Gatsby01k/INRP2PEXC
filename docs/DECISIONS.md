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
| D-16 | Counterparty-funded execution (trader liquidity, no platform advance) | **Resolved (owner, 2026-10-04)** | — |

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

## D-16 — Counterparty-funded `PER_TRADE` execution — Resolved (owner, 2026-10-04)
Full record: `docs/adr/0016-counterparty-funded-execution.md`.
- Every client exchange is executed with the funds of the parties of that trade: the client's confirmed funds pay
  for what the client receives, and the counterparty (a trader, or a desk route) funds the counter-asset. The
  platform's own working USDT/INR is never advanced and may be zero.
- The funding model is frozen per trade (`trade_funding`): `COUNTERPARTY_FUNDED` for every trade accepted from
  migration 0024 on; `LEGACY_EXCHANGE_FUNDED` only for trades accepted before it. It is orthogonal to the execution
  mode (D-14): `TO_EXCHANGE` stays the V1 transit for trader routes, and `PER_TRADE` (D-03) is unchanged.
- An exchange-paid client payout needs counterparty funds of the same trade at the account/address it is sent from;
  a payment to the counterparty (`TO_ROUTE`) or a refund needs the client's funds of the same trade. A confirmed
  incoming movement is earmarked at most once (funding allocations, FI-70…FI-79). D-12 still holds.
- The exchange hands client funds to the counterparty only after the counterparty delivered (delivery versus
  payment). Acceptance never reserves treasury funds for a counterparty-funded trade; FI-33 keeps protecting legacy
  reservations only.
- Not part of this decision: `PREFUNDED` / `NET_SETTLED` (still refused, FI-63), credit, automatic signing, reserve
  confiscation or currency conversion, and a direct trader→client path (not offered until separately chosen).


## D-17 — Self-service: clients open their own accounts; one Security Reserve address — Resolved (owner, 2026-10-10)
- **Clients open their own accounts.** The workspace sign-in sends its email code to any address; someone new names
  the account on `/open-account` (`client.open_account`) and is its administrator, able to accept quotes, with the
  Exchange open at once. No operator admits a client. Unchanged: destinations need the administrator's authenticator,
  every request is priced by a person on the desk, `kyc_status` stays `NOT_STARTED` for every client until the
  compliance workflow exists (D-07 — counsel before launch), and one person holds one client membership.
- **One reserve address for every trader.** Traders top up their Security Reserve at one TRC20 address,
  `TJNzB4sUGBo8fv7UdeeKQKQUffpfLSXbPP` (owner-controlled; the application only watches it), shown with its QR. It
  replaces the per-trader reserve address from the custody pool; reserve addresses already issued stay watched and
  credit as before. The address is recorded by migration 0035, so changing it is a reviewed migration.
- **The sender's wallet attributes the money.** A transfer into the shared address is the reserve of the single trader
  whose registered wallet sent it and was on file before the transfer; otherwise it is nobody's until the desk
  resolves it. A trader may hand in its transaction hash; the facts are read from the chain and the same rule applies,
  so a hash cannot be claimed by another trader and a deposit is credited once (FI-83).
- **Topping up is not admission.** The address is shown from the day a trader applies, and money arriving during the
  review is credited; approval to receive orders remains the desk's separate decision (`trader.approve`). Withdrawals
  go to the registered, verified wallet only; the account's administrator may ask for one.
- Not part of this decision: automatic return of unattributed deposits, any change to how trades are funded (D-16), and
  the public site's wording about onboarding (the home page is frozen; TECH_DEBT TD-29).

## D-18 — Production on Vercel, Neon and AWS; the test bank accounts archived, `prod-v1` retired — Resolved (owner, 2026-10-11)
- **Where it runs.** The web app stays on Vercel (project `inr463rergr`, the production domains); the database is the
  existing Neon PostgreSQL 18 project (`us-east-1`); the worker runs on AWS ECS Fargate with its own task role
  (`deploy/aws/inrp2p-aws.json`). The field-encryption key is an AWS KMS key in the same account. Proposed, not decided
  by the owner: everything in `us-east-1`, where the database is. This closes D-06's open hosting question for this
  deployment; PITR is Neon's own (its restore window is the plan's).
- **No long-term AWS key anywhere.** The worker gets credentials from its task role; the Vercel web app assumes a role
  through Vercel's OIDC federation (`AWS_ROLE_ARN`, only for the project's production deployments); the worker image is
  pushed to ECR by a GitHub workflow through GitHub's OIDC federation. A production process refuses a long-term access
  key (`AKIA…`).
- **The two bank accounts in production are test data, archived — not moved.** CL-0003 and CL-0004 hold random
  details the owner added for testing, sealed under the locally held key `prod-v1` (owner, 2026-10-11, revising the
  first instruction to keep them). They are archived from the desk the ordinary way (`client_bank.archived`, with a
  reason and the authenticator, audited) once the release runs; nothing pays an archived account and the desk does not
  reveal one, so nothing ever tries to decrypt them, and `prod-v1` is retired, not carried over. The release never
  runs with a locally held key. No other sealed value exists in production, so nothing is re-sealed; the re-seal
  (`scripts/reseal-fields.ts`, migration 0036) stays available for a key that must be retired while its values must
  stay readable.
- **The web app and the worker connect as their own logins** (`inrp2p_app_login`, `inrp2p_worker_login`;
  `scripts/database-logins.ts`), never as the Neon owner role.
- Not part of this decision: whether the notifications the release at 23 left undelivered are sent late (DEPLOYMENT
  §10), the audit-archive retention period (the template's default is a proposal), and a second TRON provider (D-05).
