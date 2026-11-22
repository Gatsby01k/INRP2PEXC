# Worker cost, the second TRON source and the queue — audit of 2026-11-22

The owner's Neon findings (production, 2026-11-22): PostgreSQL 18 on Neon Launch, autoscaling 0.25–8 CU, autosuspend off;
graphile-worker polling every 2 s with many recurring financial jobs; ~4,100 unavailable queue rows, some naming obsolete
tables or columns; ~265k idempotency keys, ~165k audit events, ~138k custody balance observations; frequent sequential
scans on worker and operational tables; the secondary TRON provider (QuickNode) with no recorded success since
November 7; recent balance readings `SINGLE_SOURCE`, not `AGREED`; no `pg_stat_statements`; PITR history 6 hours.

This document is what was traced, what changed and why it is safe, what was measured, and what still needs the owner.
**Every number here is from a local PostgreSQL 18.4, not from production.** Nothing in production was read, changed or
deployed.

## How it was measured

`apps/worker/test/worker-cost.bench.test.ts` (vitest project `bench`, never in CI) runs the real worker task list and the
real crontab under graphile-worker — as `apps/worker/src/main.ts` does, through the worker's own login, `pollInterval`
2000, concurrency 5 — against a seeded exchange (four ACTIVE treasury wallets, HD account, fees, TRX price) and two
TronGrid-compatible HTTP providers in separate independence groups (60 ms and 150 ms per answer, a block every 3 s).
With `BENCH_HISTORY=1` the tables first get production's volumes: 265,000 idempotency keys, 165,000 audit events, 138,000
observations, 4,100 permanently failed queue rows. Cron fires on real minute boundaries; each run is ten real minutes.
It reports, per minute, statements and database execution time (`pg_stat_statements`), row writes per table
(`pg_stat_all_tables`), WAL bytes, and requests per provider and endpoint. Busy-day cost and latency come from the
existing market-day load test (`test/integration/market-day.int.test.ts`, now also printing p99).

Base: `origin/main` at bc985e2. After: this branch. Same machine, same seed, run one after the other.

## What was found

### 1. Most of the idle write volume was the same balance reading, written again every minute

`custody_observe` read every ACTIVE treasury wallet every minute and recorded each reading through the command
pipeline: one `custody_balance_observation`, one `audit_event`, one `treasury_wallet` update — and an `idempotency_key`
row inserted and then completed, keyed with a fresh random UUID. A random key can never be presented again, so it
deduplicates nothing; FI-50 requires keys of *financial* mutations, and the observation is not one. The same random-key
pattern ran every minute for the scanner's cursor (`chain.cursor_advance`) and the inactive-request sweep
(`request.expire_inactive`), and every five minutes for the market reference (`rates.market_reference_read`).

Production's counts fit this, though they could not be broken down from here: three wallets read once a minute since
the worker started in mid-October is ~140k readings, the same number of audit events, and at least twice that in random
keys with the cursor and sweep steps. `scripts/worker-diagnostics.ts` (read only) prints keys per scope and audit events
per action per day to confirm it. In the bench, before the change, 40 of 48 audit events and 62 of 64 idempotency keys in
ten quiet minutes were these readings and steps.

Nothing that decides on a balance depends on the minute-by-minute schedule: the signer reads the paying address itself
right before it plans (`onchain/autopay.ts`) and signs (`onchain/sender.ts`), and the desk refreshes on request. The
schedule keeps readings fresh for people and for the 300-second rule (`maxObservationAgeSeconds`).

### 2. The second TRON source was not inactive: nothing recorded what it did, and it lost most balance reads

* **A blind spot.** `chain_provider_status` (the desk's *Chain providers* table, the `chain_providers_degraded` health
  check) was written only by the scanner, and the scanner asks the second provider only when the first fails over. Balance
  readings (every minute, every provider) and confirmations (every provider) recorded nothing there. So "no success since
  November 7" says only that the primary has not failed over since then — not what the second provider did every minute.
