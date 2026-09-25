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

1. The USDT screen: it shows the scanner's block cursor and when it last ran. A cursor that is not moving is a
   scanner that has stopped; a cursor that moves with nothing found is a quiet day.
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
`CLIENT_BANK_CHANGED` case first (it opens by itself when the client archives the destination). Moving an open
trade to a new destination is not built yet (TECH_DEBT TD-18): until it is, such a trade is unwound with a refund
and cancellation and re-quoted to the new destination.

**What never to do.** Do not create the replacement leg before the original is marked failed. For a few
minutes the trade would have two live legs for one obligation, and if the first one settles after all, the
client is paid twice.

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

**What you were told.** Scanner lag climbing, provider errors in the worker log, or both providers failing.

**What to check first.** Which provider, and whether it is failing for everyone (its own status page) or only
for us (credentials, rate limits, IP allow-lists).

**What to do.** One provider down is not an incident: the scanner reads through both and requires both to agree
before it calls a transfer final, so it keeps working on the other one with a lag. Both down means USDT
confirmation stops; trades stay in their state and nothing is lost, but clients wait. Tell the desk to stop
promising timings, and do not pay out against unconfirmed deposits — a provider outage is precisely when that
temptation appears.

**What never to do.** Do not lower the confirmation threshold or switch the verifier to a single provider to
"get things moving". The dual-provider rule exists because a single compromised or forked provider can report a
transfer that never happened, and a payout made against one is gone.

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

**What never to do.** Do not clear a case to release a trade before you know why it opened. The hold is the
only thing standing between an unexplained state and a payout.

---

## route-settlement-overdue — a route has not settled with us

**What you were told.** `overdue_route_obligations` above its threshold.

**What to check first.** The Rates screen's route positions: which obligation, which direction, how much is
outstanding and since when. Then whether the route says it has paid — a settlement recorded but not confirmed
sits in a different state from one that never happened.

**What to do.** Record the settlement when it arrives, with its own reference, through the desk. If the route
is late beyond its agreed window, this is a commercial conversation, not a technical one: the client has
already been paid and the trade is complete, so nothing about the client's position changes. Note it on the
obligation so the next person does not repeat the chase.

**What never to do.** Do not hold a client's payout because a route is slow to settle. The client's trade and
the route's obligation are deliberately separate (D-03), and coupling them would make a counterparty's
lateness the client's problem.

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

## audit-seal-stale — the audit trail has not been sealed

**What you were told.** `audit_seal_age_seconds` above its threshold.

**What to check first.** Whether the worker is running (the seal is one of its scheduled jobs), and whether the
last seal verifies: `verifyAuditSeals` recomputes the whole chain.

**What to do.** Restart the worker. Sealing is idempotent and catches up: the next run seals every unsealed
event, and the chain is continuous regardless of how long the gap was. If the chain does **not** verify, that is
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

1. **Revoke the sessions** for that account, then disable it. Both are audited.
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

## backup-restore-drill — proving the backups are real

**Not an alert.** This is the drill the launch checklist requires, run on a schedule and after any change to
the database's shape or hosting.

```bash
DATABASE_MIGRATOR_URL=postgres://…/inrp2p PG_BIN=/usr/lib/postgresql/18/bin node scripts/backup-drill.ts
```

It dumps, restores into a **new** database (never over an existing one), and then asks the restored copy the
questions that matter: is it at the same migration, does its ledger still net to zero, does its audit seal chain
still verify, is every completed trade still fully settled, and do the counts match the source. It exits
non-zero and names each problem if not.

`PG_BIN` matters: `pg_dump` refuses to dump a server newer than itself, and the machine running the drill is
rarely the machine running the database. The checks themselves are in `scripts/restore-checks.ts` and are
tested against deliberately corrupted databases in `test/integration/restore-check.int.test.ts` — a check that
passes on a bad restore would be worse than no check, because it is what stands between a bad backup and the
decision to rely on it.

**What never to do.** Do not restore over the production database to "test the backup", and do not record the
drill as done on the basis that the dump file exists. A backup nobody has restored is a hope.
