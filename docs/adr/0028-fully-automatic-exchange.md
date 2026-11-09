# ADR 0028 — The fully automatic INRP2P exchange

Status: **Accepted** — owner request of 2026-11-09 ("the automatic one, without crutches, properly"); the owner chose that
the client pays the deal's network as its own line. Builds on ADR 0019 (P2P escrow), ADR 0022 (GasFree), ADR 0024 (risk
limits), ADR 0025 (automatic prices). Migration `0047`, schema 47. Nothing of the escrow, the ledger, GasFree's sends, the
desks, their fees or the risk limits changes.

## 1. Context

ADR 0025 made a client's price automatic, but three things still sent a deal of the INRP2P exchange to a person — so with
automatic prices switched on, an operator still priced and routed most deals:

1. **A trader's rate was a fixed number.** A firm offer at a fixed number goes stale as the market moves, so it had to run
   out (1 hour to 7 days). Whenever no trader had renewed it, nothing was firm and every request waited for a person.
2. **INRP2P's own deal carried its network out of its margin** (FI-100). On GasFree that is 4.5 USDT a deal (activation and
   two transfers). With the client's price capped at the market, the spread a trader leaves rarely covers 4.5 USDT on a
   small deal: at 0.2% below the market a deal needed about 2,250 USDT before it could be priced at all.
