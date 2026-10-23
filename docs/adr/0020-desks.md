# ADR 0020 — Desks: every trader runs its own exchange on INRP2P

Status: **Accepted (stage 1 complete, blocks 1–12)** — owner decisions of 2026-10-17: the concept "every trader is its own exchange,
liquidity is shared" (concept page, private artifact), fees of 0.25% on a deal a desk fills itself and 0.6% on a deal
the network fills for it (paid by the desk whose client it is; executors of network deals pay nothing), and — because the
platform has no TRX budget — the network fees of every P2P deal paid from the trader's own network deposit, never paid
back. Builds on ADR 0017 (rails), ADR 0018 (clean INR) and ADR 0019 (P2P escrow). Migration `0040`, schema 40, error
codes IX121–IX130, FI-99 (new), FI-90/FI-97 (revised).

## 1. Context

Every request of the INRP2P desk is priced by a person, and every client is INRP2P's to find. The owner has no Indian
company, no INR account and no marketing budget; independent P2P merchants, OTC desks and brokers in India already have
the clients. A desk turns a trader into an exchange of its own on INRP2P: a page and a link, its own prices and its own
clients, deals filled with its own liquidity through the escrow INRP2P already runs — and an explicit fee for INRP2P on
each deal, instead of a hidden spread.

## 2. Decision (stage 1: a desk fills its own clients' deals)

### 2.1 The desk
`desk` — one per trader: `handle` (the page `inrp2p.com/<handle>`: 3–30 lower-case letters, digits and inner hyphens,
never one of the site's own paths), name, description, status `DRAFT → LIVE ⇄ PAUSED`. Live only while its trader is
approved; the handle is fixed once it has gone live (IX121). Opening, naming and taking it live are the trader
administrator's (`ADMIN`); prices bind money and are set by whoever can accept quotes (`COMMIT`, D-01).

### 2.2 Prices
`desk_price` — append-only, per client direction (`SELL_USDT`: what the desk pays for a client's USDT; `BUY_USDT`: what
a client pays for it), with the smallest and largest deal and a `valid_until` (1–168 hours, 24 by default): a desk that
stops updating stops trading on stale prices. A direction the desk has no side for cannot be priced.

### 2.3 Clients
`desk_client` — whose client a client is: source (`PAGE`, `LINK`, `INVITE`), `ACTIVE`/`BLOCKED`, the desk's own limit per
deal, a note. A client may be the client of several desks; a desk never has its own trader as a client (IX122). A
request placed with a desk (`trade_request.desk_id`, insert-once) comes from one of its active clients while it is live
(IX123), is filled by that desk alone (IX124), never enters the INRP2P dealers' queue or routing, and emits
`desk_deal.requested` instead of `desk.new_request`.

**Managing them (`desk_client.update`, block 3).** Whoever can commit for the desk blocks or unblocks a client, sets its
own limit on one deal with it (in USDT; checked on every desk deal) and keeps a note the client never sees. Blocking
withdraws what the client is asking at once — its open requests at the desk, live prices from the page or a link, and the
capacity they hold — closing every order in one pass in the global lock order; deals already accepted run to their end.
`deskClients` lists them, the most recently active first, with completed deals, their USDT, open deals and whether the
client holds a price right now — from this desk's books only.

**Their first destinations (D-20).** A client who came through a desk sets up where it is paid without an authenticator:
its first bank account and first wallet are confirmed by a sign-in by email code in the last ten minutes (SECURITY §2.2).
Any further one, and every archive, still needs the authenticator. The screen for it comes with the client's deal flow.

### 2.4 Economics (FI-99)
A desk deal runs P2P on the desk's own route (ADR 0019): one rupee amount, straight between the client and the desk, at
the desk's own rate (`route_rate = client_rate`), rounded against the client. The desk's USDT differs from the client's
only by the platform's fee — the fee policy's basis points of the client's USDT, rounded **up** (the desk pays):

| | client | desk | INRP2P (USDT, at the deal address) |
|---|---|---|---|
| client sells | sends `base`, receives ₹ `inr` from the desk | pays ₹ `inr`, receives `base − fee` | `fee` |
| client buys | pays ₹ `inr` to the desk, receives `base` | receives ₹ `inr`, delivers `base + fee` | `fee` |

The fee is the deal's whole margin (`gross_margin_base = platform_fee_base`), frozen with the quote and the trade
(`platform_fee_bps`, `platform_fee_base_minor`, IX125 / IX045), and realized at completion as `REVENUE:PLATFORM_FEE`
(USDT). Example: a client sells 10,000 USDT at ₹100.90 → ₹1,009,000 to the client, 9,975 USDT to the desk, 25 USDT fee.

### 2.5 Fee policy
`fee_policy` — append-only: `own_deal_bps` (25) and `network_deal_bps` (60, for stage 2). A change names a second
person (`approved_by ≠ set_by`); only the migration's first row has none. A change is proposed and approved on Desks →
Fee (§2.17). A desk quote must carry the policy in force when it is created (IX125); a later change never touches a quote
or trade already priced.

### 2.6 Network fees: the trader's deposit (FI-90, FI-97 revised)
The platform has no TRX budget for P2P deals. Every P2P quote — a desk's or the INRP2P desk's through a trader — is funded
by the route's trader (`quote_network_fee.funder_trader_id` = the route's trader, IX103): its network deposit holds the
deal's transfer and a return of the escrow from acceptance, every send of the deal draws on it (bearer `TRADER`), and
nothing is paid back when the hold closes. The estimated fee is still frozen with the quote; the platform's net margin is
its USDT margin itself. A trader that cannot cover a deal is not offered one (`NETWORK_DEPOSIT_SHORT`) and a desk without
enough TRX gets no deal (`NETWORK_BUDGET_INSUFFICIENT`). A refund of a P2P deal cannot be borne by the platform.

