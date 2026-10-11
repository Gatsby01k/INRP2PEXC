# INRP2P Exchange — Runbooks

What to do when something is wrong, written for the person who has just been woken up.

Every runbook has the same shape: **what you were told**, **what to check first**, **what to do**, and **what
never to do**. The last section is not padding — most of the ways this system can lose money involve someone
doing something reasonable-sounding under pressure, and those are named here so the answer is already decided
when nobody is in a state to decide it.

Two rules apply to all of them:

* **Nothing is fixed with SQL.** Every state change in this product goes through a command that authorizes
  itself, locks its own rows, posts its own journal and writes its own audit event. A row edited by hand is a
  row the ledger, the audit chain and the invariants all disagree with, and the disagreement surfaces days
  later as a number nobody can explain. If a situation seems to need direct SQL, it needs a new command and a
  review, not a `psql` session at 3am.
* **A trade that is paused is safe.** Holds exist so that the desk can stop and think. Leaving a trade on hold
  for an hour while you work out what happened costs a client an hour; releasing it on a guess can cost them the
  trade.

The alert definitions that point here live in `packages/desk/src/health.ts`, with the threshold for each
signal; a unit test keeps the two files in agreement, so every alert has a runbook and every runbook is reachable
from an alert.

---

## ledger-imbalance — the ledger does not net to zero

**What you were told.** `ledger_imbalance` is above zero. It is the only check whose warning threshold is zero,
because the correct value is zero and always has been.

**What to check first.**

1. `select * from ledger_global_imbalance;` — which currency, and by how much.
2. Which journals are unbalanced:
   ```sql
   select j.posting_key, e.currency,
          sum(case e.direction when 'DR' then e.amount_minor else -e.amount_minor end) as net
   from ledger_journal j join ledger_entry e on e.journal_id = j.id
   group by j.posting_key, e.currency having sum(case e.direction when 'DR' then e.amount_minor else -e.amount_minor end) <> 0;
   ```
3. `select * from audit_event order by seq desc limit 50;` — what was happening when it appeared.

**What to do.** Treat this as a defect, not an incident to clear. The database refuses unbalanced journals with
a deferred constraint (FI-41), so a non-zero result means either a constraint was dropped, a restore brought in
rows from a torn dump, or someone wrote to the ledger outside a command. Stop financial mutations (disable the
affected operator accounts rather than the app — a desk that half-works is worse than one that is plainly
down), capture the imbalance and the journals above, and escalate to engineering. The trades themselves are
still described correctly by `settlement_leg` and `fiat_transfer`; the ledger is the derived record, so the
business can be reconstructed from the movements once the cause is known.

**What never to do.** Do not post a balancing journal to make the number go to zero. That converts a
recoverable inconsistency into a permanent lie, and the original cause stays where it is.

---

## stuck-usdt-confirmation — USDT is not being detected or confirmed

**What you were told.** `scanner_lag_seconds` is above its threshold, or a client says they sent USDT and the
trade still shows nothing.

**What to check first.**

1. The USDT screen: it shows the scanner's block cursor, when it last ran, and whether that run could prove its
   whole window read. A cursor that is not moving while the scanner runs is a window it cannot prove — the notice
   says why (an interrupted page, a receipt a provider could not produce, a provider down); `scanner_block_lag`
   counts how far the cursor trails the solidified head. A cursor that moves with nothing found is a quiet day.
2. Is the worker process running, and is `outbox_oldest_pending_seconds` also climbing? Both climbing means the
   worker; only the scanner means the provider.
3. The transaction on a block explorer: does it exist, is it final, and is it to **that trade's own address**?

**What to do.**

* **Provider trouble.** The scanner reads through two providers and confirms against both (D-05). If one is
  down, the second keeps it running; if both are, that is `provider-outage` below.
* **The transfer exists and is final but the trade does not show it.** Check the address: attribution is by
  address only (D-02, FI-26), so a transfer to an address that was never assigned to this trade is not this
  client's deposit no matter what they say. It will be recorded as unallocated with a case. Resolve it through
  that case, never by attaching the transfer to the trade by hand.
* **The transfer is to the right address and final.** Use the desk's own confirm on the trade's incoming leg,
  which is the audited path, and note the delay on the case if one was opened.

**What never to do.** Do not confirm a client leg because the client sent a screenshot. Finality is a fact about
the chain, and the one thing this system must never do is pay out against money that has not actually arrived.

---

## failed-bank-transfer — an INR payout failed at the bank

**What you were told.** A payout leg is `FAILED`, or a client says the money never arrived after the desk
recorded a reference.

**What to check first.**

1. The trade's settlement panel: which leg, which account, which reference, and what the bank said.
2. Whether the failure is per-transfer (a wrong beneficiary detail) or per-account (the bank rejecting
   everything — then this is `capacity-emergency` territory as well).
3. The client's registered destination: has it been archived or changed since the trade was accepted? A trade
   pays where it agreed to pay, and a change opens `CLIENT_BANK_CHANGED` rather than silently moving the money.

**What to do.** Mark the leg failed on the desk if the bank has confirmed it will not settle — that releases the
capacity it reserved — and then create a replacement leg for the same amount. The trade stays open and its
obligation is unchanged: a failed payout is not a smaller debt. If the destination itself is wrong, resolve the
`CLIENT_BANK_CHANGED` case first (it opens by itself when the client archives the destination). To pay the new
account, the client's new destination is first added and verified as usual (their administrator with an
authenticator code, or the desk with them); then, on the trade's **Destination** panel, one person asks — with why
and how the client confirmed it — and someone else with the owner or finance role approves it, each with an
authenticator code. Approval cancels any payout still only planned to the old account (its capacity is released),
answers the case, and tells the client; the desk then plans the payout again. It is refused while a payout sent to
the old account is unresolved: confirm it or mark it failed first.

**What never to do.** Do not create the replacement leg before the original is marked failed. For a few
minutes the trade would have two live legs for one obligation, and if the first one settles after all, the
client is paid twice. Do not change a trade's destination on a phone call alone: the request records how the
client confirmed it, and a change nobody can show the client asked for is the destination-swap attack (SECURITY S8).

---