* **The balance read could not pin a block on a slower provider.** A node answers `balanceOf` from its solidified state
  without naming the block, so the read was bracketed by the solidified head before and after and accepted only when both
  were equal, three attempts. The head moves every 3 s. Probing public TronGrid from here, the head moved under 2 of 15
  reads at ~150–500 ms per call; a provider further away, behind a balancer, or slowed by its own rate limit (a `429`
  inside the bracket waits ≥ 1 s) fails all three attempts most of the time — and every failure makes the reading
  `SINGLE_SOURCE`. `packages/adapters/test/tron-balance.unit.test.ts` reproduces it: a provider whose head moves one block
  under every read was refused on every attempt by the old code ("the solidified head kept moving") and is read now.
* Which of these is production's cause — that, a quota, or credentials — is in the `detail` of the recent `SINGLE_SOURCE`
  readings (`unavailable: quicknode: …`) and in what `scripts/tron-provider-probe.ts` prints against the real endpoint.
  Neither could be read from here.

### 3. The ~4,100 unavailable queue rows are history, not work

graphile-worker's `add_jobs` (migration 000020 of 0.18.0): when a keyed job is added and the existing job with that key is
not available — locked, or attempts spent — the old row's key is cleared, its attempts set to the maximum, and a new job
is inserted. Every failed run of a keyed cron job therefore leaves one permanently failed row that is never retried. Cron
payloads carry no work (each run re-reads the database), so the next successful run did what a failed one missed. A worker
left running across a migration fails each per-minute job once a minute (twelve of them) against tables or columns that
are gone — the obsolete names production saw. The rows do not slow fetching: `jobs_main_index` is partial on
`is_available`; graphile's lock reset reads them every 8–10 minutes (4,100 tuples, well under a millisecond).

### 4. The sequential scans are on tables of a few rows

In ten quiet minutes the worker's sequential scans read `treasury_wallet` (4 rows), `network_fee_policy`, `restore_fence`,
`chain_cursor`, `worker_heartbeat`, graphile's `_private_tasks` and `_private_job_queues` — a handful of rows each, where a
sequential scan is the cheapest plan PostgreSQL has. The large tables (`idempotency_key`, `audit_event`,
`custody_balance_observation`) were reached only through indexes, at production's volumes. No index is missing for the
worker's paths; none was added (an index costs every write and a migration).

### 5. Polling

