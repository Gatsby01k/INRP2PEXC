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

## 3. The schema (migration 46)

Migration 46 drops `inr_settlement_account`, `inr_account_day`, `capacity_reservation`, `settlement_entity`, `bank_statement_import`,
`bank_statement_line`, `trade_collection`, `trader_reward_payout` and `treasury_reservation`, with every `reward_*` and `reimbursed_*`
column, the columns that pointed at them, `treasury_wallet.reserved_minor` and the kinds and states of a reserve application that
delivered USDT. It refuses, whole, if any of it ever carried money: nothing about money is dropped by accident, and a read-only
`scripts/p2p-only-preflight.ts` gives the same answer beforehand. Release order: `docs/DEPLOYMENT.md`, Stage 3.

The names of what remains are kept, because they are in the ledger, the audit trail and the guards: `settlement_leg.side` is still
`CLIENT_TO_EXCHANGE` / `EXCHANGE_TO_CLIENT`, `payer` is still `ROUTE` / `EXCHANGE_ACCOUNT`, route settlement flows are `DIRECT_TO_CLIENT` /
`DIRECT_FROM_CLIENT` / `FROM_ROUTE_TO_EXCHANGE`. In a P2P deal they mean: the rupees' leg, the USDT released to the buyer, and each
side's delivery. The exchange can only ever pay USDT (`settlement_leg_exchange_pays_only_usdt`).

`execution_mode` stays on `liquidity_route`, `route_obligation` and `trade_economics`, because fifteen financial guards read it and
rewriting them to remove one word is not worth their risk. It can no longer vary: a live route and every new deal are P2P by
constraint. Old rows keep what they were written with, and the code's filters on the column stay so they are never picked up.

## 4. Documents

`RUNBOOKS` and `DEPLOYMENT` describe today's product. `DOMAIN_MODEL`, `STATE_MACHINES`, `FINANCIAL_INVARIANTS`, `TRADERS` and `UX_FLOWS`
still have sections on the old models; where they disagree with this ADR, this ADR wins. Phase reports are history and stay as written.