## duplicate-utr — the same bank reference twice

**What you were told.** A `DUPLICATE_UTR` case, or the desk refused a reference an operator was sure of.

**What to check first.**

1. Which other transfer already holds that reference: `select id, amount_minor, status, confirmed_at from fiat_transfer where utr = '…';`
2. Whether the two are the same real payment (a retry, a double entry) or two payments where somebody typed the
   wrong reference.

**What to do.**

* **The same payment recorded twice.** Void the duplicate case; the first record stands. Nothing moved twice.
* **Two payments, one reference mistyped.** Correct the reference on the wrong one through the desk's own
  correction (step-up, audited — `correct_utr`). The reference on a payment is what the bank's statement will
  be reconciled against, so it has to match the bank, not our expectation.

**What never to do.** Do not update `fiat_transfer.utr` directly. The uniqueness constraint and the audit trail
are the only things making the bank statement import meaningful, and an edited reference quietly breaks the one
control that catches a payment the bank never made.

---

## provider-outage — a chain provider is unavailable

**What you were told.** `chain_providers_degraded` above zero, scanner lag climbing, or both providers failing.

**What to check first.**

1. The USDT screen's **Chain providers** table: which provider, its state (answering / failing / down), when it
   last answered, and the last failure it reported. The worker writes this after every run
   (`chain_provider_status`); it never contains a credential.
2. Whether it is failing for everyone (the provider's own status page) or only for us (credentials, rate limits,
   IP allow-lists — a run of `429` answers is the rate limit).

**What actually happens, so you know what not to fix.**

* **Detection fails over.** The scanner reads heads and account history through the first provider that
  answers and moves to the next one when it cannot; the USDT screen says which provider served the last run.
  Detection never confirms money, so reading through any configured provider is safe.
* **Confirmation asks every provider, every time.** A provider that cannot answer is recorded as *unavailable*
  on the confirmation, never as "the transfer does not exist". Below the D-05 threshold one independent source
  is the documented minimum and the confirmation is marked *degraded* in the audit trail; at or above it, two
  independent sources must agree, so large transfers wait (`chain-quorum-failure`).
* **Nothing is orphaned while a provider is unreachable.** A detected transfer is stripped from its trade only
  when every configured provider answered and none of them knows it any more.

**What to do.** One provider down: fix it at its source (credentials, quota, endpoint) and watch it return to
*answering* on the next run; nothing else is needed. Both down: USDT detection and confirmation stop; trades stay
in their state and nothing is lost. Tell the desk to stop promising timings, and do not pay out against
unconfirmed deposits — an outage is exactly when that temptation appears. When the providers return, the scanner
reads the gap window by window (the cursor never jumped it); a range older than the rescan overlap that you know
was missed is read with `chain-backfill`.

**What never to do.** Do not lower the confirmation threshold, declare two endpoints of one vendor as separate
independence groups, or switch the verifier to a single provider to "get things moving". The dual-provider rule
exists because a single compromised or forked provider can report a transfer that never happened, and a payout
made against one is gone.

---

## chain-quorum-failure — transfers are held for provider quorum

**What you were told.** `chain_quorum_waiting` above zero: open `TX_NOT_FINAL` cases whose reason is
`INSUFFICIENT_PROVIDER_QUORUM` (a large transfer only one independent source vouches for), `PROVIDER_CONFLICT`
(two providers report different facts, or one says the transaction failed while the other reports the transfer) or
`PROVIDER_UNAVAILABLE` (nobody answered).

**What to check first.** The case's details (machine-readable code and reason), the Chain providers table, and the
transaction on two independent block explorers.

**What to do.**

* `INSUFFICIENT_PROVIDER_QUORUM` / `PROVIDER_UNAVAILABLE`: restore the second provider (`provider-outage`). The
  transfer confirms by itself on the next run; the case closes with the confirmation path.
* `PROVIDER_CONFLICT`: treat as an incident. One provider is lagging on a fork, misconfigured (wrong network or
  contract), or wrong. Do not pick the answer you prefer. Capture both answers, pause payouts that depend on the
  transfer (they cannot be released anyway), and escalate to engineering with the provider names and the case.

**What never to do.** Do not resolve the case by confirming the client leg by hand, and do not remove the
disagreeing provider from the configuration to make the conflict disappear — the conflict is the evidence.

---

## chain-backfill — reading a historical range again

**Not an alert.** Use it when funds are known to have reached one of the exchange's own addresses in a block range
the scanner will not read again (below its rescan overlap): an address that became watched after the funds
arrived, or a range a provider served incompletely long ago.

**How.** `chain.backfill_request` (`chain:backfill`, step-up — OWNER or FINANCE) with the block range (at or below
the solidified head the scanner last recorded, at most 2,000,000 blocks), the addresses (deposit addresses or
treasury wallets of this exchange only, at most 200) and a reason. The worker reads one bounded slice a minute
through exactly the scanner's detection path; the USDT screen's **Backfills** table shows how far it has been
proved read. One backfill runs at a time; `chain.backfill_cancel` stops it and keeps what it found.

**What it never does.** Move the scanner cursor, attribute anything other than by address (D-02), or record a
transfer twice — a second pass over the same range finds what the first one recorded and changes nothing.

---

## custody-observation-stale — USDT is waiting to leave an address nobody has read

**What you were told.** `custody_outflows_unobserved` above zero: a USDT payout or refund is planned from an
address whose latest balance reading is missing, unusable (the providers disagreed, or none answered) or older
than five minutes. The desk sees the same thing as a refusal — `CUSTODY_OBSERVATION_STALE` — when it presses
**Send**, and as the address's row in **Custody positions** on the USDT screen.

**What actually happens, so you know what not to fix.** A USDT outflow leaves an exchange address only when a
reading of the chain under five minutes old shows the money there, net of everything already leaving it (B2,
ADR 0016). The worker's `custody_observe` job reads every address that matters once a minute through every
configured provider and records each reading (`custody_balance_observation`, append-only). Two independence groups
reporting the same balance is a usable reading; one group is usable only below the D-05 threshold; a disagreement
or no answer is recorded and never relied on. Nothing is paid while the reading is missing — that is the point.