graphile-worker polls once per `pollInterval` per concurrent worker (five), so ~160 `get_job` calls a minute at 2 s —
about 10 ms of database time a minute. Its LISTEN/NOTIFY already starts new jobs at once; polling is what starts jobs
scheduled for later (`onchain_cycle` ten seconds after anything moved, each quote's expiry, retries). A longer interval
delays exactly those, and the local queue (`localQueue`) is meant for high throughput — the library's own guidance is to
leave it off at low volume. Both were left as they are.

### 6. Neon compute

With autosuspend off and a 0.25 CU minimum, the compute bill has a floor of 0.25 CU × 730 h ≈ 183 CU-hours a month
whatever the worker does. The idle worker used 53.8 ms of database time a minute before the change and
49.9 after — under 0.5 % of a quarter of a vCPU either way, far below anything that would move the autoscaler off
its minimum. **These changes are not expected to change CU-hours at today's traffic, and no saving is claimed.** What
they change is write volume (storage, WAL, PITR history), provider calls (quotas) and evidence quality. The compute lever is
the owner's: the 8 CU maximum means a runaway query can bill up to 32× the floor per hour; a lower maximum bounds that.

## What changed, and why each is safe

| Change | Files | Why it keeps every guarantee |
|---|---|---|
| A non-financial system step with no natural identity claims no idempotency key (balance readings, the scanner cursor, quote and request expiry, the market reference) | `packages/scanner/src/system.ts`, `packages/quotes/src/expiry.ts`, `packages/quotes/src/auto-quotes.ts` | A fresh random key is never presented twice, so it never replayed or refused anything; each step keeps its own transaction, state guards and audit event. Financial steps still claim a key (FI-50; the pipeline refuses a financial command without one), and every naturally keyed step (`tron:{tx}:{log}` detections, operator commands) is untouched. |
| The scheduled observation reads a quiet treasury wallet once its reading is 150 s old, instead of every minute; deal addresses, wallets with a live send or a pending exchange-paid USDT leg, and wallets whose latest reading is missing or unusable are still read every run | `packages/scanner/src/balances.ts` (`addressesDueForObservation`, `QUIET_WALLET_REFRESH_SECONDS`) | No reading is relied on past 300 s, and a quiet wallet's reading is at most 150 s + one cron minute old. The signer's own reading before every plan and send is unchanged, so no payout waits for the schedule. Readings stay append-only and audited; nothing is deleted. |
| Each provider's part in the scheduled balance readings and in every confirmation is recorded in `chain_provider_status` | `packages/scanner/src/balances.ts`, `packages/scanner/src/providers.ts` (`trackedVerifier`), `packages/scanner/src/confirm.ts` | Observability only: the record is for people and alarms; the verifier's answers and the D-05 quorum are computed exactly as before. The payout path's own reading adds no write. |
| A balance read accepts a solidified-head bracket of up to two blocks and labels it with the lower block; reads `balanceOf` and the TRX account inside the bracket; tries four times; a head going backwards is never accepted | `packages/adapters/src/tron.ts` (`getSolidifiedBalance`, `BALANCE_BRACKET_BLOCKS`) | On a node whose head moves forward the state lies inside the bracket; the lower label counts an outflow that became final inside it as still leaving (never as gone twice) — the label `readBalance` already gives sources at different blocks. Agreement still needs equal balances from two independence groups; D-05 thresholds unchanged. The TRX figure is now pinned to the same bracket (it was read after it). |
| A production worker stops taking jobs, lets running ones finish and exits non-zero when the database is no longer at its schema | `apps/worker/src/schema-watch.ts`, `apps/worker/src/main.ts` | Applies the start-up rule (`databaseDeploymentProblems`) while running; only a definite answer stops it, a failed check changes nothing. Matches the release order (stop worker → migrate → new image). |
| Read-only tools: provider probe, worker diagnostics; the cost bench; p99 in the market-day report; runbooks and tech debt | `scripts/tron-provider-probe.ts`, `scripts/worker-diagnostics.ts`, `apps/worker/test/worker-cost.bench.test.ts`, `vitest.config.ts`, `test/integration/market-day.int.test.ts`, `docs/RUNBOOKS.md`, `docs/TECH_DEBT.md` | They read; nothing writes, replays or removes. |

No migration, no new dependency, no new service, no setting changed.

## Results

### A quiet exchange — ten minutes of the real worker (bench, production-sized history)

Four ACTIVE treasury wallets, no open deal; per minute unless stated.

| | Before (main bc985e2) | After (this branch) | Change |
|---|---:|---:|---:|
| SQL statements | 361.9 | 333.0 | −8 % |
| Database execution time | 53.8 ms | 49.9 ms | −7 % |
| Row writes (all tables) | 85.6 | 67.4 | −21 % |
| WAL written by statements | 83.9 KB | 55.7 KB | −34 % |
| `idempotency_key` rows written in 10 min (insert + complete) | 64 + 64 | 3 + 3 | −95 % |
| `audit_event` in 10 min | 48 | 24 | −50 % |
| `custody_balance_observation` in 10 min | 40 | 16 | −60 % |
| `treasury_wallet` updates in 10 min | 40 | 16 | −60 % |
| graphile-worker jobs in 10 min (insert / update / delete) | 127 / 133 / 127 | 128 / 134 / 128 | same |
| `chain_provider_status` writes in 10 min | 10 (primary only) | 18 (both providers) | by design |
| TRON requests, primary | 25.8 | 14.7 | −43 % |
| TRON requests, secondary | 16.6 | 6.7 | −60 % |
| Readings `AGREED` | 40 of 40 | 16 of 16 | — |

Per day at this shape that is ~9,200 → ~430 idempotency keys, ~5,800 → ~2,300 readings, ~6,900 → ~3,500 audit events,
~61,000 → ~31,000 provider requests. At the row sizes the bench's history measured (idempotency key ≈ 330 B, reading
≈ 400 B, audit event ≥ 490 B, indexes included) the worker's own table growth drops from ≈ 8.7 MB to ≈ 2.8 MB a day.