### 2.7 A desk deal's quote (`quoteDeskDealInTx`)
No person at INRP2P prices a desk deal. The desk committed to it in advance — by its live price (a client asking on its
page) or by the rate of a deal link — so one step opens and accepts the desk's own order at the client's rate (capacity
held, a TRADER rate snapshot published as for any accepted order), creates the quote with the fee and the network terms,
and sends it. The client accepts it like any quote. The desk must be in a trader's full standing — approved, its Security
Reserve set and funded, its registered bank account and wallet active (`switchOnIssues`, now in `@inrp2p/trader-core`;
the INRP2P desk's own routing switches `OFFLINE` and `ASSIGNMENTS_DISABLED` do not apply) — within INRP2P's ceilings on
the trader (single order, total capacity), and its network deposit must cover the deal. The capacity is held until a
minute after the quote expires, not for the programme's hold. The client is told only that the desk cannot deal now.

### 2.8 The instant price (`desk_deal.request_quote`)
A signed-in client on a desk's page asks for a price in one step: it becomes the desk's client (source `PAGE`) unless the
desk blocked it, a request is opened at the desk, and a firm quote on the live price comes back, valid for 60 seconds. A
client holds one price per desk: asking again replaces the earlier request, its quote and its capacity in the same
transaction (locks taken request → quote → trader → order → block), so asking repeatedly can never hold a desk's
liquidity. The page's calculator (`previewDeskDeal`) shows the amounts at the live price without holding anything.

### 2.9 Deal links (`desk_deal_link`)
A desk member who can commit makes a link for one deal: direction, amount (USDT or INR), the desk's rate, 5 minutes to 7
days (an hour by default) and a label only the desk sees. The secret is handed out once; only its hash is stored. Anyone
holding the link sees the desk, the rate and the exact amounts the client sends and receives — never the desk's USDT or
the fee (`deskDealLinkView`). The first signed-in client to take it is the only one who ever can (IX126); taking it makes
it the desk's client (source `LINK`), opens the request from the link (`trade_request.desk_deal_link_id`, channel `LINK`)
and returns a firm quote at the link's rate (IX126 checks the rate), valid as long as a link quote (180 s). Taken again
while the quote is live, it returns the same quote; after it lapsed, a fresh one. A link becomes one trade at most. The
desk can revoke a link before it became a trade: a live quote from it is cancelled and its capacity given back.

### 2.10 The desk's public page (`deskPage`)
`inrp2p.com/<handle>` shows the desk's name, description, live prices with their limits, and its record from the books —
completed deals and their median time. Nothing about its clients, volumes, its own USDT or the fee. A draft desk has no page.

**The pages (block 6).** On the public host only, server-rendered, with one island:
- **`/<handle>`** — the desk's storefront: its name and status, what it says, its record (deals completed, usual time, on
  INRP2P since), the escrow in one sentence, and a **ticket**: sell or buy, an amount in USDT or rupees, what the client
  sends and receives at the live price — rounded against the client exactly as the quote will be — and the desk's limits.
  It holds nothing: "Sell/Buy with <desk>" goes to the client app (`/desks/<handle>?direction&fixed&amount`), where the
  client signs in and asks for the firm price (block 7). How a deal works, in three steps. Indexed while the desk is live
  (in the sitemap: `liveDeskHandles`), not while paused; INRP2P appears as "Escrow by INRP2P Exchange", never as a
  competing offer.