**What to check first.**

1. The **Custody positions** table: the address, its reading (quality, block, age) and why it is unusable.
2. **Chain providers**: an outage or a provider answering with another balance explains every address at once
   (`provider-outage`).
3. The worker: if no address has a reading newer than a few minutes, `custody_observe` is not running or the
   worker's chain monitoring is `UNCONFIGURED`.

**What to do.** Fix the cause, then press **Refresh** on the address (`custody:refresh_balance` — OWNER,
SETTLEMENT_OPERATOR, FINANCE). The refresh asks the same providers and records the reading under your name; the
payout can be sent as soon as a usable reading covers it. If the reading is usable and the payout is refused with
`CUSTODY_BALANCE_INSUFFICIENT`, the chain shows less free USDT at the address than the payout needs: compare
**Trades' money** with what the chain shows — a difference that persists across readings is money that left the
address outside the platform, and is an incident, not a delay.

**What never to do.** Do not write a balance into `treasury_wallet` (the database refuses anything but the latest
recorded reading, IX089), insert an observation by hand, raise the age limit, or pay from another address that
happens to have USDT — that is another trade's money (D-16).

---

## capacity-emergency — the desk cannot pay today

**What you were told.** `inr_capacity_available` has fallen to the alarm threshold, or payouts are being
refused with `CAPACITY_INSUFFICIENT`.

**What to check first.**

1. The INR screen: which accounts are active, what today's capacity is, and how much is used versus reserved.
2. Whether reservations are stale — a reservation belongs to a leg that was created and never sent.
3. Whether an account is `PAUSED` or `UNAVAILABLE` for a reason someone already knows.

**What to do.** Capacity is a statement about what the bank will actually move today, so the fix is a real one:
confirm with the bank what is available, then set today's capacity on the desk with a reason (step-up, audited).
If the money genuinely is not there, the honest answer is to stop quoting: a quote the desk cannot settle is
worse than no quote. Cancel or decline what cannot be paid rather than accepting and holding.

**What never to do.** Do not raise capacity to clear a queue on the expectation that funds will arrive. Capacity
is the number the whole settlement path trusts; raising it on a hope is how a client is told their money is on
its way when it is not.

---

## blocking-exceptions — trades are on hold

**What you were told.** `blocking_exceptions` above its threshold.

**What to check first.** The desk's exception queue, grouped by type. One type spiking means a systemic cause
(a route, a bank, a provider); a scatter of unrelated cases means the day has simply been busy.

**What to do.** Work them through the exception panel, which offers exactly the resolutions the domain accepts
for each type. Anything that moves money — an adjustment, a refund, a cancellation — is a separate command with
its own approval, and the panel says so rather than pretending to do it. Case types that resolve themselves
(`TX_NOT_FINAL` when the chain solidifies) need patience, not a resolution.

* `USDT_OVERPAYMENT` — either re-price the trade to what arrived (a financial adjustment, two people) or return the
  excess: **Cancel or refund → Return the excess** plans a refund of at most what arrived beyond the receivable to a
  wallet the client registered as sending from (or, for INR, one of their verified bank accounts), from where the
  money is. Someone else confirms it with the transaction or UTR. The trade carries on to its payout and completes
  once the excess is confirmed back. A full unwind (refund and cancel) is a different path; the two are not mixed.
* `CLIENT_BANK_CHANGED` — see `failed-bank-transfer`: a new destination is a request and an approval on the
  **Destination** panel, never a resolution clicked on the case.

**What never to do.** Do not clear a case to release a trade before you know why it opened. The hold is the
only thing standing between an unexplained state and a payout.

---

## route-settlement-overdue — a route has not settled with us

**What you were told.** `overdue_route_obligations` above its threshold.

**What to check first.** The Rates screen's route positions: which obligation, which direction, how much is
outstanding and since when. Then whether the route says it has paid — a settlement recorded but not confirmed
sits in a different state from one that never happened.

**What to do.** Record the settlement when it arrives, with its own reference, through the desk. Since D-16 the
client is paid with the counterparty's money, so an undelivered route side means the client is **waiting for
liquidity**: chase it now, and note it on the obligation so the next person does not repeat the chase.

* A trader's **USDT** (its Sell USDT order) that is not coming: on the trader's desk page, **Reserve applied to
  orders → Apply the reserve to an order** (finance or owner, with the reason); someone else approves. Approval
  shows the order's delivery address. Have custody send exactly that amount from the trader's reserve address (or a
  treasury wallet) to it, then record the hash — or let the scanner see it. On finality it is the trader's delivery:
  pay the client from that address, then pay the trader its INR as for any order.
* A trader's **INR** (its Buy USDT order): the reserve is USDT and no conversion terms exist (TD-21, owner), so it is
  only **held** — the same request and approval, with the USDT amount to keep back named; the trader cannot withdraw
  it, nothing moves, the INR debt stays open. Then wait, or unwind the client trade (refund the client's USDT and
  cancel) with the client's agreement; the hold ends with the order, or release it with the reason when the trader
  pays.
* A desk route late on an exchange-delivers side it already received: a commercial conversation.

**What never to do.** Do not pay a client from anything but the trade's own counterparty funds — not the treasury,
not another trade's money, not a reserve that was not applied through the two-person path. Do not apply a reserve
to cover a different trader, a fee, a penalty or an INR shortfall: those are owner decisions, not desk ones. And
never have custody send a reserve before the application is approved — the scanner will not recognise it.

---

## trader-sweep-behind — trader orders are not moving

**What you were told.** `trader_orders_overdue` above zero: offers past their expiry not routed on, holds past their
end still holding a trader's capacity, or orders whose obligation settled still open.

**What to check first.**

1. Is the worker running? Every other worker signal (`outbox_oldest_pending_seconds`, `audit_seal_age_seconds`)
   climbing at once means it is not.
2. The worker log: each order the sweep could not move is logged as
   `trader_orders_sweep: <step> <order id> failed (<code>): <message>`. The same order failing every minute is a
   problem with that order, not with the sweep — the others are still being moved.

