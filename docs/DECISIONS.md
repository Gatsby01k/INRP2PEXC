# INRP2P Exchange — Decisions

Revision 2 — 2026-09-16. Founder review of Phase 0 applied.
Status values: **Resolved** (founder decision) · **Default** (proposed in Phase 0, not objected to; may be changed by founder without reopening Phase 0) · **Gate** (resolved in principle, but a named external fact must be confirmed before a specific implementation step).

| ID | Topic | Status | Blocks |
|---|---|---|---|
| D-01 | Quote link acceptance authentication | Resolved | — |
| D-02 | USDT deposit attribution | Resolved + **Gate** | Deposit-address implementation (Phase 2) until custody provider capability is confirmed |
| D-03 | Liquidity route settlement | Resolved | — |
| D-04 | `EXCEPTION` as hold overlay | Resolved | — |
| D-05 | TRON confirmation providers and thresholds | Default | — |
| D-06 | Technology stack | Default | Confirm before Phase 1 code |
| D-07 | Compliance scope | Resolved | Production launch (counsel), not engineering |
| D-08 | Client authentication method | Default (aligned with D-01) | — |
| D-09 | Full UTR on client receipts | Default | — |
| D-10 | Brand colour and accessible variants | Resolved | — |
| D-11 | INR number formatting | Resolved | — |
| D-12 | No payouts before client leg confirmed | Default | — |
| D-13 | Trade `OPEN` state removed | Resolved | — |

---

## D-01 — Quote link acceptance — Resolved
- Opening or viewing a quote link **never** authorizes acceptance. The token grants read access to the client projection of one quote, nothing more.
- Final acceptance through a link requires identity verification by a **short-lived one-time code (OTP)** sent to a **verified contact of an authorized client user** of the quote's client.
- "Authorized client user" = a `client_user` with role `CLIENT_ADMIN` or `CLIENT_TRADER` and `can_accept_quotes = true`. "Verified contact" = that user's login email with `email_verified_at` set (V1 channel: email). Telegram/WhatsApp/SMS OTP delivery later through the same `NotificationAdapter` boundary.
- The link page shows recipients only in masked form (`a•••@acmepay.in`); the code is never displayed on the page.
- OTP: 6 digits, CSPRNG, stored as hash, valid 5 minutes and never beyond the quote's `expires_at`, max 5 verification attempts, max 3 sends per quote per 10 minutes, single use, bound to one quote and one client user. Requesting a new code supersedes the previous one.
- Verification and acceptance run as **one command** (`quote.accept_via_link`): the challenge is consumed and the quote accepted in the same transaction, judged against DB time. OTP delivery time does not extend quote validity.
- No per-client "bearer link" opt-out exists.
- In-app acceptance requires an authenticated client session (itself established by OTP login, D-08); the accepting user must hold `can_accept_quotes`.
- Default: quotes that carry a link have a minimum validity of 60 seconds so an email OTP can realistically complete (general minimum stays 30 seconds for in-app quotes). Dealer sees a warning below 90 seconds.
- Acceptance records `accepted_by_user_id`, `accepted_via` (`APP` | `LINK`) and `acceptance_challenge_id`.

## D-02 — USDT deposit attribution — Resolved, with Gate
- SELL_USDT trades are attributed **only** by a **unique deposit address per trade**, supplied through the `CustodyAdapter` (wallet adapter) by either address derivation or a provider-managed address pool.
- The adapter declares its capability: `capabilities() → { depositAddress: 'DERIVED' | 'POOL' | 'UNSUPPORTED' }`. The domain calls `allocateDepositAddress(network, tradeRef)` and never knows which mechanism is used.
- An address has at most one open assignment. After the trade reaches a terminal state the address enters `COOLDOWN` (default 7 days) before it can be reassigned (pool mode) or is retired (derived mode, default: never reused).
- There is **no** fallback attribution by shared address, amount matching, sender wallet, or operator guessing. Funds that arrive at an address with no open assignment are recorded to `SUSPENSE:UNALLOCATED` with an exception — that is recording, not attribution.
- If no address can be allocated at acceptance, acceptance fails cleanly (`DEPOSIT_ADDRESS_UNAVAILABLE`) and the desk is alerted.
- **Gate:** before the deposit-address module is implemented (Phase 2), the chosen custody/wallet provider must be confirmed to support derivation or pooling of TRC20 receive addresses, including how funds on those addresses are consolidated and what that requires (e.g. TRX for energy/bandwidth). If it does not, implementation stops and the exact limitation is reported to the founder. No alternative attribution logic is to be designed in its place.
- The application still stores no private keys.