- **`/d/<token>`** — a deal link as its holder sees it (`deskDealLinkView`): the desk, "Sell 2,500 USDT for ₹261,750",
  both legs, the rate and a countdown to the link's expiry; taken, done, expired or revoked links say so and point to the
  desk's page. "Sign in and take this deal" goes to the client app (`/d/<token>`, block 7). Never indexed, no referrer,
  30 opens a minute per address; an unknown token is "not found".
- **Routing.** One segment in a handle's shape that is not a site page and not reserved is rewritten to
  `/public-desk/<handle>` (like `/home`); arriving at the inside of the rewrite is sent back to `/<handle>`. Reserved
  names — the site's, the app's and the desk's own paths — live in the kernel (`RESERVED_DESK_HANDLES`), so the router
  and the desk commands share them, and the database holds the same list (a test keeps them equal); they keep the gate they
  had. On the client and desk hosts these paths are what they were.

### 2.11 The team (`client_invite`, block 4)
A desk's people are its trader client's users, so the team is the client's — any client has one. An **administrator**
(`CLIENT_ADMIN`) runs the desk: its page and status, the team, where it is paid. An **operator** (`CLIENT_TRADER`) works
the deals: prices, deal links, clients, orders. Both can bind the client (`can_accept_quotes`, D-01).

- **Invite.** An administrator invites an email as an administrator or an operator (`client_invite.create`). It is emailed
  once (`client_invite.send`) and carries no secret: the person signs in with that email — the code to it is the only way
  in — and accepts (`client_invite.accept`). Seven days to accept; inviting the same email again replaces the waiting
  invitation; at most 20 wait at once. Whether an email already has an INRP2P account is not revealed to the inviter.
- **One person, one account.** An email that already has an account of its own cannot join another team — the person asks
  for an invitation to a different email. Someone removed from a team comes back on their old sign-in when invited again.
- **Change and remove.** An administrator makes another member an administrator or an operator
  (`client_user.set_team_role`), or removes them (`client_user.remove`): they can no longer act for the client, their
  sessions end at once, and the invitations they made are withdrawn (as when an administrator becomes an operator). No
  administrator changes or removes themselves, and team changes are serialized on the client, so a client always keeps an
  administrator — two removing each other at once leaves one.
- **Confirmation.** Inviting, changing a role and removing need the administrator's fresh authenticator code (SECURITY
  §2.2); withdrawing an invitation takes no one's authority and needs none.
- **Everyone hears.** Each join, role change and removal is told to the whole team in the inbox and by email
  (`TEAM_CHANGED`), without anyone's address — the Team screen shows who.
- **The database (IX127):** an invitation comes from an active administrator of an active client, and is accepted before
  it expires by the person it names — an active, verified user of that client with its email. Invitations are never deleted.

### 2.12 The desk's workspace (block 5)
In the client workspace, under **Desk** (`/desk`, in the sections for a trader that is approved or paused). Not a trader:
Traders, where it starts. A trader without a desk: the way to open one (its administrator). Then six sections:

