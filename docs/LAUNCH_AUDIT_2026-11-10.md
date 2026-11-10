# Launch audit before trader onboarding — 2026-11-10

Scope: `main` at `4c1be83` (schema 48), read as code, not as documentation: the trader's way in, bank accounts and rails,
reserve, pricing and matching, the P2P deal (escrow, pay, confirm), disputes, cancellations, withdrawals, and who is told
what. Method: walk each journey as a first-time Indian P2P trader and as its client, and look for places where one part of
the product contradicts another. Branch `claude/launch-audit`; migration `0049`.

## Findings

| # | Sev | What a person meets | Where | Status |
|---|---|---|---|---|
| 1 | P0 | **A timed deal changes hands in silence.** A trader selling USDT is told "you will be told when it is your turn" while its 30-minute escrow clock already runs. A client buying is not told its time to pay (15 min by UPI) has started. A trader hears "the buyer says it paid" only in Telegram. A client selling is not told its trader says it paid. Each is first heard of when the time is up. | `notifications/messages.ts`, `traders.ts`, `handler.ts`, `telegram.ts`; `settlement/p2p-timing.ts` | Fixed |
| 2 | P0 | **A trader's payment methods are asked for and ignored.** "Clients pay you by" (per side) only filtered matching; the deal offered whatever the amount allowed — a UPI code and UPI's 15 minutes to a trader who had unticked UPI. The application's bank form offered IMPS/NEFT/RTGS only: UPI could not be said at registration at all. | `settlement/p2p.ts`, `p2p-timing.ts`, `traders/onboarding.ts`, `SettlementFields.tsx` | Fixed |
| 3 | P1 | **A client can buy with no bank account to pay from.** The request asks only for a wallet; "I've paid" needs a registered account. The client accepts, the trader locks USDT, and the page then says "ask the desk to add one" with the clock running. | `quotes/requests.ts`, `RequestForm.tsx`, desk deal screens, `PayInr.tsx` | Fixed |
| 4 | P1 | **Capacity runs out without a word.** Setup calls capacity "what open orders may hold at once"; in fact every completed order uses it up. A side at zero takes no orders while the card says "You're online · available for matching". | `traders/orders.ts`, `SetupFlow.tsx`, `BlockCard.tsx`, `AvailabilityCard.tsx` | Fixed |
| 5 | P1 | **An account a live deal depends on can be archived for good.** A client could archive the bank account an open trade pays to, or the account/wallet its trader profile settles with: the buyer is then shown "the seller's account is being prepared" and no clock ever starts. | `clients/destinations.ts` | Fixed |
| 6 | P2 | A client's account showed "IMPS / NEFT / RTGS" — a list nobody chose and nothing honoured. "Trade open: the payment details are on the trade" on a BUY whose escrow is still empty. A stale comment saying clients cannot manage destinations. | `RequestForm.tsx`, `DestinationsScreen.tsx`, `messages.ts`, `actions/client.ts` | Fixed |
| 7 | P1 | **UPI goes to `<account>@<ifsc>.ifsc.npci`, untested in real apps; a trader cannot enter its own UPI ID.** | ADR 0023 | Open — TD-45, owner |
| 8 | P1 | **A reserve withdrawal waits for a person** (three operator steps), with no time promised to the trader. | `traders/reserve.ts` | Open — TD-42, owner |
| 9 | P2 | A client gets no Telegram alert for its deal — inbox and email only, for a 15-minute step. | `notifications/telegram.ts` | Open — TD-46 |

Read and found sound (no change): escrow funding and release, the sender check, pay-window deadlines and the final period,
disputes and INRP2P's decision, unwinds and refunds, cancellation and journal reversal, reserve attribution, trader
limits, automatic pricing and price requests, settlement-change hold.

## What changed

- **Hand-offs (migration 0049: `P2P_PAY_NOW`, `P2P_PAYMENT_SENT`, `TRADER_SIDE_EMPTY`).** The seller is told to lock its USDT
  and how long it has; the buyer is told the moment its window opens, with the IST time (`p2p.pay_window_opened`); the
  seller — trader or client — is told when the buyer says it paid. Inbox and email; Telegram's "order confirmed" says
  "your move" to a seller.
- **Rails.** `dealRails` + `railOptionsFor`: a deal offers what the amount allows among what the trader's side uses; the
  window opens on the first of them; a rail the side does not use cannot be chosen. "I've paid" is never refused for its
  rail. The application offers UPI; a trader approved on an account it submitted starts with the rails it chose. Each side
  on Traders shows its rails.
- **BUY needs a paying account** (`PAYER_ACCOUNT_REQUIRED`), asked for on the Exchange, a desk's page and a deal link —
  each adds it in place.
- **Capacity**: true wording, a warning when an online trader has no side that can take an order, and one message when a
  completed order leaves a side under its smallest order.
- **Archive guard** (`DESTINATION_IN_USE`) for the client's own archive; the desk keeps its power.

Decided against: making `bank_account.rail_preferences` binding. On most accounts nobody chose it (the client's form never
asked; fixtures and the desk set it arbitrarily) — a deal refused a way to pay by a list its owner cannot see would be a
worse fault than the one being fixed.

## Evidence

| Suite | Result |
|---|---|
| Typecheck, lint, workspace graph, secret scan | clean |
| Unit | 1,806 / 1,806 (59 files; 2 new) |
| Integration | 1,012 passed, 1 failed, 1 skipped — the failure is `database-logins`, which fails the same way on untouched `main` (local trust auth). 11 new in `test/integration/launch-audit.int.test.ts`. Four MinIO suites not run (Docker is hung on this machine). |
| Browser (built app, real database) | 43 / 43 — desk 16, client-mobile 9, desks 7, human 5, merchant 6 |
| Not run | visual baselines (they change — §22 of DEPLOYMENT), Lighthouse, mobile-perf |

## Before real traders

1. **Release 49**: migrate production before merging; then the worker image of the same commit (DEPLOYMENT §22).
2. **UPI in real apps** (TD-45): one rupee by the deal's code from GPay, PhonePe and Paytm. If any refuses the account
   address, take UPI off new sides by default or add a reviewed UPI ID to settlement details.
3. **Reserve withdrawals** (TD-42): say a time on the Reserve page, or let the signer send them.
4. **Re-record visual baselines**; a controlled deal each way on production with the new messages watched arriving.
