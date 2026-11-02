# ADR 0025 — Automatic prices and the choice of trader on the INRP2P exchange

Status: **Accepted** — owner request of 2026-10-31. Builds on ADR 0019 (P2P escrow), ADR 0020 (desks), ADR 0022
(GasFree). Migration `0043`, schema 43. Nothing of the escrow, the ledger, GasFree, the desks or their 0.25% / 0.6% fee
changes. (ADR 0024 and migration 0043 are also used by the unmerged `claude/onboarding-risk` and PR #21: whichever lands
second renumbers its migration.)

## 1. Context

A client of the INRP2P exchange asked for a price and waited for a person: the desk routed the request to a trader, the
trader accepted, the desk typed a client rate, the client accepted. Every price was a person's guess at the spread, and
nothing the platform learned from accepted or declined quotes fed the next one.

## 2. Decision

### 2.1 What is chosen, and how
A client asks; in the same transaction the system weighs every price on the rupee-paisa grid against every **firm offer**
that can take the amount, and gives the one with the highest **expected net margin**:

    acceptance(price) × completion(trader) × net USDT margin(price, trader)

- **Net margin** is the kernel's P2P economics (`computeP2pEconomics`, FI-97): the USDT between the client's amount and the
  trader's, less — on GasFree — the deal's network allowance that INRP2P's own deal carries (FI-100). A price leaving less
  than the policy's minimum net margin (`network_fee_policy.min_net_margin_inr_minor`, in USDT at that price) is never a
  candidate; a negative one never is. Small amounts that cannot cover the network and the minimum are therefore left for
  a person.
- **Competitiveness** is a hard bound, not a weight: a client buying is never asked more than the market's ask, a client
  selling never paid less than its bid, moved by at most the policy's premium (`max_premium_bps`, default 0). That bound is
  the only place the market enters the price (FI-01 stands: the reference is never a client's or a trader's rate).
- **Acceptance** is learned only from INRP2P's own automatic quotes (`auto_quote` joined to the quote's outcome): accepted
  against declined (ran out, rejected, withdrawn while live — a quote the client replaced by asking again, or one INRP2P
  cancelled, says nothing), counted in price bands of `bin_bps` against the reference, per direction and per size band
  (under 1k / 10k / 100k / above, USDT), over `learning_days`. Laplace prior; a size band leans on its direction with the
  weight of two quotes; a better price is never less likely to be accepted (pooled adjacent violators). No evidence ⇒ even
  odds ⇒ the first prices sit at the market bound and keep the full spread the traders leave; declines move prices down;
  old evidence ages out, so higher prices are tried again.
- **Completion** is the trader's own record over the same window: completed against failed by the trader (an unfunded BUY
  escrow, an unwind, a dispute INRP2P decided against it), leaning on the network's rate with the weight of two deals.

Equal expectations go to the price better for the client, then the likelier trader, then the lower trader reference. No
elasticity, mark-up or market figure is assumed (`@inrp2p/pricing` `choosePrice`).

### 2.2 Firm offers
A trader makes a side's offer **firm** for 1 hour to 7 days (`trader.update_block` `firmHours`; `instant_until`,
`instant_set_by` — the member whose commitment it is; IX140): INRP2P then opens and accepts orders at its rate, within its
own order size and capacity and INRP2P's ceilings, without asking it each time — as a desk's live price already does
(ADR 0020). Pausing the side or going offline ends it; the trader's standing (approved, reserve funded, destinations
active, online, assignments on) is checked under its lock. A side also names the INR **rails** it pays or is paid by; a
trader is only priced on for amounts some of its rails can carry.

### 2.3 The firm price
One transaction (`autoPriceLockedInTx`): every trader a price could go to — and every trader whose order closes because
the client asked again — is locked first (request → quote → traders → orders → blocks), so nothing can hold capacity twice;
the chosen trader's order is opened, its capacity checked again under the block's lock and held until a minute after the
quote can no longer be accepted; the trader's rate is published as the route's snapshot; the quote is created at the chosen
client price with its frozen network terms, the decision recorded (`auto_quote`, IX137) and the quote sent for **60
seconds**. Acceptance is the ordinary `quote.accept`: it opens the trade and starts the order. Nothing about the price, the
trader or the economics changes after that (FI-03, IX045, IX073, IX075).

A client holds one live price: asking again replaces its open requests, their quotes and their traders' holds in the same
step. A price that ran out is asked for again in one tap (`request.reprice`).

### 2.4 Larger amounts: a price request to several traders
When no firm offer takes the amount and price requests are on (`pricing_policy.rfq`), the request is put to up to
`rfq_max_traders` traders in standing whose side is active and whose INRP2P ceilings allow it, the likeliest to complete
first, for `rfq_window_seconds` (`rfq`, `rfq_invite`, IX138). Each sees the side, the amount and when it closes — never who
asks — and bids one rate for the whole amount (`rfq.bid`; a new bid replaces the old one; none after it closes, IX139).
When every trader asked has bid, or the time is up, the bids are priced exactly as firm offers (INRP2P's ceilings and free
capacity, the market bound, the minimum net margin), and the best becomes the client's 60-second firm price; the others
lose. No bid that prices honestly — the request goes to a person. The client is told only that the best price for its
amount is being gathered, and until when.

### 2.5 What is never priced automatically
A desk's request (a desk prices its own deals, ADR 0020). A request while the programme is not P2P, while the market
reference of its direction is older than `reference_max_age_seconds` (judged by the business clock), or while the network's
fees are unknown. A request no firm offer prices within the bound with the minimum margin. In each case the request stays
open for a person exactly as before, and the record says why (`quote.auto_price_skipped`).

### 2.6 The market reference
The worker reads the USDT/INR books of two independent Indian exchanges (WazirX, CoinDCX) every five minutes and publishes
their median bid and ask as `REFERENCE` snapshots (`FEED:indian_books`) — only when both answer with uncrossed books within
2% of each other, and never a move of more than 5% from the last (left for a person: `rates.record_reference_rate`).
Global aggregators' "USDT in INR" is dollar-rupee without the Indian premium and is not a source.

### 2.7 The switch
`pricing_policy` is append-only; its first row leaves everything off. `pricing.set_policy` (`pricing:configure`, OWNER with
step-up) switches automatic prices and price requests on or off and sets the guard-rails; switching on is refused without a
fresh reference in both directions. Prices already given keep the policy they were made with.

## 3. Consequences
- No parallel engine: routing, trader orders, the quote, acceptance, the P2P escrow, GasFree, the ledger and the desks are
  the existing ones; automatic pricing is one more way a trader order is accepted and a quote is sent.
- The manual flow stays whole: with the switch off, or whenever nothing can be priced honestly, the desk prices as before.
- What INRP2P earns is still the USDT its escrow keeps; it is now chosen to maximise what is expected to be earned, and the
  choice is on record with every quote (`auto_quote`) and in its audit event (`quote.auto_priced`).
- Implementation: `@inrp2p/pricing` (`auto-price.ts`, `evidence.ts`, `policy.ts`), `@inrp2p/trader-core` (`reliability.ts`,
  firm offers in `readBlocks`), `@inrp2p/quotes` (`auto-quotes.ts`), `@inrp2p/traders` (`rfq.ts`, `updateBlock`),
  `@inrp2p/adapters` (`usdt-inr-price.ts`), worker `reference_rate_refresh` and `rfq_sweep`, handler `rfq_award`; web: the
  Exchange's instant price and "Get a new price", the trader's firm-offer switch and price-request card, the operator's
  Automatic prices panel on Rates.
