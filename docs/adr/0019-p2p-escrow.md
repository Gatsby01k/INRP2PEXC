# ADR 0019 — P2P escrow: rupees go straight between client and trader, the exchange holds the USDT

Status: **Accepted** — owner decisions of 2026-10-17: INRP2P has no Indian company and no INR bank account, so no rupee
can pass through the exchange; the trader is paid no reward by INRP2P in this model (it earns on its own rate); the
platform's TRX budget pays the network fees, which the client's price carries. Builds on ADR 0016 (counterparty-funded
execution), ADR 0017 (own USDT rails) and ADR 0018 (clean INR). Migration `0039`, execution mode `P2P`, schema 39.

## 1. Context

Through-the-exchange execution (ADR 0016 `TO_EXCHANGE`) needs an exchange bank account in India: the client's rupees
land there and the trader is paid from it, or the trader's rupees land there and the client is paid from it. The owner
has none, and will not have one. Binance P2P never touches the rupees: the buyer pays the seller directly while the
platform holds the seller's crypto, and releases it when the seller says it was paid. INRP2P already holds USDT the way
an escrow must — a fresh address of its own HD wallet per deal, and a signer that sends exactly once (ADR 0017) — so
the same model fits, with the client still dealing with INRP2P's price and INRP2P's rules rather than a stranger's ad.

## 2. Decision

### 2.1 Execution mode `P2P` (trader routes)
A trader's route executes `P2P`: the rupees of a trade move once, directly between the client's and the trader's own
registered bank accounts; the USDT moves through the deal's own address, which only the exchange's signer can spend.
The trader programme names the mode new trader routes get (`P2P` by default); a desk route cannot be `P2P`.

### 2.2 Economics: one rupee amount, two USDT amounts, the margin in USDT (FI-97)
In P2P the client pays (or receives) exactly the rupees the trader receives (or pays). The exchange's margin — and the
network fee the client's price carries — is the USDT between what the client gets or gives and what the trader gives
or gets:

| | client | trader | exchange keeps (USDT, at the deal address) |
|---|---|---|---|
| Client **buys** USDT | pays ₹ `inr` to the trader, receives `base` USDT | receives ₹ `inr`, delivers `route_base` USDT | `route_base − base` |
| Client **sells** USDT | sends `base` USDT, receives ₹ `inr` from the trader | pays ₹ `inr`, receives `route_base` USDT | `base − route_base` |