**What to do.** A stopped worker: start it; the sweep catches up on its own (every step is state-guarded). One order
failing: read its code. A lock or a transient database error clears itself; a rule refusal (a capacity check, an
order the trade no longer matches) is a case for the trader desk — release or withdraw the order there, with a reason.

**What never to do.** Do not edit the order or its block by hand to make the sweep pass: the capacity a block holds
must equal its open orders (TR-02), and the database refuses anything else for a reason.

---

## worker-stopped — the worker has not reported in

**What you were told.** `worker_heartbeat_age_seconds` above its threshold: the worker writes a heartbeat every minute
and has not.

**What to check first.** Is the worker process running, and what did it say at start-up? It refuses to start — and
says why, naming settings only — when production configuration is missing, when its database login is the schema
owner, when the schema is not the version it was built for, or when the receipts bucket is not versioned. A process
that is up but not beating is stuck: its log shows the last job it began.

**What to do.** Fix what the start-up line names and start it again; every job is state-guarded and catches up on its
own (the scanner from its cursor, the outbox from what is pending, the sweep from what is due). Restart a stuck worker:
graceful shutdown lets running jobs finish, and anything interrupted is retried.

**What never to do.** Do not run two workers against different databases "to be safe", and do not turn chain
monitoring off to make a worker start: a worker that cannot see deposits must not pretend it can.

---

## reconciliation-mismatch — the books and the outside world disagree

**What you were told.** `reconciliation_mismatches` above zero: open `RECONCILIATION_MISMATCH`,
`ROUTE_SETTLEMENT_MISMATCH`, `ROUTE_DIRECT_PAYOUT_MISMATCH`, `DUPLICATE_UTR` or `DUPLICATE_TX_HASH` cases.

**What to check first.** The exceptions queue, filtered to those types. Each case says which movement and why: a
statement line with another amount, a confirmed payment the statement does not show, money the chain moved for a leg
given up on, a route movement that does not fit its obligation, the same reference twice.

**What to do.** Establish the fact from outside the system — the bank statement, the chain explorer, the
counterparty's own record — and resolve the case with the command it offers, which posts or corrects through the
ledger. A payment the bank never made is a fake-UTR case: the trade stays on hold until it is explained.

**What never to do.** Never close a mismatch by editing a record to agree with the other side. The disagreement is
the evidence; the resolution is a new, audited fact.

---

## database-pressure — the database is running out of connections

**What you were told.** `db_connections_percent` above its threshold.

**What to check first.** Which application holds them (`select application_name, state, count(*) from pg_stat_activity
group by 1, 2;` — `inrp2p-web`, `inrp2p-web-auth`, `inrp2p-worker`, `inrp2p-migrate`), and whether many sit
`idle in transaction` (a request that never finished) or `active` on one statement (a slow query or a lock).

**What to do.** A leak or a stuck request: restart that instance; its pool closes its connections. Real load: scale the
database or lower each instance's pool size so instances × pool stays under the server limit (DEPLOYMENT.md). A lock
queue: find the blocker (`pg_blocking_pids`) before killing anything, and never kill the migrator mid-migration.

**What never to do.** Do not raise `max_connections` without memory to back it, and do not point the application at the
migrator's login to get more connections: it would run with the schema owner's rights.

---

## liquidity-thin — no trader can take an order on one side

**What you were told.** `traders_ready_sell_usdt` or `traders_ready_buy_usdt` at zero. This is a liquidity signal, not a
fault: it never makes the deployment unready, and nothing is broken.

**What to check first.** The trader desk: who is offline, paused, short of reserve, out of capacity or without an active
rate, and whether a trader's settlement details are waiting for review.

**What to do.** It is a business conversation — ask traders to come online or add capacity, review pending details. Until
then requests on that side wait in the queue; quote only what a trader has accepted.

**What never to do.** Never fill the gap with the platform's own money: under D-16 a client is served only with a
counterparty's funds, and nothing in the product will pay out otherwise.

---

## pause-new-business — stopping new trades, finishing the started ones

**When.** An incident that makes new commitments unsafe: a bank or chain outage, a key or account compromise, a
pricing fault, a regulator's instruction, a market halt.

**How.** System → **New business** → *Pause*, with the reason (OWNER or FINANCE, authenticator code). From that moment
no request is opened, no quote sent or accepted and no trader offered an order — the commands refuse with the reason,
and the database refuses whatever else tries (IX098). Clients see that new trades are paused.

**What keeps going.** Everything already started: first legs are confirmed, deliveries recorded, payouts sent and
confirmed, refunds made, receipts issued. Pausing never stops the worker and never leaves confirmed money without its
obligation. Work the open trades to completion or to an unwind as usual.

**Resuming.** *Resume*, with the reason, once the cause is understood. Quotes sent before the pause that expired during
it are re-quoted, never revived.

**Never.** Never stop the worker or the database to "pause": confirmations, deliveries and the scanner would stop with
them, and money that has arrived would sit unrecorded.

---

## payout-ambiguous — a payout may or may not have left

**What you were told.** A bank portal timed out after "submit", a custody transfer shows no hash, a client says
nothing arrived after the desk recorded a reference, or a restore put the database behind what the bank or the chain did.

**What to check first.** The outside record only: the bank statement or portal history for the account and amount; the
chain explorer for the source address. Until one of them answers, the payout is neither sent nor failed.

**What to do.** If it left: record its UTR or transaction hash and confirm it (a second person above ₹2,500,000). If it
did not: mark the leg failed (or cancel it if it was never sent) and only then create the replacement.

**What never to do.** Never create a second payout while the first is unresolved; never mark a leg failed because the
desk cannot see it — absence of evidence is not evidence of absence. This is how clients get paid twice.

---

## incident-recovery — after a restore, an outage or a compromise

**Order.** 1. Pause new business. 2. Bring the database back (backup-restore-drill / point-in-time recovery) and start
web and worker with the same release; they refuse a schema that does not match. Outgoing payments are held on the
recovered database from its first moment (`restore-fence`); where the platform hides the database's identity, raise the
fence by hand before anyone opens the desk. 3. Before anything moves money, reconcile against the outside world: bank
statements for every exchange account since the recovery point, the chain for every exchange address (the scanner
re-reads from its cursor; use chain-backfill for a gap), and the audit-seal archive (`audit-archive-mismatch`: seals up
to the recovery point must match it). 4. Record what happened outside the restored database as new facts —
evidence of payments, confirmations, failures, statement imports — never by editing rows. 5. Lift the fence (two
people), then resume new business.

