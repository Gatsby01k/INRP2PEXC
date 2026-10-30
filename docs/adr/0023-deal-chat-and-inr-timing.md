# ADR 0023 — A P2P deal's chat, and its rupees paid on each rail's own time

Status: **Accepted** — owner request of 2026-10-30. Builds on ADR 0019 (P2P escrow) and ADR 0020 §2.15 (disputes,
unwinds). Migration `0042`, schema 42. Nothing of the escrow, the ledger, GasFree or the sender check changes.

## 1. Context

A P2P deal's two sides could not talk to each other: a question about the account, a late bank, a screenshot — all went
off the platform, or to nobody. And every P2P step had the same 30 minutes whatever the rail: too long for a UPI payment
that lands in seconds, too short for a NEFT one that waits for the next half-hourly batch, and a buyer whose time ran out
was cancelled without a word first.

## 2. Decision

### 2.1 One private chat per P2P deal (`deal_message`, `deal_file`)
- Its people: the trade's client's members and the route trader's members — each sees the other only as "the buyer" or
  "the seller", never a name — and INRP2P's people who work cases (`exception:open`), who see who wrote what.
- Text up to 2,000 characters; files a bank app's screen or statement is saved as — JPEG, PNG, WebP, PDF, up to 3 MB —
  known by their bytes, never by the browser's word. A side attaches up to 15; a person writes up to 20 messages a minute.
  Files live in the database, served only through `/api/deal-files/:id` after the reader is authorized, under a sandbox
  CSP with `nosniff`, a PDF as a download; their bytes must still hash to what was recorded. The reader role sees that a
  message or a file exists, never its words or bytes.
- Append-only: what was said stays said. Writable while the deal is live and for 7 days after it closes (or while a
  support call is open); readable always.
- **The chat moves no money (IX134).** A receipt attached to a payment (`kind = RECEIPT`, the payer's own payment only)
  is shown to the payee as what it is — the buyer's screenshot, not proof. The escrow still releases only on the payee's
  own confirmation, checked against who its bank says sent the money (ADR 0018/0019). Payment and escrow states are shown
  on the deal's card, by the server — never as chat messages.
- The other side hears of a message (never its words) in its inbox — at most once per 15 minutes of unread conversation
  — by email, and a trader by Telegram, at most once per 10 minutes.

### 2.2 "Call support" is a case, not a hold
Either side opens `P2P_SUPPORT` (WARNING) for the deal; one open call per deal. It shows on the desk's queue and the
trade's panel; the first answer of INRP2P's people in the chat says they joined. The deal and its deadlines go on: only a
dispute ("it has not arrived") stops the escrow. The case closes with `support_answered` (or escalates).

### 2.3 The time to pay, by rail (`trader_program.p2p_timing`, `p2p_pay_window`)
- The programme sets, and a person changes (`trader_program.configure`): the trader's time to fund a BUY's escrow (30),
  the buyer's time to pay by rail — **UPI 15, IMPS 30, NEFT 60, RTGS 45** minutes — the final period (5), and the payee's
  time to confirm by rail — UPI 30, IMPS 30, NEFT 180, RTGS 90.
- A deal's window opens when the buyer could first see where to pay: the escrow final and the payee's account there to
  show (the later of the two). Its method is the one the amount suggests — UPI up to ₹1 lakh, IMPS up to ₹5 lakh, RTGS
  above (RTGS only from ₹2 lakh, NEFT for any amount) — until the buyer chooses another (`escrow_payment.choose_method`,
  `trader_order.choose_method`). Its deadline is that method's time **from the opening**, so a buyer can choose a slower
  rail but never stretch the window past the slowest one; a method whose time from the opening is over cannot be chosen;
  it changes at most three times, and never once the payment is filed (IX135). The window keeps the timing it opened
  with: a change of policy never moves a running deal.
- When the time is up and nothing is filed, both sides are told once (`P2P_PAY_FINAL`) and the buyer has the final
  period, counted from that warning; only after it is the deal undone exactly as before — a BUY cancelled and the
  trader's USDT returned, a SELL unwound and the client's USDT returned.
- **Once the buyer says it paid, nothing is undone for time.** The pay clock stops; the payee's clock is its rail's. Past
  it, the desk gets a `P2P_RECEIPT_OVERDUE` case and both sides are told INRP2P is checking (`P2P_RECEIPT_LATE`). The
  payee confirms (release) or says it has not arrived (dispute: blocking, escrow held); a disputed or unanswered payment
  is decided by INRP2P (`escrow_payment.decide`) — paid or not paid. False claims are bounded the same way: the payee
  disputes, INRP2P decides not paid, the deal unwinds.
- Every deadline is the server's (`inrp2p_now()`); screens count from the server's clock. Every step of the deadlines
  job re-reads the deal under the trade's lock, so "I've paid" and the deadline cannot both win: either the payment is
  filed and the deal waits, or the deal is cancelled and the payment is refused.

### 2.4 Paying, the same for a client and a trader
One payment card for whoever pays: the methods with their time, the payee's account to copy (IFSC checked for RBI's
shape), or for UPI a code and a `upi://pay` link to the account's own UPI address (`<account>@<ifsc>.ifsc.npci`, so a UPI
payment lands in exactly the registered account), the exact amount and a remark the payee recognises; a short warning
on large amounts about banks' limits for new payees; then the reference (UTR, checked for the rail's shape), an optional
receipt, and "I've paid".

## 3. Consequences
- No new subsystem: the chat is two tables and the existing command pipeline, outbox, inbox, email and Telegram; support
  is the existing case queue; the timing lives on the trader programme.
- Deals open before 0042 keep their old rule: their windows are backfilled at 30 minutes from the escrow for every rail.
- Implementation: `chat.ts`, `p2p-timing.ts`, `deal-commands.ts` (settlement), the trader's commands in `delivery.ts`,
  `runP2pDeadlines`, `p2pDeal` (`payWindow`, `receiptLate`, `chat`, `payTo.upiId/upiLink/remarks`), `DealChat`,
  `PayInr`, `ClaimProof` (web), the desk's `DeskDealChat`; IX134–IX135.