- **Today** — whether a client on the page can get a price, as a checklist with the next thing to do (approved, Security
  Reserve, verified bank account and wallet, liquidity, TRX for the network, live prices, the desk live); the deals
  waiting on the desk, the most urgent first, each with what to do and until when; turnover over today (India's day),
  seven and thirty days — completed deals, their USDT and INRP2P's fees, from the trades; both prices with the spread;
  what the desk can fill and how many deals its network deposit covers; the rest of what is open. Read again every 8 s.
- **Deals** — open (a price a client holds, or settling) and completed, newest first, and the links it sent, revocable
  while they stand. A deal's page is its order's steps (escrow, rupees, confirmation) under the deal in the desk's words.
- **Prices** — both sides with limits and an example of what a client gets and what the desk keeps; "Prices live" turns
  the page's prices on or off in one step; prices are held 6 h to 7 days.
- **Clients** — searchable, with each one's deals and volume with the desk; a client's own limit, a note, block/unblock.
- **Team** — §2.11 (the same screen as Account → Team).
- **Page** — the page as a client sees it, its name, description and address (while a draft), going live and pausing.

**New deal** (Today, Deals) makes a deal link in one sheet — which way, how much (USDT or rupees), the rate (the live
price to start from), how long, for whom — with each side's amounts and the fee worked out as the quote will price them,
then hands the link out once: copy, WhatsApp, Telegram, the phone's own share.

A desk deal is its trade: completed or cancelled the moment the trade is, whatever the order's sweep has caught up with.
The desk's projections (`deskWorkspace`, `deskToday`, `deskDeals`, `deskDeal`, `deskPricing`) show its clients' names —
they are its business — and never INRP2P's side of a deal: `assertDeskSafe` refuses those keys, as `assertTraderSafe`
does for a trader's screens.

### 2.13 The client's deal (block 7)
In the client app, signed in. The public pages' buttons lead here; a person who is not signed in signs in and comes back
(the proxy keeps the path in `?next=`, accepted only as a path on the same host — `safeReturnPath`), and a person with no
account opens one and comes back the same way.
- **`/desks/<handle>`** — the desk's prices, the amount (USDT or rupees, prefilled from the page), where the money lands
  (the client's own active bank account or wallet), "Get a firm price" (`desk_deal.request_quote`), then the firm price
  with its countdown (60 s) and "Accept" (the ordinary in-app `quote.accept`) → the trade's page, where the P2P steps run.
  The price the client holds is the server's (`clientDeskState`), so a reload shows it again; a lapsed one is renewed in
  one tap. A blocked client is told so. Beside it, the desk and the client's deals with it.
- **`/d/<token>`** on the client host — the deal, where the money lands, "Take this deal" (`desk_deal_link.claim`), the
  firm price (180 s) and "Accept"; someone else's, expired or revoked links say so; once it is the client's trade, the
  link leads to it (`clientLinkState`).
- **First destinations** — with no bank account (or wallet) yet, the deal offers to add one in place; the sheet skips the
  authenticator for a first one and, when the sign-in is older than ten minutes, asks for a code to the client's own
  email right there (D-20). Everywhere else the sheet does the same for a first destination.
- **"Desks"** (`/desks`, in the sections once the client deals with a desk) — its desks with their live prices and the
  client's dealings with each (`clientDesks`).
- A desk's price is not the INRP2P Exchange's: its request is left out of the Exchange screen, and "your quote is ready"
  or "it expired" is not sent for it — the client is looking at it. Its trade is told like any other.

### 2.14 Alerts in Telegram (block 8)
One INRP2P bot. A person links **their own** chat: "Connect" (desk Today, or Account) issues a one-time code — 128 bits,
only its hash kept (`telegram_link`), fifteen minutes — inside a `t.me/<bot>?start=<code>` link; pressing Start sends it to
the bot, whose webhook (`/api/telegram/webhook`, public host only, Telegram's secret header checked in constant time,
private chats only, 20 updates a minute per chat) links the chat (`telegram_link.complete`, run as the system) and answers
in words. `/stop` in the chat or "Disconnect" in the workspace ends it; a chat that blocks the bot is let go at the next
send. A chat never authenticates anyone and can only receive.

What the people of a trader's client hear, composed from the rows (a desk's deal names its client; a programme order names
nobody): a desk's **new deal** (`trader.order_started`) — with "put the USDT in escrow" when the client buys; **your move**
— pay the client once its USDT is in escrow (`desk.payout_actionable`), confirm the client's rupees after its "I paid"
(`desk.client_payment_claimed`); a **deadline** ten minutes before the trader's P2P step runs out (worker
`telegram_deadlines`, every minute, `ordersDueSoon`); **done** and **cancelled**. A programme trader also hears of a new
order to accept. Each alert to each chat is one `telegram_delivery` row with a derived id — a redelivered event sends
nothing new — SENT only with Telegram's message id, FAILED when refused or after eight attempts. The button opens the deal
(`/desk/deals/<ref>`) or the order, over https only. No bot configured: nothing is offered and nothing is sent.