3. **What could not be priced waited for a person** — no firm offer for the amount, none at the market, no bid, a stale
   reference. A person could do nothing the system could not: route to a trader (what a price request does) or quote above
   the market (what the policy's premium allows).

## 2. Decision

### 2.1 A trader's rate set against the market
A side's rate is the trader's own number (`rate_basis = 'FIXED'`, `rate_micro`) or set against the market (`'MARKET'`):
the confirmed reference of the deals the side fills — the bid for a side buying USDT, the ask for one selling (ADR 0025
§2.6) — moved by the trader's `market_offset_bps` (whole basis points, within ±10%), put on the rupee-paisa grid in the
trader's favour (up for a side selling USDT, down for one buying it), and held at the trader's own `rate_limit_micro` (a
side selling never sells below it, one buying never buys above it). `marketRateMicro` in the kernel; the database's
`inrp2p_market_rate_micro` is the same formula.

The reference must be fresh enough for the pricing policy to price on (`reference_max_age_seconds`). Without one, a
market-rate side has **no rate**: it is offered nothing, exactly as a side with no rate set.

**FI-01 amended.** Client, route and reference rates stay distinct fields. A route rate is derived from a reference in one
way only: a trader's standing instruction (offset and bound) applied to one confirmed reference, and every order at such a
rate records the reference snapshot and the terms it was derived from (`trader_order.rate_reference_snapshot_id`,
`rate_offset_bps`, `rate_limit_micro`). The database derives the rate again on insert and refuses one it does not get,
one on a reference of the other direction, one on terms the side no longer has, and one on a reference older than the
policy allows (IX143). An order keeps the rate it names: the market moving later moves the next order, never this one.

### 2.2 Firm until the trader turns it off
A market rate never goes stale, so only a market-rate side may be firm with no end of its own (`instant_open_ended`): it
stands while the side is active and the trader is in standing — online, its reserve covering it — and ends when the trader
turns it off, pauses the side, or goes back to a fixed number. A fixed number may still be firm for 1 hour to 7 days, as
before (IX142, which now also covers an open-ended offer's committer). Changing a side's rate terms withdraws the offers
made on the old ones (`RATE_CHANGED`), as changing a fixed rate always did.

### 2.3 The client pays the deal's network, as its own line
On INRP2P's own deal priced in USDT (GasFree), the client pays the deal's network — the allowance its escrow carries, today
4.5 USDT — as a line of its own: a client buying pays for its USDT and the network together and receives its USDT in full;
a client selling sends its USDT and is paid for it less the network. `computeP2pEconomics(…, { clientNetwork })`: the
client rate prices `base + network` (buying) or `base − network` (selling).

Nothing else moves. The network stays at the escrow inside the deal's USDT margin until the deal's transfers are settled at
what they cost (FI-101, FI-103); the margin identities, the escrow, the payout and the ledger are as before. INRP2P's own
margin is now the spread alone: `net = gross − network`, never below the minimum. `quote.client_network_base_minor` (and
the trade's copy, IX045) records it; on INRP2P's own deal priced in USDT it is the whole allowance, on a desk's deal never
(IX144) — a desk's side carries its own network (ADR 0022), and its client's amounts never change.

The client sees it said plainly: "Network fee 4.50 USDT — what TRON charges for this deal's escrow and its transfers. No
other fee: the rate is the market's." The rule is the same for a person's quote (`quote.create`) and the order a person
routes (`trader_order.assign` sizes the order with it), so there is one rule for every INRP2P deal.

### 2.4 Price requests on every miss
When no firm offer prices a request — none takes the amount, **or none takes it at the market** — and price requests are on,
the request is put to the traders who could fill it, those whose firm offer fell short included (ADR 0025 §2.4 asked only
when none took the amount).

### 2.5 Nothing waits for a person
With automatic prices on, a request nothing prices honestly closes at once — declined by the system, with why
(`trade_request.no_price_reason`: `NO_MARKET`, `NETWORK_UNKNOWN`, `NO_OFFER`, `NOT_COMPETITIVE`, `NO_BID`) and a plain
answer to the client as its reason: what happened and what it can do — for an amount no firm offer takes, the amounts they
do take now ("about 150 to 4,000 USDT"). A price request that ends without a price closes the same way and tells the client
in its inbox too. Nobody at INRP2P has it waiting on them; the record says why (`quote.auto_price_skipped`,
`request.declined` by `SYSTEM:auto_price`). With automatic prices off, every request waits for a person, as before — and a
price request whose award finds them switched off goes to a person, as every request then does.

### 2.6 What still needs a person
Disputes; a payee silent past its window; a sender name that does not match; a payout above the second-person threshold;
a send blocked by its cap. None of these is pricing or routing.

### 2.7 One price for a trader, and a way in that says what comes next (2026-11-09, migration `0048`)
A trader set its rate twice — on its sides for INRP2P's orders, and on its desk for its own clients, the second a fixed
number that ran out — and its way in hid its next step. Now:

- **A desk's price may follow its side** (`desk_price.basis = 'SIDE'`): the side's rate as it is now, its own number or its
  market rate, with no number and no end of its own; off while the side has no rate. A desk deal on it records the
  reference and terms its rate was derived from (IX143), like every order at a market rate. A desk opened by someone who
  can bind the trader starts with both directions priced this way (100 to 10,000 USDT a deal), as a draft.
- **The way in**: the Security Reserve is named with its amount before anyone applies; the application is three steps (the
  bank named from its IFSC, the holder from the applicant's name); the Traders screen then shows the four steps to a first
  order — application, reserve (sent first, from the registered wallet, which proves it), prices, online — each with its
  one action; and a first-start screen sets both sides against the market (shortcuts, or any percentage), their offers firm
  while online, and goes online in one press.

## 3. Consequences

- With automatic prices on and traders at market rates, the INRP2P exchange prices, routes and accepts every deal itself, at
  any size a trader's limits allow. The owner still switches it on (Rates → Automatic prices); traders choose "Follow the
  market" and "On until I turn it off" on their side.
- Clients pay a visible network line on every INRP2P deal (4.5 USDT today), and the market's rate. Desk deals are unchanged.
- A market rate's figure is known only with a fresh reference: the feed's health (ADR 0025 §2.6) now gates traders' rates,
  not only clients' prices. A stale feed stops automatic prices and market-rate sides together, and nothing is priced on
  a rate nobody can bound.
- Implementation: kernel `marketRateMicro`, `computeP2pEconomics` `clientNetwork`; `@inrp2p/pricing` `marketReferences`,
  `choosePrice` `clientNetworkMinor`; `@inrp2p/trader-core` `readBlocks(…, market)`, `standsBehind`; `@inrp2p/traders`
  `updateBlock` (`rateBasis`, `marketOffsetBps`, `rateLimit`, `firmOpenEnded`), routing; `@inrp2p/quotes` automatic quotes
  (market terms under the block's lock, price requests on every miss, `closeUnpriced`), `quote.create`, the client's quote
  view (`networkFee`); portal `noPrice`; web: the trader's side editor, the client's quote card and its no-price state.
- The client's receipt shows the trade's amounts and rate as frozen; the network is not yet its own line there (TD-44).
