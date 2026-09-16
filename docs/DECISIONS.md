# INRP2P Exchange — Open Decisions

Status: Phase 0. Each item is a question the source documents do not settle, or where they conflict. Each has a recommendation; nothing below is treated as decided until the founder confirms.

| ID | Topic | Status |
|---|---|---|
| D-01 | Quote link acceptance authentication | **Open — needs founder** |
| D-02 | USDT deposit attribution (how an incoming TRC20 transfer is matched to a trade) | **Open — needs founder** |
| D-03 | Route-side settlement tracking | **Open — needs founder** |
| D-04 | `EXCEPTION` as state vs hold overlay | Proposed |
| D-05 | TRON confirmation providers and thresholds | Proposed |
| D-06 | Technology stack | Proposed |
| D-07 | KYC / compliance scope in V1 | **Open — needs founder + counsel** |
| D-08 | Client authentication method | Proposed |
| D-09 | Full UTR on client receipts | Proposed |
| D-10 | Brand orange vs WCAG AA | Proposed |
| D-11 | INR digit grouping | **Open — needs founder** |
| D-12 | Payouts before first leg confirmed (credit) | Proposed: not in V1 |

---

## D-01 — Quote link acceptance
**Problem.** The Master Prompt wants a link that can be opened from Telegram/WhatsApp and accepted without a dashboard workflow. A pure bearer link means anyone who sees the message (forwarded chat, shared phone, group chat) can commit the client to a 100,000 USDT trade.
**Mitigating fact.** Funds can only flow to the client's pre-saved destinations, so a leaked link cannot redirect money — the risk is an unauthorized *commitment*, not theft.
**Options.**
A. Bearer link: token alone views and accepts.
B. Token + one-time code to the client's registered contact (email in V1; Telegram/WhatsApp later) on Accept — one extra step, ~10 seconds. Skipped if the browser already holds a valid client session.
C. Token views; accepting requires full sign-in.
**Recommendation: B.** Keeps "accept in seconds", closes the forwarded-link risk, and gives the audit trail a verified identity. Per-client setting may allow A for clients who explicitly opt in (audited).

## D-02 — USDT deposit attribution
**Problem.** V1 holds no private keys. TRC20 has no memo field. If all clients send to one shared address, matching a transfer to a trade relies on amount + sender, which collides (two clients sending 100,000 USDT) and breaks on short/over payments.
**Options.**
A. **Per-trade deposit address from a pool** of addresses generated in the external custody tool and imported watch-only; an address is assigned to exactly one open trade, then cools down before reuse. Attribution is deterministic.
B. Per-client permanent deposit address (watch-only). Deterministic per client; ambiguous only if one client has two open SELL trades → require sequential funding or exact amount.
C. Shared address + registered source wallet + amount match + operator confirmation.
**Recommendation: A**, with B as fallback if the custody setup cannot pre-generate addresses. C only as a manual exception path. Requires confirming what the external custody/wallet stack can generate and sweep.

## D-03 — Route-side settlement
**Problem.** The prompt models the route rate economically (margin) but not the actual settlement with the route (delivering 100,000 USDT to the liquidity route, receiving INR into settlement accounts). Without it, treasury and INR account balances can't be reconciled to trades end-to-end.
**Recommendation.** V1: record route economics in the ledger (`ROUTE_RECEIVABLE/PAYABLE`, see FINANCIAL_INVARIANTS §3) and add a lightweight **RouteSettlement** record (batch, not per trade: amount, asset, tx hash/UTR, route) so the route position nets to zero over time. Full route operations later. Please confirm how routes actually settle (per trade, per day, prefunded?).

## D-04 — EXCEPTION as hold overlay
See STATE_MACHINES §3. Recommended: overlay, because a trade in exception must keep its lifecycle position and may have several open issues. UI still shows "Exception" as primary status.

## D-05 — TRON confirmation
Primary provider + independent second provider; CONFIRMED requires solidified block, SUCCESS receipt, USDT contract log, correct destination. Dual-provider agreement required ≥ 10,000 USDT (configurable). Scanner lag alert > 2 minutes behind solidified head.

## D-06 — Stack
TypeScript, Next.js App Router, PostgreSQL 16, Kysely + SQL migrations, Graphile Worker, Vitest + Testcontainers, Playwright, Storybook, pnpm monorepo (ARCHITECTURE §2). Chosen on merits for this product: one language, exact `bigint` money, Postgres-native durable jobs and locking, SEO + app in one deploy. Hosting to be decided (needs managed Postgres with PITR, KMS, private object storage; region India or nearby for latency — confirm any data-residency requirement with counsel).

## D-07 — KYC / compliance in V1
Source documents are silent. A USDT↔INR OTC exchange in India very likely carries registration, KYC/AML and tax obligations. Recommendation: V1 ships **hooks** (client `kyc_status` gating quote acceptance, document attachments, sanctions-screening result field, retention policy, regulator export) but not an in-house KYC workflow; process runs manually or via a provider chosen with counsel. Launch is blocked on counsel sign-off.

## D-08 — Client authentication
Email OTP passwordless for client users; TOTP required for client admins changing destinations. Alternative: password + optional TOTP. Recommendation: OTP (fewer credentials to leak; clients arrive from messengers and use mobile).

## D-09 — UTR visibility
Masked `••••7118` in UI rows (brief); full UTR on the client's own receipt, because the receipt is the evidence they give their bank. Operator full view with permission.

## D-10 — Brand orange contrast
Logo orange `#F04E23` with white label is 3.61:1 (fails AA for button text). Brief also requires AA. Recommendation: keep `#F04E23` for brand signal/large elements, use `#C8401A` (5.0:1) for text-bearing primary actions; replace muted `#91959D` with `#6B6F77` for readable text. Visual decision → Design System authority; flagged because the brief itself conflicts internally.

## D-11 — INR grouping
Brief examples use `₹10,200,000` (international). Indian users read `₹1,02,00,000` natively. Options: international everywhere; Indian everywhere; client preference with Indian default. Recommendation: **client-side user preference, default Indian (lakh/crore) grouping; operator desk default international with toggle** — but this changes the look of every example in the brief, so founder call.

## D-12 — Credit
No payout before the client's leg is confirmed in V1. Trusted-client pre-funding would be a separate, explicitly designed feature (limits, exposure ledger), not a flag.