### 2.15 Disputes and unwinds (block 9, TD-35)
For every P2P deal — a desk's own and the programme's alike (ADR 0019). The rupees are received by the seller of the USDT
(the trader on a client's BUY, the client on its SELL), and only the seller can say they did not arrive.

- **"It hasn't arrived".** While a payment waits for its payee's confirmation, the payee says what its bank shows
  (nothing, a different amount, something else) and may write a note (`escrow_dispute.open` for a client,
  `trader_order.dispute` for a trader). One dispute per payment, ever (`p2p_dispute`, IX128). The deal stops at once: a
  blocking `P2P_DISPUTE` case holds the trade, the payee's window stops running, and the case that waited for the payee
  (`P2P_RECEIPT_OVERDUE`) is superseded. The buyer adds its side — the UTR, the time, the account it paid from
  (`escrow_dispute.answer`, `trader_order.answer_dispute`). Each side sees that there is a dispute and its own words;
  the other side's words go to INRP2P only — they could carry a phone number past the desk's client relationship.
- **INRP2P decides** (`escrow_payment.decide`, `exception:resolve` plus the outcome's permission) a payment that is
  disputed or that its payee never answered, from the payee's bank, never from a screenshot of the payer's:
  - *paid* — with the sender as that bank shows it, checked like the payee's own confirmation (`via = DESK`; a partial
    match is accepted on the decision's evidence, a stranger is refused): the payment counts and the escrow releases;
    `settlement:confirm_incoming` (BUY) or `settlement:confirm_payout` (SELL);
  - *not paid* — `trade:cancel`: on a BUY the client's payment fails inside the cancel and the trader's USDT goes back
    from the escrow (`ESCROW_RETURN`, §2.8 of ADR 0019); on a SELL the trader's payment fails (no replacement leg) and
    the deal unwinds.
  A payee who finds the money after all still confirms it: the dispute closes as paid by the payee. The dispute case
  closes only through the decision — never by a resolution note.
- **Unwind** (`p2p_unwind`, IX129): a client's SELL whose trader did not pay in its 30 minutes — no case for a person any
  more — or that INRP2P decided not paid. From then on the trader cannot file a payment (the database refuses it too).
  Autopay returns every USDT of the client's from the deal address to the registered wallet it came from (a
  `REFUND_TO_CLIENT` leg, `refund_kind = UNWIND`, signed by the exchange's signer, paid by the trader's network deposit,
  over the approval threshold approved by a second person on the Network page); once it is final the trade is cancelled
  (`runUnwindClosing`, the desk's refund-and-cancel). When the signer cannot — an address it does not hold, a sender the
  client never registered — the unwind waits with its reason and a `P2P_PAYMENT_OVERDUE` case for a person.
- **Who is told.** Both sides, in their inboxes (`P2P_DISPUTE_OPENED` to the payer, `P2P_DISPUTE_DECIDED`, `P2P_REFUND`),
  by email for clients, and in Telegram for the trader's people (§2.14): one event per side, `p2p.*` and `trader.p2p_*`.
- **Screens.** The client's trade and the desk's deal share one block (`P2pDispute`): "It hasn't arrived" folded under
  the confirmation, "With INRP2P" while it is decided, the buyer's "Add your side"; a desk's deal lists show *With
  INRP2P*. The operator's trade workspace leads with **P2P payment**: the payment as filed, both sides' words, the
  decision with its evidence, and how an unwind's return stands.

### 2.16 INRP2P's earnings off the deal addresses (block 10, TD-31, TD-36)
A completed deal's USDT margin — a desk's deal, the platform fee; INRP2P's own deal, its margin — is realized in the books
at completion and stays at the deal address its money moved through. The signer moves it:

- **Sweep** (`FEE_SWEEP`): from a deal address no trade uses (not `ASSIGNED`), every completed trade's earnings there in
  one transfer, to the platform's **revenue wallet** (a `treasury_wallet` of role `REVENUE`, one active, registered
  watch-only — an address INRP2P holds the keys of). Each trade's part is earmarked from its own sources at the address:
  only a completed trade whose route obligation is over and no case open, never more than its USDT margin less what was
  swept (IX130, `inrp2p_trade_sweepable`); a cancelled trade's money is never anyone's earnings. The send's amount is
  exactly its earmarks (IX086); it names the latest of those trades for its lock. Books: Dr `ASSET:TREASURY_USDT:{revenue}`
  / Cr `ASSET:TREASURY_USDT:{pool}` — nothing is earned or owed by moving it. The scanner knows the transfer for the
  signer's own and does not park it in suspense.
- **When**: autopay plans a sweep once an address holds at least the policy's minimum (`fee_sweep_min_usdt_minor`,
  default 20 USDT, `fee_sweep_enabled`), only while the **platform's** TRX budget has a transfer's worst case free; the
  top-up is the platform's spend. Short of TRX, it waits — no case, nothing lost. A person can sweep any free address now
  (`fee_sweep.plan`, `network:manage`).
