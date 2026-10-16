# ADR 0018 — Clean INR: rupees count only when they came from the payer's own account

Status: **Accepted** — owner task of 2026-10-16 ("the best INR ⇄ USDT experience — better than Binance — and the most
powerful, modern implementation"). Builds on ADR 0016 (counterparty-funded execution) and ADR 0017 (own USDT rails) and
changes neither. Migration `0038`, error codes IX116–IX119, schema version 38, FI-96.

## 1. Context

On a P2P desk in India the costly failure is not a bad rate: it is a frozen bank account. Rupees a scam victim was made
to send reach the desk through a "payer" who is not their owner; the victim complains to the cyber-crime portal
(1930 / NCCRP); the police ask the bank to put a lien on every account the money touched; the desk's collection
account — and with it every trade — stops. Binance P2P lives with this by telling buyers to pay only from an account in
their verified name and treating anything else as a dispute; the money never touches Binance, so the frozen account is
the seller's problem. Here the rupees pass through INRP2P's own account (ADR 0016), so the exchange carries the risk —
and can therefore do better than a rule in a help page: check who sent every rupee before it counts.

Before this change the client of a BUY was told "the desk sends you the account and the reference": the instructions
came by message, the client told the desk the UTR the same way, the desk recorded it and confirmed it after looking at
the bank. Nothing recorded which account the money came from, and nothing stopped a stranger's rupees from counting.

## 2. Decision

### 2.1 The client is told where to pay, by when, under which reference
When a BUY quote is accepted, `trade_collection` fixes the trade's payment instructions (IX117, append-only): the
collecting account of the exchange (the one that took the fewest trades in the last day, so inflows spread over every
account the desk opened), the trade's own payment reference (`P` + seven Crockford characters, for the remarks), and
`pay_by` — 30 minutes. The client's trade screen shows them in full (the account number opened for the client only),
with copy buttons, and — when the account has a UPI ID and the amount is within UPI's ₹1,00,000 — a `upi://pay` code
(NPCI's linking specification) that fills in the payee, the exact amount and the reference; on a phone it is one tap.

### 2.2 The client says it paid, from which of its own accounts
`fiat_in.claim` is the client's "I paid": which of its own registered accounts paid, the rail, and the bank's reference
— checked against the rail's shape while the payment app is still open (12 digits for UPI and IMPS, 16–22 characters
for NEFT and RTGS). It files the payment exactly as the desk would (`recordClientInrInTx`): a leg in PROCESSING, a
`fiat_transfer` with `payer_bank_account_id` (IX118: the payer's own account) and `filed_by = CLIENT`. A client may pay
in several transfers (IMPS caps a transfer); nothing more is taken once the amount due is filed. The desk can still
record a payment itself, with the account it came from and what the credit shows.

### 2.3 Rupees count only when their sender was seen to be the payer (FI-96)
`fiat_sender_check` is the evidence of who sent a credit: what a bank statement showed (`via = STATEMENT`) or what a
person typed from the bank's own screen (`via = DESK`), judged against the account the payment was declared from (or
every registered account of the payer when none was declared). The verdict:

- **MATCH** — every word of the sender's name is the holder's, with at least two full words in common, allowing
  initials, a narration cut at a fixed width, one-letter spellings, Indian transliterations (LAKSHMI/LAXMI,
  MD/MOHAMMED) and company suffixes (PVT/PRIVATE, LTD/LIMITED); matching account digits settle a thin name;
- **PARTIAL** — nothing contradicts it but too little is there ("R SHARMA" could be a father), or the account digits
  differ; a person may accept it as the payer's own, with the reason (⧗, IX119) — never anything else;
- **MISMATCH** — a word that is not the holder's ("SURESH" for "RAHUL"): someone else paid. It opens
  `INR_UNEXPECTED_SENDER` (blocking: the trade is held) and tells the client the payment goes back;
- **UNKNOWN** — the credit showed no sender.

The verdict that counts is the latest check, except that a statement that once showed someone else is never
outvoted, and a statement that showed too little does not undo what a person saw in full. **IX116**: a payment from a
client — or from a trader's route into the exchange — becomes CONFIRMED only when that verdict is MATCH or ACCEPTED.
The confirming commands say so first (`INR_SENDER_NOT_VERIFIED`); the database is the last word.

The statement import reads the sender of every credit it matches — from `sender_name` / `sender_account` columns when
the bank exports them, else from the narration (`UPI/…/NAME/vpa@bank`, `IMPS/P2A/…/NAME/IFSC`, `NEFT-…-NAME-…`) — and
records the check. A credit already confirmed that the statement shows came from someone else opens the case all the
same.

### 2.4 Rupees from a stranger are returned, never kept or re-assigned
`INR_UNEXPECTED_SENDER` is resolved by sending the rupees back to the account they came from — never to the client —
and marking the payment not received; the trade waits for a payment from the client's own account, or is cancelled.
The same rule applies to a trader's rupees into the exchange: `trader_order.submit_payment` declares the trader's
registered account, and the desk's confirmation is gated the same way.

### 2.5 The payment window
`inr_payment_expiry` (worker, every minute) cancels a BUY whose client neither paid nor said so by `pay_by`, through the
same cancellation the desk uses (`cancelTradeInTx`): everything released, the acceptance reversed, the trader's order
released, the client told why. A trade with any payment filed is never touched: that one waits for a person.

### 2.6 The exchange's own accounts, from the desk
The desk opens its INR accounts itself (INR accounts → Add an account: the owning entity the first time, the account
number sealed at once) and edits what a paying client sees on a collecting account — the payee name and its UPI ID.
Until an account collects, the page says that BUY clients have nowhere to pay.

## 3. Consequences

- A stranger's rupees cannot become a client's USDT, by mistake or by pressure: the desk cannot click past it and the
  database refuses it. This is the protection that keeps the collection account from being frozen.
- Every counted payment carries its evidence: the client's account, the sender as the bank showed it, the word-by-word
  comparison, who checked and when. That is what answers a bank's or the police's question about a credit.
- The client never waits for a message: where to pay, how much, the reference and the time left are on the screen.

What this does not do yet (TECH_DEBT TD-33, TD-34):

- **Bank-verified accounts.** A client's registered account is the one the desk entered; nothing yet asks the bank who
  holds it ("penny drop", Cashfree/Razorpay/Setu). Then the holder name a sender is compared with is the bank's own.
- **Payments the bank identifies itself.** A virtual account or UPI ID per trade, from a banking partner, would make the
  bank name the trade and the remitter at once — the INR twin of ADR 0017's address per deal — and a confirmation needs
  no person. It needs a partner that serves the business.
- **Returning a stranger's rupees through the platform.** The return is a bank transfer the desk makes and records in
  the case; it is not a leg of its own.