What is left of the quiet worker's writes is graphile-worker's own bookkeeping — each cron run is a job inserted, locked
and deleted and a crontab row updated, 52 of the 67 row writes a minute — and its cron scheduler is the largest single
consumer of database time (≈ 14 ms a minute). That is the price of one job per sweep per minute, which keeps the sweeps
independent and concurrent; folding them into one job would make every deadline wait behind the slowest chain read, so it
was not done. The cluster-wide WAL figure of the second run was inflated by read-only diagnostics run against another
database at the same time (PostgreSQL 18 enables page checksums, so first reads of freshly loaded pages log hint bits);
the per-statement WAL above is the database's own.

### A market day — 300 deals under load (market-day test, four runs each side, alternating)

289 trades a run (both directions, desks, instant prices, declines, disputes, abandoned deals), two worker instances
running the money jobs concurrently, every invariant of the test asserted (payouts once, exact wallet deltas, balanced
ledger, capacity and TRX returned). Medians of the four runs' percentiles, milliseconds:

| Step | p50 before | p50 after | p95 before | p95 after | p99 before | p99 after |
|---|---:|---:|---:|---:|---:|---:|
| A whole deal, first price to completion | 3,141 | 3,116 | 5,096 | 4,973 | 5,862 | 5,565 |
| Client waits for the payout | 2,685 | 2,462 | 4,391 | 4,247 | 4,871 | 4,849 |
| Client waits for the escrow | 314 | 316 | 750 | 738 | 893 | 895 |
| Deposit detection | 6 | 6 | 39 | 40 | 57 | 58 |
| Confirmation run (`tron_confirm`) | 21 | 20 | 70 | 59 | 199 | 233 |
| Signer run (`sender`, reads the paying address first) | 226 | 228 | 370 | 363 | 506 | 439 |
| Monitor run | 81 | 62 | 251 | 300 | 298 | 388 |
| Planning run (`autopay`) | 149 | 141 | 487 | 530 | 717 | 719 |
| Instant price | 62 | 62 | 236 | 278 | 368 | 415 |