**Never.** Never re-send a payout the restored database thinks is pending without checking the bank or the chain
first: the database may simply not remember that it already went.

---

## restore-fence — outgoing payments are held after a database change

**What you were told.** `payouts_held` is 1, the desk shows a red banner on every page, and marking a payout or refund
sent, or approving a reserve application, is refused (`PAYOUTS_HELD`, IX100). The database is not the one the workers
last wrote to: it was recovered to an earlier moment or failed over (a new timeline), or restored, upgraded or moved to
another cluster. Whatever happened after the moment it was restored to — a payout marked sent, an approval, a UTR — is
not in it, and the desk would show those payments as still to pay. The worker raised the fence (`RF-…`, by "the
system") at its first heartbeat and paused new business with it; before that heartbeat payments were already held,
because the database compares itself with the last heartbeat it holds. Clients and traders see a plain notice asking
them not to send a payment twice.

**What to check first.** System health → Outgoing payments: the fence, its reason, and **"records are known whole
until"** — the last heartbeat before the change. That moment, not the restore target, is where reconciliation starts.
Then, from that moment to now: every exchange account's bank statement (import it: statement lines match the payouts
they belong to), the chain for every exchange address (the scanner re-reads from its restored cursor; `chain-backfill`
for a gap), the custody provider's outgoing history, and every route's settlement messages. The panel counts what to
check: payout legs waiting to be sent, legs sent and not confirmed, reserve applications approved, reserve withdrawals
requested, route obligations open.

**What to do.** Record every payment that left since that moment as what it is — the leg's UTR or transaction, the
route's settlement, the withdrawal's transaction — through the usual commands; recording evidence is never held, and a
UTR or transaction already recorded is refused a second time, so nothing is counted twice. A leg that the bank shows
as paid but that is still *waiting to be sent* here is recorded right after the fence is lifted, before anything else
is sent. Then one person (owner or finance, with step-up) writes the reconciliation — what was compared, over which
period, what was found and recorded — and **a second person** reviews it and approves; that releases payments. A
reconciliation can be declined, or withdrawn by its author, and payments stay held. New business stays paused until
someone resumes it on its own control (`pause-new-business`).

Where the platform does not let the application read the database's cluster and timeline (the identity shows nothing
on System health), the worker cannot notice a restore: the person who restored raises the fence by hand — System
health → Outgoing payments → *Hold outgoing payments*, with the recovery target as the reason — before the desk is
opened. Raise it by hand too whenever records are known to be lost for any other reason.

**What never to do.** Never lift the fence because "nothing looks wrong": absence of evidence in a restored database is
exactly what a restore produces. Never let the person who reconciled approve their own reconciliation, and never edit
`worker_heartbeat`, `restore_fence` or a leg to make the banner go away. Never pay a leg again because it shows as
waiting — check the bank or the chain first (`payout-ambiguous`).

---

## secret-rotation — rotating keys and secrets

**What rotates how.** Field-encryption key: see `field-encryption-keys` (new KMS key, old one kept in
`INRP2P_KEK_PREVIOUS` until re-sealed). Session secrets (`OPERATOR_AUTH_SECRET`, `CLIENT_AUTH_SECRET`): set the new value
in the secret manager and roll web; every session on that surface ends and people sign in again — do it when that is
acceptable, or at once after a suspected leak. `INRP2P_HEALTH_TOKEN`: set the new value, roll web, update the monitor.
`RESEND_API_KEY`: create the new key at the provider, roll web and worker, then revoke the old one. Database logins:
create the new password, update the secret, roll, then expire the old password. TRON provider keys and object-store
access: through their own consoles and the workload roles; nothing is stored in the image.

**Never.** Never put a secret in a commit, an image, a ticket or a chat; never reuse one secret for two purposes
(the start-up check refuses the same value for both session secrets).

---

## outbox-backlog — events are not being delivered

**What you were told.** `outbox_failed` above zero, or `outbox_oldest_pending_seconds` climbing.

**What to check first.**

1. Is the worker running at all? A climbing age with a flat failure count is a worker that has stopped.
2. `select type, count(*), max(attempts), max(last_error) from outbox_event where dispatched_at is null group by type;`
   — one type failing is a handler; every type failing is the worker or the database.
3. For delivery failures specifically: is a provider configured at all? Acceptance codes and client sign-in
   codes need an email provider that V1 does not yet have (TD-04), and they fail loudly by design.

**What to do.** Restart the worker if it has stopped; the outbox is at-least-once and every handler is
idempotent, so nothing is lost or duplicated by restarting. For a failing handler, read `last_error` — it is the
domain's own message. Events that failed for a cause now fixed are retried by the worker; they do not need to be
re-created.

**What never to do.** Do not delete failed outbox events to clear the alert. Each one is a promise to a client
that has not been kept, and deleting it removes the only record that it was made.

---

## email-delivery — codes and client emails are not going out

**What you were told.** `acceptance_codes_undelivered` (someone is waiting for a code to accept a quote) or
`email_deliveries_failing` (client emails refused today, or not delivered within fifteen minutes).

**What to check first.**

1. The worker's start-up line `email: resend` — `email: unconfigured` means no provider is set (`RESEND_API_KEY`,
   `RESEND_FROM`), and every code and email is waiting by design.
2. The error codes, which are all that is ever recorded about a failure:
   `select last_error, count(*) from client_notification_email where status <> 'SENT' group by 1;` and, for codes,
   `select last_error from outbox_event where type = 'acceptance_otp.deliver' and dispatched_at is null;`
   `PROVIDER_REJECTED_401` / `_403` — the API key or the sending domain (verify the domain in Resend, rotate the key in
   the secret manager); `PROVIDER_REJECTED_422` — that address is refused; `PROVIDER_RATE_LIMITED`,
   `PROVIDER_UNAVAILABLE`, `PROVIDER_TIMEOUT`, `PROVIDER_AMBIGUOUS` — the provider; it is retried on its own.
