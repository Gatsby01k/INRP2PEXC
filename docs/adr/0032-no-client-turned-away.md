# ADR 0032 — No client turned away: a request nothing priced waits for a trader

Status: **Accepted** — owner's requirement of 2026-11-23: a client who wants to buy when no trader or liquidity is there
must not be left with one line of text after adding a bank account and a wallet. Migration `0055`, schema 55. Amends ADR
0028 §2 ("a request nothing prices honestly closes"). Nothing of the escrow, the ledger, settlement, the price's bounds or
the trader programme's rules changes.

## 1. Context

ADR 0028 made the exchange fully automatic: a request is priced at once, or put to traders, or — nothing pricing it
honestly — closed with a plain answer. On a young exchange the last case is common: few traders, sides switched off at
night, a size above every firm offer. The client had just done the hard part (signed up, added where it is paid, a wallet)
and read "No trader can take this amount right now. Ask again in a few minutes" — and left. Nobody on the other side ever
heard that someone wanted to deal. Demand was thrown away at the one moment it showed itself, and supply was never asked.

## 2. Decision

### 2.1 The request waits
What nothing prices stays OPEN and **waits** — `waiting_since`, `waiting_until` (+24 h), the reason it was not priced in
`no_price_reason`, and, when firm offers take some other amount, that amount in the client's words in `status_reason`. Only
an open request of the INRP2P exchange waits (`trade_request_waiting`). A client still has one live request: asking again
replaces it, as before. The request TTL leaves a waiting request alone.

### 2.2 The exchange keeps looking — and holds the price it finds
`waiting_requests_sweep` looks at every waiting request each minute, the oldest first. Whether anything prices it is seen
without locking a trader; only when it does are its candidates locked and it is priced exactly as a client asking would
be — same bounds, same minimum margin, same reserve limits — but **held for 10 minutes**, not 60 seconds: the client is not
on the screen, it is told by message and comes back to the price. The trader's capacity is held as long and a minute more.
A held price (`auto_quote.held`) is not learnt from: a client who was away says nothing about how a price is answered.
Priced, the request stops waiting; if the held price lapses, the client asks again itself ("Get a new price").

### 2.3 Everyone who can act is told
- **The client**, on the screen: "We're finding you a trader" — where it will hear (Telegram, email, here), until when, and
  what a trader takes right now. When the price is found: inbox, email and Telegram, "We found you a trader … held for you
  until 14:32 IST". When the day ends with nothing: "No trader took your request … Nothing was committed."
- **The traders** who could take it — approved, with that side on a P2P route, online or not, never the client itself —
  "A client is waiting for your price: someone wants to buy 30,000 USDT and no trader has a price for it" (inbox, email,
  Telegram), at most once each half hour; never who asks. The Traders home leads with the waiting demand on its sides
  (counts and an amount at the market — never a person) and one action: set my price. A missing market reading or network
  fee is the exchange's own, and no trader is bothered for it.

### 2.4 The final answer
`waiting_until` passed: the request closes DECLINED with its plain answer and the client is told — ADR 0028's ending, a day
later and after everyone who could help was asked. Automatic prices switched off while it waits: it goes to the desk's
queue, as every request then does.

## 3. Consequences
- No request is lost to a moment without supply; the traders see real demand when it exists.
- A trader's capacity may be held up to 11 minutes for a client who does not come back; it is the price of a price that
  is still there when the client reads the message.
- IX139 now allows a 600-second automatic quote when it is held; IX147 refuses one for a request that never waited.
