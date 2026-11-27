# ADR 0033 — One book: clients meet clients, and nothing waiting is lost

Status: **Accepted** — owner's approval of 2026-11-27 ("1 и 2 вместе"), on the proposal "Единая книга". Migration `0056`,
schema 56. Amends ADR 0028 §2.5 and ADR 0032. Nothing of the escrow, the ledger, settlement, the trader programme's rules
or a desk's deals changes.

## 1. Context

A production case: two ordinary clients asked, the same hour, to sell 100 USDT at no less than ₹102 and to buy USDT for
₹10,000 at no more than ₹100. No trader was online. Both waited a day (ADR 0032) and were declined, each told on its own
channel — and neither heard that the other existed, ₹2 away. The code made that certain:

- the search (`candidates()`) reads only traders: a client's request is never a price for another client;
- the client's own price (`target_rate_micro`, "Target rate · optional") was stored and never read by automatic prices;
- a price held for a waiting client that lapsed put the request back to a plain OPEN request, in the desk's queue, which
  then expired silently a day later — the client lost both the price and its place;
- the end of a wait was a refusal with no way to go on, and "N traders know" counted traders who were asleep;
- a client's deal moments never reached its Telegram (TD-46) and there was no other instant channel.

## 2. Decision

### 2.1 The client's price is a bound, never the price
`trade_request.target_rate_micro` is the client's bound: a client selling is never given less, a client buying never
charged more. An automatic price the bound refuses is not sent; the request waits (`no_price_reason = 'OUTSIDE_LIMIT'`)
and the client sees the best price it could have now. The bound never sets a price: the price is chosen exactly as for a
client without one (ADR 0025) and only then checked against it — a generous bound is never exploited.

### 2.2 Nothing waiting is lost
- A price held for a waiting client (ADR 0032) that lapses returns the request to its wait, not to the desk: same place
  in line, same end; the client is told. A held price lapsing twice ends the held offers for that wait (the trader's
  capacity is not held a third time for a client who is away), but the search goes on.
- The wait's length is the client's: 1 hour, 24 hours (default), 3 days or 7 days from when it started waiting
  (`request.set_wait`). The end of a wait is still a plain refusal, but its message carries "Keep looking", which asks
  again with the same terms.
- The wait says what is true: traders online now with that side, and the best price another client waits at.
- A client away for two held prices is not held a third: it sees what is ready when it comes back and asks itself.

### 2.3 Clients meet clients (the peer book)
A waiting request of the INRP2P exchange is also a price for the other side — **a peer offer** — when its client may be
one: an ACTIVE client that is not a trader, with an ACTIVE bank account and an ACTIVE wallet of its own (where the
rupees and the USDT go back to), no peer pause, fewer than three strikes in seven days, and peer matching switched on
(`peer_policy.enabled`).

**The price of a meeting.** Two requests cross when the buyer's bound is at or above the seller's; a request with no bound
takes the market reference of its direction (a seller the bid, a buyer the ask). The deal's centre is the market's middle,
held inside the crossing range; INRP2P's fee — `peer_policy.fee_bps`, 25 by default — comes off it, half each side, but
never past either client's bound: when both are "at the market" INRP2P keeps at most the market's spread and both get the
market's rate. Rates are on the paisa grid, rounded in INRP2P's favour inside the range. The margin is never negative.

**The deal is P2P, as every deal.** The one who says yes first is the **taker**: its request is the trade's request, it gets
the quote and it is the trade's client. The other — the **maker** — is the route: a personal trader profile
(`trader_profile.status = 'PERSONAL'`), with a personal P2P route and one side per direction, created the first time its
client is a maker, carrying its own bank account and wallet. A PERSONAL profile is never part of the trader programme: no
approval, reserve, limits by reserve, online, blocks to edit, programme lists or demand pings. Its order is an ordinary
`trader_order`; the trade, the escrow, the time to pay by rail, the chat, a dispute, an unwind, the receipt and every
journal are the existing P2P code. Whoever's money is at risk still acts second (ADR 0019 §2.4).

**The network is split.** The escrow carries the whole allowance as always (FI-100); the taker pays half as its own line
(`client_network_base_minor`), the maker's side carries the other half in its USDT (`route_base`), as a desk's side carries
its own (ADR 0022).

**Size.** A meeting is for the smaller of the two amounts, in the taker's fixed unit; never below
`peer_policy.min_deal_usdt` (50), never above the lower of the two clients' peer limits — ₹25,000 per deal under 3
completed deals, ₹1,00,000 under 10, ₹5,00,000 after. Whatever is left of the larger request is not carried over in this
release: the meeting says the size before anyone says yes.

