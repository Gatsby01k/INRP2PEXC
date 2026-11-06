# ADR 0027 — P2P only: the old settlement models are gone

Status: **Accepted** — owner's decision of 2026-11-05. Supersedes the parts of D-14, D-16, ADR 0018 and the Traders programme
that describe an exchange account in the middle. Keeps ADR 0019 (P2P escrow), 0020 (desks), 0022 (GasFree), 0024 and 0025.

## 1. Context

Since ADR 0019 every deal is P2P: the rupees go straight between the client's and the trader's own registered accounts, and
INRP2P holds the USDT in the deal's escrow. The code still carried the two models before it — a deal through INRP2P's own INR
account (`TO_EXCHANGE`) and a route paying the client directly (`DIRECT_TO_CLIENT`) — with their screens, commands, rewards,
capacity and statement imports. Nobody used them; no client and no real deal depended on them.

## 2. Decision

Removed from the product:
- INR accounts, their daily capacity and reservations, settlement entities, bank statement import and reconciliation against it;
- client payments into an exchange account (collection, UPI code, payment window, `inr_payment_expiry`, `capacity_day_rollover`);
- operator-recorded payout legs and route settlements, the payer selector, direct payouts;
- trader rewards and paying a trader's TRX back in rupees: a deal's network is its trader's cost, or comes out of the deal on GasFree;
- applying a reserve to a delivery. A reserve is only **held** against rupees an order owes, with two people (TD-21);
- treasury reservations for a BUY delivered by the exchange;
- UI components and permissions only those screens used.

TRX mode (`BURN`) stays as the fallback for GasFree (ADR 0022).

## 3. What stays in the schema for now

The database keeps the names and tables until the migration that drops them (`docs/DEPLOYMENT.md`, stage 3): `settlement_leg.side`
is still `CLIENT_TO_EXCHANGE` / `EXCHANGE_TO_CLIENT`, `payer` is still `ROUTE` / `EXCHANGE_ACCOUNT`, route settlement flows are
`DIRECT_TO_CLIENT` / `DIRECT_FROM_CLIENT` / `FROM_ROUTE_TO_EXCHANGE` / `TO_ROUTE`. In a P2P deal they mean: the rupees' leg, the USDT
released to the buyer, and each side's delivery. `trader_order.reward_bps` is written as 0 because IX113 still reads it.
`execution_mode` columns remain and are always `P2P` on new rows; queries keep filtering on them until old rows are retired.

## 4. Documents

`RUNBOOKS` and `DEPLOYMENT` describe today's product. `DOMAIN_MODEL`, `STATE_MACHINES`, `FINANCIAL_INVARIANTS`, `TRADERS` and `UX_FLOWS`
still have sections on the old models; where they disagree with this ADR, this ADR wins. Phase reports are history and stay as written.