The machine was shared with a browser page at full CPU, and one side's four runs spread as widely as the two sides
differ: deal p95 4,423–5,563 before and 4,867–5,152 after; instant price p95 233–329 and 240–310; monitor p95 207–306 and
231–362. Every step's runs overlap between the two sides. The larger median differences go both ways and sit on paths whose
code did not change (monitor +49 ms, autopay +43 ms, instant price +42 ms at p95; payout wait −144 ms, whole deal −123 ms,
confirmation −11 ms). The paths that did change — the signer's reading before a send, the confirmation run — are flat or
faster. Per run, database execution time was
35.1–39.8 s before and 36.2–38.1 s after (no measurable change: the busy day is bound by deal work, not by the removed
writes), WAL 46.1 MB before and 44.9 MB after (−2.7 %), and idempotency keys 10,530 before and 8,835 after (−16 %: the
signer's own reading before each send no longer claims a random key, ~1,700 in a day of 289 trades).

## Tests

| What | Result |
|---|---|
| Typecheck (root, web, ui), lint | clean |
| Unit, whole repo | 3,446 / 3,446 |
| Integration, whole repo, local PostgreSQL 18.4 | 1,039 passed, 1 skipped; `database-logins` fails exactly as on `main` (this machine's PostgreSQL trusts every login, so a wrong password is let in); the four MinIO suites need Docker and run in CI |
| New: balance read over the wire (`packages/adapters/test/tron-balance.unit.test.ts`) | 5 / 5; on `main`, a head moving under every read is refused on every attempt — the dropped second source |
| New: observation cadence, provider record, writes per reading (`packages/scanner/test/observation-cadence.int.test.ts`) | 7 / 7 |
| New: schema watch (`apps/worker/test/schema-watch.unit.test.ts`) | 3 / 3 |
| Concurrency and recovery already covered and passing: two confirmation runs on one transfer, restore fence, worker heartbeat, outbox redelivery, chain reorg and orphans, the market day's two concurrent worker instances | pass |
| Load: market day, 300 deals, four runs each side | every invariant held in all eight runs; latencies above |

## Considered and not done

* **A longer poll interval or graphile's local queue** — would delay scheduled jobs (onchain re-check, quote expiry,
  retries) for ~10 ms of database time a minute.
* **One cron job for all per-minute sweeps** — removes most of graphile's bookkeeping, but every deadline would wait behind
  the slowest provider read.
* **Writing a balance reading only when it changed** — a reading's age is what the payout rule checks; a reading not
  written is a reading the rule cannot see. The age-based cadence keeps every recorded reading a real one.
* **New indexes** — the worker's scans are on tables of a few rows; the large tables are already read by index.
* **Deleting history** (old readings, keys, audit events, failed queue rows) — evidence and retention are the owner's,
  and nothing measured here is slowed by them.
* **Parallel address reads in the scanner** (TD-47) — the right next step when the watched set grows; not needed at
  today's volume, and it changes how the detection budget is spent.

## What needs the owner (nothing here was done)

1. **Release.** Merge, then the worker image of the merge commit (*Worker image* workflow) and the stack update. No
   migration: the web and the worker stay at schema 53. The worker change matters; the web picks up only the adapter's
   balance read (the desk's *Refresh*).
2. **Find QuickNode's actual failure** (read only, any order):
   * `DATABASE_URL=<migrator or worker login> node scripts/worker-diagnostics.ts` — the reason recent readings are
     `SINGLE_SOURCE`, the providers' records, keys and audit events per scope per day, the queue grouped and classified.
   * `INRP2P_TRON_SECONDARY_URL=… INRP2P_TRON_SECONDARY_NAME=quicknode INRP2P_TRON_SECONDARY_GROUP=quicknode
     INRP2P_USDT_CONTRACT=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t node scripts/tron-provider-probe.ts` (and the primary's
     settings beside it) — every endpoint the worker calls, timed, and how often the head moves under a balance read.
     `429`/`402`/quota text means the QuickNode plan (credits or rate); `401`/`403` the URL token; a moving head is fixed by
     this release. After the release the desk's *Chain providers* table shows QuickNode's state within three minutes.
3. **The queue's old failed rows** (TD-48): classify, export, then remove the superseded ones with graphile-worker's own
   cleanup — or leave them; they cost nothing measurable.
4. **Neon settings** (each a billing or operations decision, none required by this change):
   * `pg_stat_statements` (`create extension pg_stat_statements` as the database owner; it is in Neon's allow list) — the
     only way to measure production's statements instead of a local copy's. Small overhead; reset it after a release.
   * A lower autoscaling maximum (for example 2 CU): bounds a runaway query's bill; the quiet worker never needs more than
     the 0.25 CU minimum.
   * PITR history: 6 hours means an error noticed the next morning cannot be undone by a point-in-time restore. Longer
     history costs storage for the WAL written in it — which this change makes smaller.