3. The provider's status page and its dashboard (delivery, bounces), with the provider message ids recorded on the
   rows that did go.

**What to do.** Fix the configuration or wait out the provider: pending deliveries are retried each minute under the
same idempotency key, so a retry is never a second email. A code is sent only while its challenge is open, so after a
long outage the client simply asks for a new code on the quote page. For a refused address, ask the client to correct
it (their administrator, or the desk with them); the in-app inbox already has every message.

**What never to do.** Never read a code out of the database, or pass one by phone, chat or ticket: a code reaches a
person only through the channel tied to their verified address (SECURITY §2.3). Never mark a delivery as sent by hand:
a delivery is sent when the provider gave it an id, and only then.

---

## audit-archive-mismatch — the seal archive and the database disagree

**What you were told.** `audit_archive_failures` above zero: the last daily check of the seal archive found a `GAP`
(a range missing from the archive), `CHAIN_BROKEN`, `UNREADABLE`, `SEAL_DIFFERS` (a seal here is not the archived one),
`SEAL_MISSING_HERE`, `EVENTS_DIFFER` (audit events no longer hash to the archived seal), `DIVERGED` (an archived range
that leaves this database's chain and no recorded database change explains), or `NOT_ARCHIVED` (a sealed range waited
more than 48 hours for its export). The findings are on the latest `audit_archive_verification` row.

**Not a finding: superseded ranges.** After a point-in-time restore the archive still holds what the lost timeline
exported — seals made after the moment the database went back to, under numbers the restored database will use again for
other events. Ranges are named by their last seal's hash, so the two timelines never collide; the check follows this
database's chain and lists a range that leaves it *after the `known_until` of a restore fence* under `superseded` on the
same row, with the fence it belongs to. They are evidence of what existed after the recovery point, kept under Object
Lock; take them into the restore reconciliation (`restore-fence`). Continuity is checked along the event sequence and the
hash chain, never the seal numbers, which come from a sequence that skips after a crash, a failover or a recovery.

**What to check first.** `NOT_ARCHIVED` alone: the export job — the worker's log, the bucket's credentials and
reachability (`audit-seal-stale`). Anything else is a security incident until proved otherwise: the archive is written
once under Object Lock and nobody here can change it, so a difference means the database changed after it was sealed.

**What to do.** Do not "fix" either side. Preserve the database (a snapshot) and the archive's access logs; identify the
first seal that differs — the events in its range were changed, added or removed after it was sealed — and treat it as
`account-takeover` territory for whoever had write access to the database. After a restore to an earlier point, the
archive is how the restored trail is verified: seals and events up to the recovery point must match the archive
exactly, and nothing after it exists to compare.

**What never to do.** Never re-seal, delete or rewrite audit rows or seals to make the check pass. The archive is right
by construction; the database is the thing being checked.

---

## audit-seal-stale — the audit trail has not been sealed

**What you were told.** `audit_seal_age_seconds` above its threshold (sealing has stopped), or
`audit_seal_export_age_seconds` (seals are being made but not exported to the write-once archive, TD-17).

**What to check first.** Whether the worker is running (sealing and the daily export are its scheduled jobs), and
whether the last seal verifies: `verifyAuditSeals` recomputes the whole chain. For the export: the worker's start-up
line (`audit seals: exported daily to …`), its log for `audit_seal_export`, and the bucket — reachable, versioned, under
Object Lock, writable by the worker's role.

**What to do.** Restart the worker. Sealing is idempotent and catches up: the next run seals every unsealed
event, and the chain is continuous regardless of how long the gap was. The export catches up the same way — the next
run writes every seal not yet exported as one contiguous range; the database refuses a range that would leave a gap. If the chain does **not** verify, that is
a different and much more serious problem — it means events in an already-sealed range were changed — and it
goes straight to engineering with the offending seal id.

**What never to do.** Do not re-seal by hand or delete a seal that fails verification. The chain's value is
that it cannot be rewritten; a seal deleted to make verification pass is the exact failure the chain exists to
make visible.

---

## deposit-pool-low — the desk is running out of deposit addresses

**What you were told.** `deposit_pool_free` at or below its threshold, or a `DEPOSIT_POOL_LOW` case.

**What to check first.** The USDT screen's pool status: how many addresses are available, assigned, and in
cooldown. Addresses return to the pool after their cooldown window, so a low number with many in cooldown is a
busy day rather than a shortage.

**What to do.** Import more addresses from the custody provider through the desk's own import. Each one is
recorded with its provider reference, and the domain never derives an address itself.

**What never to do.** Do not reuse an address that is still assigned or in cooldown, and do not reassign one
manually. Attribution is by address alone (D-02): two trades sharing an address means two clients' money
arriving at the same place with nothing to tell them apart.

---

## account-takeover — an operator account may be compromised

**What you were told.** Unexpected role changes, step-ups from an unfamiliar place, actions nobody recognises,
or an operator reporting that their authenticator was lost or stolen.

**What to check first.**

1. `select * from audit_event where actor_id = '…' order by seq desc limit 200;` — what that account did, and
   when. The audit trail records the session id and a hashed IP for every action.
2. `session.login` and `session.step_up` events for that account: when did the pattern change?
3. Whether anything financial completed: adjustments, payouts confirmed, destinations confirmed, role grants.

**What to do, in this order.**

1. **Revoke the sessions** for that account, then disable it — one audited step:
   `scripts/operator-admin.ts disable-operator` (`operator-access`).
2. **Reset the authenticator** — a new enrolment, verified in person or through a channel that does not depend
   on the account itself.
3. **Review every financial action** taken in the window. Corrections are made as audited adjustments with a
   second approver (FI-31), never as edits.
4. **Check role grants.** A compromised account's first move is often to grant itself more, and role changes are
   audited precisely so this question has an answer.
5. Only then, restore access.

**What never to do.** Do not let the person who reported the problem be the one who approves the corrections,
and do not re-enable the account before the authenticator is re-enrolled. Every financial correction needs a
second approver who is not the requester, and that rule matters most on the day someone is trying to get around
it.

---

## operator-access — the first OWNER, a lost OWNER, ending someone's access

