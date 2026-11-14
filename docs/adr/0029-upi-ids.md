# ADR 0029 — UPI IDs as payment destinations of their own

Status: **Accepted** — owner request of 2026-11-10 ("UPI IDs as independent payment destinations, separate from bank
accounts … registered VPAs instead of generated account+IFSC addresses; verification before live use, payment limits,
protect active deals"). Resolves TD-45. Builds on ADR 0018 (sender check), ADR 0019 (P2P escrow), ADR 0023 (time to pay
by rail), ADR 0026 (confirmation by another factor). Migration `0050`, schema 50. Nothing of the escrow, the ledger, the
deadlines or a bank account's own rules changes.

## 1. Context

A deal's UPI payment went to an address made up from the payee's bank account: `<account>@<ifsc>.ifsc.npci`. Nobody had
registered it, no person had looked it up, and whether payers' apps accept it in a scanned code was never tested (TD-45).
A trader that works by its UPI ID — as on every P2P board — had nowhere to enter one, and a client could not pay or be paid
by UPI without giving bank details. The payer's app showed whatever name that address happened to resolve to.

## 2. Decision

### 2.1 A UPI ID is a destination of its own
`upi_id`: a client's address (`name@handle`; never one ending `.npci`), the name its owner says a payer's app shows, a
label, and its own limits — one payment (₹1 to UPI's ₹1,00,000) and, optionally, a day. A client or trader has as many as
it wants, with or without a bank account. One live address belongs to one client (`upi_id_live_unique`). The address and
its owner never change; another address is another row.

### 2.2 Nothing is paid to one before a person verifies it
Added by the client's administrator (a sign-in or code in the last ten minutes is enough: it is used by nothing yet), it
is `PENDING_REVIEW`. A person at INRP2P (`client_bank:add`, ⧗) opens a UPI app, starts a payment to the address without
paying, and records the name it shows (`verified_name`). That name is judged word by word (`matchNames`, ADR 0018) against
the **client's own names on its record** — its legal and display names and the holders of its bank accounts — never
against the name typed beside the address, which whoever holds the session also typed. A match verifies it; a partial
match needs the reviewer's reason; anyone else's name is refused (`UPI_NAME_MISMATCH`) and the address is rejected with a
note the client reads (`DESTINATION_REJECTED`). The database refuses `ACTIVE` without a reviewer and a verified name.
One the desk adds itself is its own verification and is live at once. Every member is told when one goes live.

### 2.3 A deal is paid by UPI only to a verified UPI ID, within its limits, fixed for the deal
`dealPayOptions`: what the amount allows, among what the trader's side uses (`trader_block.rails`), and UPI only when the
payee — the trader of a client's BUY, the client of its SELL — has a verified UPI ID that can take this payment now
(`usableUpiId`: within its limit for one payment and what is left of its day, the oldest that fits). The UPI ID is fixed
when the buyer's time to pay opens (`p2p_pay_window.payee_upi_id`, IX146), under a lock per payee, so two deals opening
together are never both promised the last of a day. What a UPI ID took today is every deal opened on it in the Indian day,
unless cancelled or paid another way. Matching counts UPI the same way. No UPI ID, or none that fits: the deal goes by bank
transfer — never to a made-up address. The code, the app link and the screen carry the registered address and its
verified name, and the payer is told to check that name in its app before approving.

### 2.4 A payer may say it paid from its own verified UPI ID
`fiat_transfer.payer_upi_id` beside `payer_bank_account_id` — exactly one of them, the payer's own and verified (IX145).
The payee's confirmation judges the sender against that UPI ID's verified name (ADR 0018). A client with a verified UPI ID
and no bank account can buy (`PAYER_ACCOUNT_REQUIRED` accepts either); a trader paying a client may declare its UPI ID.

### 2.5 Active deals are protected
The client cannot archive a UPI ID a deal in progress is paid to, or one a payment still being confirmed was declared from
(`DESTINATION_IN_USE`). The desk can (a compromised address): the deal then offers a bank transfer instead. Changing its
limits needs a confirmation by another factor (ADR 0026); a deal already open keeps the address it opened with.

## 3. Consequences

- "Lands in the registered account" becomes, for UPI, "lands where a verified UPI ID of the payee's own points". A UPI ID
  resolves to the name of the account behind it; the name check is what binds it to the client.
- A person verifies every UPI ID a client adds. Until one is verified, the client's deals go by bank transfer.
- `accountUpiAddress` remains in the kernel for history and tests; nothing pays to it.
- New: `upi_id`; `p2p_pay_window.payee_upi_id`; `fiat_transfer.payer_upi_id`; inbox kind `DESTINATION_REJECTED`; errors
  IX145, IX146, `UPI_NAME_MISMATCH`.
