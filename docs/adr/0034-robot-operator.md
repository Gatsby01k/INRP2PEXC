# ADR 0034 — The robot runs the front line ("INRP2P Operator")

Status: **Proposed** — owner's brief of 2026-11-28: an autonomous, context-aware operator embodied by the robot, for
activation, recovery, liquidity discovery, support and admin intelligence; "maximum intelligence, minimum interaction";
deterministic wherever possible. Migration `0057`, schema 57. Nothing of the escrow, the ledger, settlement, pricing, a
dispute or a payment changes: the robot reads them and speaks; it never acts on money.

## 1. Context — what the brief asked, and what the code showed

The exchange already does a great deal by itself: it prices automatically (ADR 0025, 0028), keeps looking for a trader
when nothing prices a request and tells traders a client waits (ADR 0032), lets clients meet clients (ADR 0033), reviews
trader applications by rule (ADR 0024), and tells every side of a deal its move on the inbox, email, Telegram and push.
What it does not do — and what the brief is really about — is everything *between* those events:

1. **People stuck on their way in hear nothing.** Someone signs in and never opens an account; opens one and never adds
   where they are paid; is set up and never asks; applies as a trader and never sends the reserve; is approved and never
   sets a price. No event fires for any of these, so no message is ever sent. Each is a lost client or a lost trader.
2. **Demand that went unpriced is forgotten.** ADR 0032 tells traders while a request waits; once it ends, a trader who
   comes online an hour later never learns the client existed — and the client never learns the trader did.
3. **Liquidity the exchange already has is not asked.** A client who *sold* USDT here last week is exactly who a waiting
   buyer needs, and ADR 0033's book can meet them — if anyone told the seller.
4. **Nobody answers a question.** The bot replies "This bot only sends alerts" to anything typed; the workspace's only
   support is a `mailto:`.
5. **The desk cannot see any of this** — who is stuck where, what demand went unserved, what the system told whom.

## 2. Decision

### 2.1 One module, no reach into money
`@inrp2p/robot`, lint-bounded to `kernel, db, audit, commands, outbox, identity, adapters, notifications, pricing,
quotes, trader-core` — it cannot import settlement, onchain, treasury, trades, ledger or the traders' commands. It reads
the rows of record and writes only its own tables, the inbox, and its own audit events. A person at INRP2P switches it:
`robot_policy` (append-only; `robot:configure`, OWNER with step-up and a reason):

- **outreach** `OFF` / `DRY_RUN` (the default) / `ON`. A dry run decides and records every message exactly as it would,
  and sends none: the desk reads what it would have said before anyone switches it on.
- **answers** `RULES` (default) / `AI`, a **daily limit** of model answers (300), **quiet hours** in IST (22:00–09:00),
  and any **playbook switched off**.

In code the module is `robot`, not `operator`: "operator" already names INRP2P's own desk staff everywhere (the
operator app, `operator_user_role`), and to an Indian P2P user an "operator" is a merchant. To people it is simply
*the robot* — the product's own character ("the robot holds the USDT").

### 2.2 A person's journey, computed — never stored
`personFacts` reads one person's facts (one statement per concern, a handful in parallel); `journeyOf` turns them into a
stage on each of two tracks — the Exchange (`NEW_ACCOUNT`, `TRADER_LEAD`, `NEEDS_DESTINATION`, `DESTINATION_IN_REVIEW`,
`READY`, `PRICING`, `WAITING`, `PRICE_READY`, `UNMATCHED`, `IN_DEAL`, `ACTIVE`, `DORMANT`, `IDLE`) and the trader
programme (`FIX_BANK_NAME`, `RESERVE_DUE`, `IN_REVIEW`, `NO_PRICE`, `OFFLINE`, `LIVE`, `PAUSED`, `REJECTED`). Pure
functions: nothing to keep in sync, nothing that can disagree with the rows.

### 2.3 Playbooks: when a message is worth it, and in what words
Nine playbooks, each a stage, an audience, a schedule of attempts measured from when the stage began, a freshness (a
first message never wakes a stage older than it), and a `compose` that returns the words — or nothing, when there is
nothing true and useful to say:

| Playbook | Stage | Kind | Attempts (h) | Who hears it |
|---|---|---|---|---|
| `fix_bank_name` | applicant's bank in another name | service | 0.5, 48 | the trader's administrator |
| `send_reserve` | applicant, reserve not in | service | 2, 24, 72 | the trader's administrator |
| `set_prices` | approved, no price (with last week's real demand on its sides) | service | 1, 24, 72 | the trader's administrator |
| `apply_trader` | signed in from the trader page, never applied | service | 2, 72 | the person |
| `open_account` | signed in, no account | service | 2, 72 | the person |
| `add_destination` | account, nowhere to be paid | service | 1, 48 | the client's administrator |
| `first_request` | set up, never asked (today's real market rate) | service | 6, 96 | an administrator or acceptor |
| `supply_back` | last request ended unpriced ≤ 7 days ago **and a side online now takes that amount** | service | 0 | who asked for it |
| `come_back` | traded, away two weeks (their last deal, today's rate) | opportunity | 0 | an administrator or acceptor |

Attempts are counted per subject across the client (two administrators of one company are not both told), and only in
the current mode (a dry run never uses up the real messages). A figure in a message is a figure of record: the fresh
market reference, the person's own amount, last week's actual demand. With no fresh market reading, nothing that would
quote it is sent. Every message has one action: a page, often with its terms filled in (`/exchange?again=RQ-…`).

### 2.4 Contact: consent, restraint, one channel
- **Consent** (`robot_preference`, the person's own): `SERVICE` by default — only about what they started; `ALL` adds
  opportunities (someone waiting to buy what they sold, a comeback); `NONE` — nothing outside the app. Chosen in the
  robot's panel, by `/quiet` in the bot, by `/stop` (which now also stops the robot), or by the one-click link at the
  foot of every robot email (`/robot-quiet/{touch}.{token}`, a 192-bit token per email, only its hash stored; the page
  asks before it acts, so mail scanners stop nothing). "Not now" on a suggestion rests that playbook for 7 days.
- **Restraint**: never while the person is in the workspace (the robot shows it there instead); at most one robot
  message a day; never within three hours of anything else INRP2P told them; never in the quiet hours.
- **One channel** besides the inbox: their Telegram (alerts chat, or the Telegram an account was opened with), else their
  browser, else their verified email. A message that could not leave within six hours is dropped as stale.

### 2.5 Liquidity discovery
- `supply_back`: an unpriced request is recovered the moment a side online takes its amount (limits and free capacity at
  the market reference) — said as "a trader who buys that much is online now", never as a promise of a price.
- `demand_match`: when a request has waited ten minutes, people who traded the other way in the last 90 days, who asked
  for opportunities, have no request or deal open and are not traders, are told someone waits — at the price ADR 0033's
  book would meet them now (`bestPeerFor` on the request they would make, at the market, with their usual size), three
  at most per sweep. Only with clients-meet-clients on; never who waits.

### 2.6 The rounds
`robot_sweep` every ten minutes in the worker: one statement finds the few people with something possibly due (a stage a
playbook serves, recent, not written to in the last day, not opted out); only they are read whole; at most one message a
person; the database refuses a duplicate (`UNIQUE (user, playbook, subject, mode, attempt)`). It marks a touch **acted**
when its person moved past the playbook's stage — what the desk reads as the robot's effect — and deletes questions
older than 90 days. Off, or at night, it reads nobody.

### 2.7 The robot in the workspace
A small head in the masthead on every page: the landing robot's materials in a few vector shapes, its face on the visor
in LEDs — calm with an irregular blink, `^ ^` when something went through, a glance towards the page, three searching
dots, wide eyes, stars for a found price, hearts for someone coming back, a sleeping "z" while a trader is offline. It
never pops up; it reacts to what the person does on the page (the landing's cues) and lights its antenna when it has
something new (`seen_key`). Opened, it says the one thing that matters now — a deal waiting on them, a price waiting for
their yes, its own search, a step on their way in, or the market and their last deal — with one action, what it is doing
for them meanwhile, what it remembers (its last message, their last deal, the desk's answer), a question box, and their
consent. `/robot` is the same with room. No WebGL, no image; reduced motion stills it.

**Addendum (2026-11-28) — the robot at the client's side.** The stage's own robot speaks, in the first person, beside
itself: the Exchange (a hello on the first visit, the last completed deal with **Same again**, pricing, the wait with its
log), a desk's firm quote, and every step of a P2P deal with the deal's own record as its visor's log; and it guards the
five moments P2P money is lost — a screenshot instead of a bank credit, a payer who is not the buyer, a deal moved to
WhatsApp, a request to cancel after paying, the last minutes of a step. Pure over each page's projection
(`apps/web/src/app/(client)/_robot/speech.ts`); no new data, no new endpoint, no migration. Details and the full table in
`docs/ROBOT_BEHAVIOUR.md`. Its name, shown to people, is **Bhai** ("bro" in Hinglish); in code it stays `robot`.

### 2.8 Answers
Rules first: a dozen intents in English and Hinglish (status, a payment that did not arrive, rate, how to sell or buy,
fees, safety, time, limits, trader, account, greeting, thanks, help, a person) answered from the person's own state.
A secret offered in chat is refused. Documents and "a person" go to a person. What no rule knows goes, when the owner
switched answers to `AI` and today's limit is not spent, to a model (`ANTHROPIC_API_KEY`, `ROBOT_AI_MODEL`, default
`claude-opus-5-5` at low effort, JSON-schema output, server-side refusal fallback) with only a handbook of the product
and the person's facts in words — never an account number, an address or another person. Its answer is heard only if
every figure in it is one it was given; otherwise, or when it hands off, the question goes to a person
(`robot_case`, one open per person, a second question joins it). The desk answers on its Robot page (`robot:answer` —
OWNER, DEALER, SUPPORT); the answer reaches the asker in the inbox and where they asked. The robot never decides a
dispute, a payment, a review or a refund.

### 2.9 The desk's view (`/robot-desk`)
What to do now (deterministic recommendations: stale market, automatic prices off, demand on a side no trader offers or
nobody online, both sides waiting with clients-meet-clients off, applications or payout details waiting for a person,
open questions, outreach still off), the questions for a person with what the robot knew, who is stuck where and for
how long, demand waiting and unpriced with its reasons, liquidity online by side, every playbook's messages and how
many then acted, and the latest activity — dry-run messages included. `robot:view` for every role.

## 3. Consequences
- People stuck on their way in, clients whose request found nobody, applicants and new traders are followed up by rule,
  with consent, at most once a day — and the desk sees whether it works.
- Unserved demand reaches the liquidity that already exists: traders who came online, clients who sold before.
- The bot answers instead of refusing; a question it cannot answer reaches a person with its context, and comes back.
- Operating cost: one indexed statement and a few person reads every ten minutes; a model call only for a question no
  rule knows, capped per day, off by default.
- **To switch on** (owner): read the dry run on Robot, then *Switch outreach on*; optionally *Let a model answer too* with
  `ANTHROPIC_API_KEY` set on the web app. Deploy order as every migration: migrate to 57, web and worker of this release.