**Not an alert.** The procedures the desk deliberately cannot perform, so that no session — however privileged — can
perform them silently. They run from `scripts/operator-admin.ts` with the infrastructure database credential
(`INRP2P_ADMIN_DATABASE_URL`, the role that runs migrations) and secrets from the secret manager — never the
application's credential, never a password on the command line. Each writes an audit event with the machine, the OS
user and the reason. Without `--yes` they only say what they would do.

**The first OWNER.** `node scripts/operator-admin.ts bootstrap-owner --email … --name … --reason "…" --yes` with
`OPERATOR_AUTH_SECRET`, `OPERATOR_BASE_URL` and `INRP2P_BOOTSTRAP_PASSWORD` (≥ 16 characters) in the environment.
Refused while any OWNER is active. The new OWNER enrols TOTP at first sign-in; nothing works before that.

**More OWNERs.** In the desk, not here. With one OWNER, that OWNER grants it (single-OWNER mode, audited). With two or
more, one requests and another approves in their own session (SECURITY §3).

**Ending someone's access** (a leaver, a compromised account — see `account-takeover`):
`node scripts/operator-admin.ts disable-operator --email … --reason "…" --yes` revokes every session and disables the
account in one audited step. It refuses the last active OWNER.

**A lost sole OWNER** (authenticator and recovery gone, or the account compromised): disable it with
`--allow-last-owner`, then bootstrap a new OWNER. Both steps are audited; two people should be present.

**What never to do.** Insert or delete `operator_user_role` rows by hand (the database refuses the application role
anyway, IX091), re-enable a disabled account without a new authenticator enrolment, or run these procedures to get
around a second OWNER's approval.

---

## field-encryption-keys — the key that protects bank account numbers

**Not an alert** — but a KMS outage shows up as refused client-destination changes and failed acceptance-code
deliveries (`KMS_UNAVAILABLE`), and a misconfiguration as a process that will not start
(`FIELD_PROTECTION_MISCONFIGURED`).

**What it is.** Every sealed value (an account number, a contact phone, an acceptance code) has its own data key; the
data key is wrapped by one AWS KMS symmetric key and recorded with the application's key id (`INRP2P_KEK_ID`). The
application never holds the KMS key. The hosting account is **not chosen yet** (DECISIONS: hosting remains open): the
implemented adapter is AWS KMS; another cloud needs its own adapter behind the same port before it is used.

**Provisioning (once per environment, by whoever owns the cloud account).**

1. Create a symmetric KMS key (`SYMMETRIC_DEFAULT`, `ENCRYPT_DECRYPT`) in the region the database lives in; turn on
   automatic rotation. Record its **key ARN** (not an alias).
2. Give the web and worker roles exactly this, and nothing else on the key:
   ```json
   {
     "Effect": "Allow",
     "Action": ["kms:Encrypt", "kms:Decrypt"],
     "Resource": "<key ARN>",
     "Condition": { "StringEquals": { "kms:EncryptionContext:app": "inrp2p", "kms:EncryptionContext:purpose": "field-data-key" } }
   }
   ```
   No `kms:*`, no `CreateGrant`, no key administration for the application roles; key administration stays with the
   account owner. Log KMS calls (CloudTrail).
3. Set `INRP2P_ENV=production`, `INRP2P_KEK_PROVIDER=aws-kms`, `INRP2P_KEK_ID` (a short id, e.g. `kms-2026a`),
   `INRP2P_KMS_KEY_ARN`, and `INRP2P_FIELD_HMAC_BASE64` (32 random bytes from the secret manager) for both the web app
   and the worker; `INRP2P_KMS_ENDPOINT` only for a VPC endpoint. Credentials come from the workload's role — never
   access keys in configuration.

**Rotation.** KMS's automatic rotation needs nothing from us: old ciphertexts decrypt under the same ARN. To move to a
**new** key: create it, add it with a new `INRP2P_KEK_ID`, and list the old one in
`INRP2P_KEK_PREVIOUS='[{"id":"kms-2026a","provider":"aws-kms","arn":"…"}]'` — new values are sealed under the new key,
old ones still open. Keep the old key enabled until nothing references it (`select count(*) … where
account_number_enc like 'v1.kms-2026a.%'`, per sealed column), and only then schedule its deletion.

**Credentials.** On ECS the worker uses its task role. On Vercel the web app assumes `AWS_ROLE_ARN` with the OIDC token
Vercel puts on every request (project → Settings → Security → OIDC federation on, issuer *Team*); the role trusts only
the project's production deployments (DEPLOYMENT §10). `KMS_REFUSED: STS refused the web identity` means the role's
trust does not match the token — the team slug, the project name or the environment; `AWS_ROLE_ARN is set but there is
no web identity token` means OIDC federation is off for the project.

**Moving values off a key — the re-seal** (`scripts/reseal-fields.ts`, migration 0036; production's move off the locally
held `prod-v1`, D-18). Each value's data key is unwrapped with the old key and wrapped by the new one; the encrypted
field itself, its iv and tag are kept, and the database refuses a re-seal that changes anything else, is not declared,
or is not the schema owner's. Run it with the schema owner's connection (`DATABASE_MIGRATOR_URL`), the target exactly
as the release will have it (`INRP2P_ENV=production`, `INRP2P_KEK_PROVIDER=aws-kms`, `INRP2P_KEK_ID`,
`INRP2P_KMS_KEY_ARN`), the **unchanged** `INRP2P_FIELD_HMAC_BASE64`, the old key in
`INRP2P_RESEAL_FROM='[{"id":"prod-v1","provider":"local","base64":"…"}]'`, and temporary AWS credentials (IAM Identity
Center: `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`), with no process running:

1. `node scripts/reseal-fields.ts plan` — writes nothing. Every value must open with the keys given, every account
   number must match its stored lookup HMAC (a different HMAC key is found here, before anything moves), and the target
   must wrap and unwrap. `NOT OK` → stop; the reason is printed per row id, never a value.
2. `node scripts/reseal-fields.ts apply` — checks everything again, then moves one row per transaction, each opened with
   the target alone and compared before it is written, and audited (`field.resealed`, key ids only). `--limit N` moves
   at most N. If it stops — a crash, KMS unavailable, a lost connection — every row is either moved or untouched: run
   `apply` again; moved rows are skipped.