### 2.4 Who confirms
- The taker says yes by asking (a new request whose best price is a peer offer, accepted on the screen) or by **meeting**
  a price it was shown ("Buy at ₹102.26"). Its yes is for that rate and size and **stands for an hour**
  (`peer_match.taker_yes_until`).
- The maker is offered the order (`OFFERED`, until the taker's yes ends) and told by every channel it has. Its yes is
  "Start the deal" — the trader's own `trader_order.accept`. In that transaction the taker's quote is made and accepted on
  its standing yes (`quote.accepted_via = 'STANDING'`, the yes's user and time on record), and the trade opens. If the
  economics moved (a new network reading), the taker gets the quote held for ten minutes instead and is asked again.
- Nothing touches the chain until both said yes.
- A maker that declines ends the meeting with no strike; one that stays silent ends it at the taker's hour, its request
  is paused ("Still looking?", `peer_paused_at`) and it gets a strike. The taker keeps its place in line and keeps waiting.
- One live meeting per request. While it waits for its maker, neither request is priced elsewhere: the other client has
  its word for the hour. A trader's firm price for a request that is not in a meeting is offered as always — an instant,
  certain price comes before a meeting; a meeting serves what no trader prices.
- A meeting's quote whose taker's standing yes cannot be used (its rights changed, the network's fee was read anew and the
  amounts moved) is held ten minutes for the taker to accept itself; a start whose second step never ran is handed to the
  taker the same way by the peer sweep.
- When two waiting requests cross and neither is acting, both are told once ("A buyer is ready at ₹99.75"): the first to
  meet it is the taker. A request close to a cross (within 5%) is told the best other price once an hour at most.

### 2.5 Strikes and limits
`peer_strike` records a maker that stayed silent and a client whose peer deal unwound or was cancelled for its missed
step. Three in seven days take a client out of the peer book for seven days (it still gets traders' prices). A client
never meets itself, a client that shares a bank account holder or a wallet address with it, or its own trader.

### 2.6 Telling people
- Inbox kinds `PEER_MATCH_OFFERED` (maker: start), `PEER_MATCH_WAITING` (taker: waiting for the other side),
  `PEER_MATCH_ENDED`, `PEER_NEARBY` (a price close to yours), `WAITING_RESUMED` (a held price lapsed, still looking), and
  the client's deal moments `P2P_PAY_NOW`, `P2P_PAYMENT_SENT` reach Telegram now (TD-46 closed).
- **Web Push**: a client can turn on notifications in its browser (`push_subscription`, VAPID; `WEB_PUSH_*` env). Every
  kind Telegram gets is pushed too, with one link. Without the keys configured the option is not shown.

### 2.7 Event-driven search
A waiting request is looked at again the moment something could price it: a trader's side changes, a trader comes
online, the market reference is read, a meeting ends — not only by the minute sweep (`runWaitingSweep`), which stays as
the safety net.

## 3. What does not change
FI-77 (delivery before payment), FI-96 (rupees only from the payer's own account), FI-97 (one rupee amount, straight
between own accounts, margin in USDT), FI-98 (an escrow goes back only to who funded it), FI-03/FI-10 (frozen economics),
FI-06 (one live price per request), FI-108 for automatic prices, FI-110, the ledger and the audit trail.

Amended: FI-114/FI-100 (a peer deal's network is half the taker's, half the maker's side), FI-115 (waiting includes the
peer book; a lapsed held price returns to the wait), new FI-116..FI-118 (peer price within both bounds and the fee, the
maker's standing yes, the taker's standing yes).

## 4. Consequences
- Two clients with compatible needs meet without a trader; INRP2P earns its fee without one.
- A PERSONAL profile is a row of `trader_profile` that every programme query must leave out (`status = 'PERSONAL'` is never
  APPROVED or PAUSED, so the routing and pricing filters already do; lists and views filter it explicitly).
- The owner switches peer matching on (Rates → Clients meet clients); the fee and minimum are set there too.
- Implementation: kernel `peerMeeting`, `computePeerEconomics`; `@inrp2p/quotes` `peer.ts` (book, meeting, start,
  dissolve, strikes), the bound in automatic prices, `setWait`; `@inrp2p/trader-core` personal profile; notifications
  (kinds, Telegram, `web-push.ts`); web: the wait's best price and Meet, Match found / Start, the maker's deal page, push
  opt-in, operator switch; migration `0056`.