`inr = base × client_rate` (the client side rounds against the client), `route_base = inr ÷ trader_rate` (rounded so the
exchange never gives more than the trader's rate allows). `quote.route_value_inr = quote_inr` and
`gross_margin_inr = 0`; `route_base_minor` and `gross_margin_base_minor` carry the USDT side, frozen with the quote and
the trade (IX045 extended). The trader's order is `(route_base, inr)` at its own rate; because the rupees are shared,
the desk names the client rate when it assigns a P2P request (as it already does for an INR-fixed one), and the quote
must use exactly that rate.

### 2.3 What the price must cover (FI-90 for P2P)
`net_margin_usdt = gross_margin_base − network_fee_usdt` (the TRX the transfers burn, valued at the published TRX price,
rounded up) must be at least the minimum net margin (the policy's INR minimum, valued at the client rate); no trader
reward is counted (`reward_bps = 0`, IX113 unchanged). The platform budget funds the TRX (`funder = platform`): a trader
needs no network deposit on a P2P route.

### 2.4 The order of things — whoever's money is at risk acts second
- **Client buys USDT.** (1) The trader delivers `route_base` USDT to its order's address — the escrow. (2) Only then is
  the client shown the trader's account and asked to pay `inr` from its own registered account, and says so with the
  bank's reference. (3) The trader confirms it received the rupees and, from its own bank screen, who sent them (ADR
  0018: rupees from someone else never count). (4) The signer sends the client `base` USDT from the escrow; the margin
  stays there.
- **Client sells USDT.** (1) The client sends `base` USDT to the trade's address — the escrow. (2) Once final, the
  trader is shown the client's account and pays `inr` from its own registered account, with the reference. (3) The
  client confirms it received the rupees, and who sent them. (4) The signer sends the trader `route_base` USDT from the
  escrow; the margin stays there.

### 2.5 Books
- Accept: BUY — USDT Dr `ROUTE_RECEIVABLE` route_base / Cr `CLIENT_PAYABLE` base / Cr `DEFERRED_MARGIN(USDT)`; INR Dr
  `CLIENT_RECEIVABLE` / Cr `ROUTE_PAYABLE` inr. SELL — USDT Dr `CLIENT_RECEIVABLE` base / Cr `ROUTE_PAYABLE` route_base /
  Cr `DEFERRED_MARGIN(USDT)`; INR Dr `ROUTE_RECEIVABLE` / Cr `CLIENT_PAYABLE` inr.
- The client's rupees paid to the trader (`fiat` CLIENT → ROUTE): Dr `ROUTE_PAYABLE` / Cr `CLIENT_RECEIVABLE` — no
  exchange cash account is touched; the trader's rupees paid to the client (ROUTE → CLIENT): Dr `CLIENT_PAYABLE` / Cr
  `ROUTE_RECEIVABLE` (the `DIRECT_TO_CLIENT` journal).
- USDT movements are unchanged; completion moves `DEFERRED_MARGIN(USDT)` to `GROSS_MARGIN(USDT)`.

### 2.6 Receipts are confirmed by the one who received
The payer files the payment (`fiat_in.claim` for a client's, `trader_order.submit_payment` for a trader's); the payee
confirms it (`payout.confirm_received`), typing the sender as its bank shows it — the sender check of ADR 0018, `via =
PAYEE`. Rupees from someone else are refused (`INR_UNEXPECTED_SENDER`) and go back. A payee who neither confirms nor
disputes within the window gives the desk a case (`P2P_RECEIPT_OVERDUE`): the desk confirms on its behalf only with
the bank's evidence, or marks the payment not received. A late confirmation still counts, and closes the case. The
trader confirms a client's rupees with `trader_order.confirm_received` (a user who can commit for the trader).

### 2.7 Time limits (`escrow_deadlines`, every minute)
- Client buys: the trader has 30 minutes from the trade's opening to fund the escrow; then the client has 30 minutes from
  the escrow being final to pay (or say it paid). Either missed, the trade is cancelled — never one with a payment filed.
- Client sells: the client has the quote's deposit window; then the trader has 30 minutes to pay, or the desk gets a
  case (`P2P_PAYMENT_OVERDUE`) and refunds the client by hand (TD-35). The case closes when the trader files its payment.
- Receipt: the payee has 30 minutes to confirm, or the desk gets a case (§2.6).

### 2.8 An escrow nobody paid against goes back (FI-98)
A cancelled client's BUY ends its route obligation with it even though the trader delivered (the only obligation that
may: P2P, the exchange delivered nothing — IX120). The signer then sends the trader's own USDT back from the deal
address to its registered wallet (`ESCROW_RETURN`, a chain send earmarked against the trader's delivery, at most
`inrp2p_escrow_returnable`, at the platform's cost; over the approval threshold it waits for a second person), and the
network hold stays open until it is back. Books: the cancellation reverses the acceptance, leaving the route receivable
credited by the delivery; the return posts Dr `ROUTE_RECEIVABLE` / Cr the escrow's treasury asset, which closes it.

### 2.9 Who sees what
The side that pays sees the other side's account — holder, bank, IFSC, number — on its screen, only for that deal and
only while it is to pay (TD-37). Nothing else of the counterparty is shown: the client sees "the seller" or "the buyer",
the trader the same; neither sees the other's rate, and the client never sees the trader's USDT amount (it would give
away the margin). The payee types the sender as its bank shows it — it is not told the name to expect.

## 3. Consequences
- No rupee touches INRP2P: no INR account, no collection account, no statement to reconcile for P2P trades.
- The client still never deals with a stranger's ad: INRP2P chooses the trader, fixes the price, holds the USDT, checks
  who paid, and settles disputes.
- The bank-freeze risk sits with the trader's and the client's own accounts, as on Binance — and ADR 0018's rule (only
  your own account, sender checked by the receiver) is what keeps it low.
- Revenue is USDT left at deal addresses (TD-36).
- Implementation: `computeP2pEconomics` (kernel), `priceNetworkP2p` (network), `p2pAcceptJournal` (ledger),
  `fileRoutePayoutInTx` / `confirmP2pReceiptInTx` / `confirmClientReceipt` / `p2pDeal` / `runP2pDeadlines` (settlement
  `p2p.ts`), `planEscrowReturnInTx` (settlement `signed.ts`), `confirmOrderPaymentReceived` (traders), the client's
  `P2pDealCard` and the trader's `P2pOrderAction`; FI-97, FI-98; RUNBOOKS `p2p-escrow`; DEPLOYMENT §13.