3. `node scripts/reseal-fields.ts verify` — the target alone, as the release: everything opens, every HMAC matches,
   nothing is left under another key. Only now does the release start.

Afterwards the old key leaves the configuration, but is kept in the secret manager while any backup or database branch
from before the re-seal exists: those still hold values sealed under it.

**KMS unavailable.** Writes that seal and reads that open fail with `KMS_UNAVAILABLE` after bounded retries; nothing
falls back to plaintext and nothing is stored half-sealed. Check the region's KMS status and the role's permissions
(an `AccessDeniedException` is `KMS_REFUSED`, not retried). Nothing needs repairing afterwards.

**What never to do.** Use a locally held key in production (the process refuses), put the HMAC key or AWS access keys
in the repository or a ticket, schedule deletion of a key that still has values sealed under it, or widen the IAM
policy to make an error go away.

---

## client-authenticator-lost — a client user lost their authenticator

**Not an alert.** A client user cannot confirm a change to their destinations or quote authority because their
authenticator is gone (phone lost, app wiped), and their recovery codes are gone too.

**What to do.** Confirm it is the person, through a channel that does not depend on the account — a call to the number
on file, or a video call against the identity documents on file. Then, on the client's page,
`client_user.reset_mfa` (`client_user:reset_mfa`, OWNER or SUPPORT, step-up) with a reason that says how they were
verified. It removes the authenticator and ends every session of that user; they sign in again with an email code and
set up a new authenticator within ten minutes of signing in.

**What never to do.** Reset on the strength of an email or a message from the account itself, or "temporarily" make the
change for them without the same verification — that is exactly what someone who has taken over the mailbox would ask
for.

---

## receipt-integrity — a receipt could not be served as issued

**What you were told.** A client or an operator got "This receipt could not be reproduced from its record" (HTTP 500,
`RECEIPT_HASH_MISMATCH`) instead of a download.

**What to check first.** Which receipt and format, and whether the deployment stores receipts
(`INRP2P_RECEIPTS_BUCKET`). With storage: `select format, object_key, version_id, sha256 from receipt_object where
receipt_id = …;` then, with the bucket's read credentials, fetch that exact version and hash it. Without storage: the
generator changed under a document that was supposed to be fixed — a code change since the receipt was issued.

**What to do.** A stored version whose bytes differ, or that is missing, is a security incident, not a bug: treat it as
`account-takeover` territory for whoever holds the bucket's credentials, keep the evidence (the bucket's own versions
and access logs), and do not replace anything. The receipt itself is not lost — its snapshot and hashes are in the
database, immutable — so once the incident is understood a correct copy can be reissued as a new version through a
code change and review. A regeneration mismatch without storage is a release defect: roll the generator back.

**What never to do.** Never serve, email or print a receipt that failed the check, and never "fix" the recorded hash.
A receipt is evidence because its hash does not move.

---

## backup-restore-drill — proving the backups are real

**What you were told.** `restore_drill_age_days` above 35 (warning) or 95 (alarm): no drill has been recorded as
passing for that long (`backup_verification`, written by both drills below). Otherwise this is the drill the launch
checklist requires, run monthly and after any change to the database's shape or hosting.

**Point-in-time recovery — what production relies on.** The database runs with continuous WAL archiving (a managed
PostgreSQL's point-in-time recovery, or the reference stack's `archive_command`) and a retention window; a logical dump
is not point-in-time recovery. The drill recovers a **separate** server to a chosen moment and checks it:

```bash
node scripts/pitr-drill.ts [--image inrp2p-web:<release>]
```

On the reference stack it does everything itself, in throwaway containers: PostgreSQL 18.6 with WAL archiving and the
reference roles; migrations as the non-superuser migrator; a base backup; writes before and after a recovery target;
recovery of a new server to that target; then the checks — nothing after the target and everything before it, the
schema version, sign-in data, the queued job and the chain cursor, the ledger balanced and every journal balanced, the
audit seal chain, grants (the application login can neither change the schema nor delete ledger entries), the checks a
production process runs before it serves (through the application's and the worker's own logins), and that outgoing
payments are held on the recovered copy before any worker runs and that the worker's first heartbeat raises the restore
fence (`restore-fence`). It prints the timings (base backup, recovery, checks) and records the result.

On a managed database, recover to a new instance from the provider's console (never in place), then run the same checks
against it: `scripts/restore-checks.ts` (ledger, journals, audit chain, settled trades), `databaseDeploymentProblems`
through the application and worker logins, `select inrp2p_payouts_held()`, then start one worker against it and see it
raise the fence. Record the measured recovery time and the target in the drill's ticket and in `backup_verification`.
Targets proposed for the owner (D-06): **RPO ≤ 5 minutes** (the managed platform's log-shipping interval; the reference
stack's `archive_timeout` is 60 s), **RTO ≤ 2 hours** from the decision to restore to the desk reconciling, of which the
database recovery itself is the smaller part.

**Logical dump — a second, independent check.**

```bash
DATABASE_MIGRATOR_URL=postgres://…/inrp2p PG_BIN=/usr/lib/postgresql/18/bin node scripts/backup-drill.ts
```

It dumps, restores into a **new** database (never over an existing one), and then asks the restored copy the
same questions: is it at the same migration, does its ledger still net to zero, does its audit seal chain
still verify, is every completed trade still fully settled, and do the counts match the source. It exits
non-zero and names each problem if not.

`PG_BIN` matters: `pg_dump` refuses to dump a server newer than itself, and the machine running the drill is
rarely the machine running the database. The checks themselves are in `scripts/restore-checks.ts` and are
tested against deliberately corrupted databases in `test/integration/restore-check.int.test.ts` — a check that
passes on a bad restore would be worse than no check, because it is what stands between a bad backup and the
decision to rely on it.

**What never to do.** Do not restore or recover over the production database to "test the backup", and do not record
the drill as done on the basis that a dump file or a snapshot exists. A backup nobody has restored is a hope. Never lift
the restore fence on a drill's recovered copy and then point anything at it that can send money.