## D-03 — Liquidity route settlement — Resolved
- Route obligations are modelled **separately** from client settlement. A client trade completes when the client obligation is satisfied; it never waits for the route.
- `liquidity_route.settlement_model` ∈ `PER_TRADE` | `PREFUNDED` | `NET_SETTLED`. V1 implements **`PER_TRADE`** only; configuring another model is rejected by validation until that model is implemented. The schema and ledger accounts are designed so the other two can be added without changing trades, client settlement or existing obligations.
- `PER_TRADE`: each accepted trade creates one `route_obligation` whose amounts are frozen from the trade's route economics (SELL: exchange delivers `base` USDT, route delivers `route_value_inr`; BUY: exchange delivers `route_value_inr`, route delivers `base` USDT).
- Actual provider settlement is recorded as `route_settlement` records (evidence: TRC20 transfer or INR transfer with UTR) and allocated to obligations through `route_settlement_allocation`. Allocation is many-to-many by design, so net/batch settlement later needs no new model.
- Provider interaction sits behind a new `RouteAdapter` port. V1 implementation: `ManualRouteAdapter` (operator records, system verifies on-chain evidence where applicable).
- Ledger: route economics are recognized in `ASSET:ROUTE_RECEIVABLE:{r}` / `LIAB:ROUTE_PAYABLE:{r}` at trade completion; route settlements post against those accounts. Prefunding (`ASSET:ROUTE_PREFUND:{r}`) is reserved for the `PREFUNDED` model and unused in V1.

## D-04 — Exception overlay — Resolved
Exceptions are `ExceptionCase` records plus a `hold` flag on the trade. The lifecycle state is preserved; several exceptions may be open at once; the UI shows "Exception" as the primary status while `hold = true`.

## D-05 — TRON confirmation — Default
Primary provider + independent second provider. CONFIRMED requires: solidified block, `SUCCESS` receipt, Transfer log from the configured USDT contract, destination = assigned address. Dual-provider agreement required at ≥ 10,000 USDT (configurable). Scanner lag alert > 2 minutes behind the solidified head.

## D-06 — Stack — Default
TypeScript, Next.js App Router, PostgreSQL 16, Kysely + SQL migrations, Graphile Worker, Vitest + Testcontainers, Playwright, Storybook, pnpm monorepo (ARCHITECTURE §2). Hosting open: needs managed Postgres with PITR, KMS, private object storage; any data-residency requirement to be confirmed with counsel. **Confirm before the first Phase 1 commit.**

## D-07 — Compliance — Resolved
- Engineering Phase 1 is **not** blocked on legal implementation details.
- Compliance and audit hooks designed in Phase 0 are preserved: client `kyc_status` gating quote acceptance, screening result fields, document attachments, retention policy, append-only audit with sealing, regulator/export capability.
- The product, public site, SEO pages, receipts and notifications make **no regulatory claims** (registration, licence, compliance status, "regulated", "RBI/FIU approved" or similar) until confirmed by India counsel. This is enforced by a content checklist in Phase 9 and code review of all public copy.
- Production launch remains gated on counsel sign-off.

## D-08 — Client authentication — Default
Passwordless email OTP login for client users (verifies the email, satisfying D-01's "verified contact"). Optional TOTP per client user; TOTP required for `CLIENT_ADMIN` when adding/archiving bank accounts or wallets.

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

## D-12 — Credit — Default
No payout before the client's leg is confirmed in V1. Pre-funding trusted clients would be a separately designed feature.

## D-13 — Trade `OPEN` state — Resolved
Removed. Acceptance creates the trade directly in `AWAITING_FIRST_LEG`.