- **Reclaim** (`TRX_RECLAIM`, TD-31): the TRX a deal address's transfers did not burn goes back to the budget wallet once
  the address has been idle for an hour and holds at least `trx_reclaim_min_sun` (default 1 TRX). Each funder is credited
  what it topped up for its own transfers there and was not burned (`RECLAIM` entries of the budget, `splitReclaim`); TRX a
  trader was already paid back in rupees, and anything untraceable, is the platform's.
- **Revenue** (operator, `/revenue`, `pnl:view`): earned in the period (platform fees, INRP2P margins), where it is (at
  deal addresses, worth sweeping now, in the revenue wallet), TRX spent on sweeps and reclaimed, recent sweeps, platform
  fees by desk; registering the revenue wallet and the sweep policy live there too.

### 2.17 INRP2P's desk over the desks (block 11)
INRP2P decides about a desk, never about its deals: nothing here touches a deal already accepted — it settles, and its
disputes are decided on its trade, as before. Every decision carries a reason (10+ characters; optional for lifting or
showing again), is audited on the desk (`desk.suspended`, `desk.resumed`, `desk.page_hidden`, `desk.page_shown`,
`desk.renamed`) and is told to the desk's people in the app and in Telegram (`trader.desk_moderated` → `DESK_NOTICE`),
with the reason as INRP2P wrote it. Commands: `desk.suspend`, `desk.resume`, `desk.hide_page`, `desk.show_page`,
`desk.rename` (`desks:moderate`, step-up); `fee_policy.propose`, `fee_policy.withdraw` (`fees:propose`),
`fee_policy.decide` (`fees:approve`, step-up).

- **Suspend** (`SUSPENDED`, from draft, live or paused; `suspension_reason`, `suspended_at`): no new deal at once — the
  desk's open requests are withdrawn with their prices and orders, links cannot be taken, every quote path refuses
  (`DESK_NOT_LIVE`). Its page still opens, as *not taking deals*. The desk cannot take itself live; **lifting** returns it
  to `PAUSED`, and its people take it live again when ready.
- **Hide the page** (`page_hidden_reason`, `page_hidden_at`): its address answers *not found*, it leaves the sitemap;
  clients, links and deals are untouched. When the desk changes its name or words while hidden, Desks shows it for review
  (*Page changed — review*, a count on the nav); **showing** it again puts the page back as the desk has it now.
- **Rename**: a new name or address for a desk whose own does not belong. A live desk's address is otherwise fixed
  (IX121); INRP2P's rename sets `handle_moderated_at`, the only way IX121 lets it change. The old address stops working.
- **Fee** (`fee_policy_proposal`): one person proposes new bps with a reason; another approves (inserting the
  `fee_policy` row with `set_by` = proposer, `approved_by` = approver) or rejects it; the proposer can only withdraw.
  One proposal open at a time, and one that changes nothing is refused; the proposer deciding its own is refused with
  `SECOND_APPROVER_REQUIRED`.
- **Screens.** Operator **Desks** (`/desk-ops`, `desks:view`): every desk with its state, clients, open deals, 30-day
  volume, fees and open disputes — suspended and changed-since-hidden first; open P2P disputes oldest first, each opening
  its trade; the fee with its history and the proposal waiting. A desk's page: its profile and prices, latest deals,
  INRP2P's decisions, and the record of every one. The desk sees each decision in force as a notice on Today and Page;
  suspended, its readiness checklist and *New deal* say why instead of offering to go live.

### 2.18 The release (block 12)
- **End to end, both ways** (`apps/web/e2e/desks.spec.ts`, project `desks`): a desk on a desktop and its client on a
  phone, in one run, on the exchange's own rails — deal addresses derived from an HD account, the signer and a TRON
  network inside the test, its own database and server. The desk sends a link; a new client signs up from it, adds its
  bank account by its sign-in code, takes the deal and sells 1,000 USDT; the desk pays the rupees, the client releases the
  escrow, the signer pays the desk 997.5 USDT and 2.5 stay as INRP2P's fee. The same client then buys 500 USDT on the
  desk's page: the desk funds the escrow with 501.25, the client pays and the desk releases it. The desk's turnover and
  INRP2P's fees read from the books. Every move a person makes is made in the browser.
- **Pages**: Desks, one desk and Revenue join the page captures (53); the new baselines are recorded only by the
  canonical workflow.
- **Production**: the release order from schema 37 is DEPLOYMENT §14.0, rehearsed on a copy of production's rows.

## 3. Not part of stage 1
Evidence files (a statement attached to a dispute) — later. Network fills (one hop to another desk, the 0.6% fee, desk
earnings) — stage 2.
