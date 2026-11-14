# ADR 0030 — The one who pays a UPI ID checks it

Status: **Accepted** — owner's decision of 2026-11-14 ("why send it to an operator for checking — what will they check?").
Amends ADR 0029 §2.2–2.3; everything else of ADR 0029 stands. Migration `0051`, schema 51. Nothing of the escrow, the
ledger, a bank account's rules or the sender check (ADR 0018) changes.

## 1. Context

ADR 0029 made every UPI ID a client added wait for a person at INRP2P. That person opened a UPI app, started a payment to
the address without paying, and typed the name it showed. That name is exactly what the payer's own UPI app shows it, on
the same screen, a second before it enters its PIN — on every deal. The queue checked nothing the payer does not see
anyway; it made a client wait for a person, nights and weekends included, before it could be paid by UPI, and gave the
payer a "verified by INRP2P" badge to trust instead of its own screen. P2P boards (Binance, OKX) work the other way: a
payment method is live when added, and the payer checks the counterparty's name in its app before paying.

The risk the check exists for: a payee who gives an address in someone else's name — a mistake, or a third party paid
for a scheme — so the buyer's rupees reach a stranger, and the deal ends in a dispute or a frozen account.

## 2. Decision

### 2.1 A UPI ID is live when it is added
Added by the client's administrator — like a bank account, its first by a sign-in or code in the last ten minutes, any
further one by another factor (ADR 0026) — it is `ACTIVE` at once. Nobody types a name beside it: the name a payer is
told to expect is the **payee's own** — the holder of the account the deal would otherwise be paid to (its oldest active
account, else its legal name; `ownNameOf`) — never a name the session typed. A trader's application adds its UPI ID the
same way. One the desk adds after looking it up keeps the name it saw and its full limits at once.

### 2.2 Until a deal confirms it, it takes small deals only
An address no deal has confirmed takes at most **₹25,000 a payment and a day** (`UPI_FIRST_DEAL_MAX_MINOR`, in
`usableUpiId`): what a stranger's address could take before its first payer looked at the name. It is confirmed
(`name_confirmed_at`, `name_confirmed_trade_id`) when a deal paid to it by UPI is confirmed by its owner — the rupees
arrived — and its payer had said its app showed the owner's name. From then on, its own limits. A person at INRP2P
putting it back after a report also confirms it.

### 2.3 The payer checks the name, and says so
The deal shows the payer the UPI ID, the amount, and "the name your app must show": the payee's own. Paying by UPI to the
deal's UPI ID, "I've paid" needs "My UPI app shows <name>" (`payeeNameConfirmed`; refused otherwise with
`UPI_NAME_UNCHECKED`), recorded on the deal's window (`p2p_pay_window.payee_name_confirmed_at`). A claim made before the
deadlines opened the window opens it then, on the same UPI ID the payer was shown.

### 2.4 Another name: pause, and the deal goes on by bank transfer
"It shows a different name" asks what name it shows (`escrow_payment.report_name` for a client, `trader_order.report_name`
for a trader; the payer only, before it says it paid). The UPI ID is paused (`ACTIVE → PENDING_REVIEW`, with
`reported_name`, `reported_at`, `reported_by`, `reported_trade_id`) — nothing more is paid to it — and the deal moves to
a bank transfer to the payee's own account: the first bank rail of the amount whose time from the same start is still
open, or the slowest; its window is that rail's own (IX135 holds), not one of the payer's three changes. The owner is
told (`DESTINATION_PAUSED`; a trader is not shown the client's trade reference).

### 2.5 A person is asked only when a payer saw something wrong
The desk's queue is "UPI IDs paused by a payer": what the app showed, what was expected, on which deal. The person looks
the address up as before (ADR 0029 §2.2): the owner's own name puts it back with its full limits; another name rejects
it with a note the owner reads (`DESTINATION_REJECTED`).

## 3. Consequences

- A client is paid by UPI the minute it adds a UPI ID; no person is in the way of an ordinary deal.
- The protection moves to where it is real: the payer's screen, at the moment of paying, every time — plus a ₹25,000
  ceiling until one deal has shown the address is the payee's.
- A payer that ticks the box without looking takes that risk itself; the box is worded as what it saw, not as a formality.
- A payer paying from its own UPI ID is judged, as a sender, by that UPI ID's name — now the payer's own name from its
  record, never one typed beside the address.
- `upi_id_review_shape` no longer requires a reviewer for `ACTIVE`; 0051 makes 0050's waiting UPI IDs live and gives
  verified ones their confirmation.
- New: `upi_id.name_confirmed_*`, `upi_id.reported_*`, `p2p_pay_window.payee_name_confirmed_at`, transition
  `ACTIVE → PENDING_REVIEW`, inbox kind `DESTINATION_PAUSED`, error `UPI_NAME_UNCHECKED`. No new IX code.
