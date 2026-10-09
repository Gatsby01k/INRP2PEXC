# INRP2P Exchange — Deployment

What a deployment of this release needs, how it starts, how it is watched, and what is still the owner's choice.
`deploy/` holds the images and a **reference** stack; the reference is how the release is started and probed on one
machine, not a production environment. Production readiness is gate 3 in `PRODUCTION_HARDENING.md` and is not claimed
here.

## 1. Choices still open (D-06)

Hosting is not chosen. Whatever is chosen has to provide, and the release refuses to start without:

| Need | Why | Today |
|---|---|---|
| PostgreSQL **18** (the CI pins 18.6), managed, with continuous WAL archiving and point-in-time recovery | money journal, audit, jobs (E4, TD-16) | owner input |
| A KMS holding the field-encryption key — **AWS KMS** is implemented; another cloud needs an adapter behind the same port | bank account numbers, codes (TD-03) | owner input |
| Object storage with the S3 API, **versioning and Object Lock** (AWS S3, or compatible) | receipts (TD-12), audit-seal export (TD-17) | owner input |
| Email: **Resend**, a verified sending domain (SPF, DKIM, DMARC) | sign-in and acceptance codes, notifications (TD-04) | owner input |
| Two **independent** TRON providers (D-05) | deposit detection and confirmation | owner input |
| A custody provider in POOL mode (D-02) | deposit and delivery addresses | owner input |
| A secret manager, a TLS load balancer per host, a monitoring system that scrapes Prometheus text and pages | everything below | owner input |

## 2. Images and processes

`deploy/Dockerfile` builds three images from one lockfile (Node 24.21.0, pnpm 12.4.2), run as the unprivileged `node`
user, with no secret in any layer:

| Image (target) | Runs | Instances | Stops |
|---|---|---|---|
| `web` | `next start` on :3000 — the desk, the client app and the public site, told apart by host | 2+ behind the load balancer | SIGTERM: stops accepting, finishes requests in flight |
| `worker` (`worker-pdf` with Chromium for PDF receipts) | graphile-worker: outbox, chain scan/confirm, sweeps, seals, exports | 1–2 (cron jobs are keyed, so two never run the same job) | SIGTERM: takes no new job, finishes running ones, closes its pool (`stop_grace_period` ≥ 60 s) |
| `migrate` | `scripts/migrate.ts`: SQL migrations under an advisory lock, then the queue schema | one-shot per release | — |

**Order of a release.** The schema check is strict in both directions, and it is not asked the same way everywhere:
a web instance asks at start — and **exits** if the schema is not exactly its own — and again on **every readiness
probe**, so an instance already running against a newer schema turns "not ready" and the load balancer stops sending
it traffic; a worker asks **only at start**, so a running worker never notices the schema change under it. Hence, for
every release from this one on:

1. Pull the new images; stop the old worker (SIGTERM: it takes no new job, finishes the running ones, closes its
   pool).
2. `migrate` (as `inrp2p_migrator`): the migrations under an advisory lock, then the queue schema. From this moment
   the old web instances answer "not ready" and get no traffic — an old instance never serves a newer schema.
3. Start the new web instances at once (they would have exited against the old schema, which is why they start
   after the migration) and the new worker. The desk and the client app are unavailable from step 2 until the first
   new web instance is ready — the start time of an instance, seconds — which is the price of never letting one
   release serve another's schema.
4. Remove the old web instances.

Migrations are additive; mixed-version behaviour of each one is stated in its header (0025: fails closed; 0027:
replays across the deploy are refused, not repeated). Roll forward; do not roll a schema back once new rows depend on
it.

**Upgrading from the release at schema 23 (`d0cc778`) — the first deploy of this release.** That release has **no**
schema check: its web instances would keep answering "ready" against 34, and nothing has shown that its code is safe
on 34 (0025 changes how a trade is funded; 0033 and 0034 add triggers its code never expected). And this release
refuses 23. So there is no rolling path for this one transition — it is a short maintenance window:

1. Note the recovery point (the time, for point-in-time recovery) and announce the window. The desk finishes or holds
   what is in hand: no payout marked sent during the window.
2. Stop the old worker (SIGTERM), so nothing scans, confirms, sweeps or delivers under the old rules once the schema
   moves.
3. Stop the old web — or put the load balancer in maintenance. The release at 23 cannot pause new business (that
   control arrives in 0033), so stopping it is the only way to be sure no request, quote or acceptance is written
   half under the old rules.
4. `migrate`: 0024–0034 and the queue schema, as `inrp2p_migrator`. Check `select inrp2p_schema_version()` = 34.
5. Start the new worker. It checks its configuration and the schema, records its first heartbeat — no restore fence:
   no earlier database identity is on record — and starts its jobs. The scanner continues from its cursor; events the
   old release left in the outbox are delivered to handlers that are idempotent.
6. Start the new web instances. Readiness turns 200 when configuration, login and schema are right; only then does
   traffic arrive.
7. Check System health: the expected alarms on a database that has never recorded a drill (`restore_drill_age_days`)
   aside, nothing in alarm; trades already open keep the funding model they were accepted under
   (`LEGACY_EXCHANGE_FUNDED`).
8. If the new release does not come up, do not start the old release against 34. Fix forward, or recover the database
   to the point noted in step 1 — the restore fence then holds outgoing payments until two people have reconciled —
   and redeploy the old release.

CI's `upgrade` job proves the data side of this transition on every change: the release at 23 writes its own data —
its fixture world, and its own end-to-end run through its own screens — and seals its audit log as its worker does;
this release's migrations carry it to 34 with nothing lost, the books balanced, every old trade legacy-funded, the
old seal chain intact and continued by this release's first seal, and this release able to read it
(`scripts/upgrade-check.ts`).

## 3. Configuration contract

`INRP2P_ENV=production` is the one switch and it only takes things away (`packages/adapters/src/production.ts`): at
start each process prints the names of what is missing or wrong — never a value — and exits. Missing configuration
never activates a development default, a sink or a fake. Secrets come from the secret manager as environment variables.

| Variable | web | worker | Secret | Notes |
|---|---|---|---|---|
| `INRP2P_ENV` | ✔ | ✔ | | `production` |
| `NODE_ENV` | ✔ | ✔ | | `production` (set by the image) |
| `DATABASE_URL` / `WORKER_DATABASE_URL` | ✔ | ✔ | ✔ | the **login** roles, never the migrator |
| `DATABASE_MIGRATOR_URL` | | | ✔ | the `migrate` job only |
| `DESK_HOST`, `APP_HOST`, `PUBLIC_HOST` | ✔ | | | three different public names |
| `OPERATOR_AUTH_SECRET`, `CLIENT_AUTH_SECRET` | ✔ | | ✔ | ≥ 32 characters, different |
| `INRP2P_HEALTH_TOKEN` | ✔ | | ✔ | ≥ 32 characters; the monitor's access to status and metrics, sent as the `x-inrp2p-health-token` header |
| `OPERATOR_BASE_URL`, `CLIENT_BASE_URL`, `CLIENT_LINK_BASE` | ✔ | `CLIENT_BASE_URL` | | https; default from the hosts |
| `INRP2P_KEK_PROVIDER=aws-kms`, `INRP2P_KEK_ID`, `INRP2P_KMS_KEY_ARN`, `INRP2P_FIELD_HMAC_BASE64` | ✔ | ✔ | HMAC ✔ | RUNBOOKS `field-encryption-keys`; credentials from the workload role |
| `INRP2P_KEK_PREVIOUS` | ✔ | ✔ | | during a key rotation |
| `RESEND_API_KEY`, `RESEND_FROM` | ✔ | ✔ | key ✔ | TD-04 |
| `INRP2P_TRON_PRIMARY_URL`/`_GROUP`/`_NAME`/`_KEY`, `INRP2P_TRON_SECONDARY_*`, `INRP2P_USDT_CONTRACT` | ✔ | ✔ | keys ✔ | two groups for large amounts (D-05) |
| `INRP2P_TRON_MONITORING` | | ✔ | | never `disabled` in production |
| `INRP2P_CUSTODY_PROVIDER` | ✔ | | | POOL (D-02) |
| `INRP2P_OBJECT_STORE_REGION`, `INRP2P_OBJECT_STORE_ENDPOINT` | ✔ | ✔ | | https |
| `INRP2P_RECEIPTS_BUCKET`, `INRP2P_RECEIPT_RETENTION_DAYS` | ✔ | ✔ | | optional (TD-12); retention is the owner's |
| `INRP2P_AUDIT_SEAL_BUCKET`, `INRP2P_AUDIT_SEAL_RETENTION_DAYS` | | ✔ | | required (TD-17) |
| `INRP2P_PDF_RENDERER`, `INRP2P_CHROMIUM_PATH` | opt. | opt. | | `worker-pdf` sets them |
| `INRP2P_WORKER_ID`, `INRP2P_WORKER_POOL_SIZE` | | opt. | | heartbeat name; pool size |
| `INRP2P_RELEASE` | ✔ | ✔ | | set by the image build (`--build-arg RELEASE`) |

Refused in production, whatever their value: `INRP2P_CLIENT_OTP_SINK_FILE`, `INRP2P_ALLOW_INSECURE_COOKIES`,
`TEST_DATABASE_URL`, a local or test field key. A database that carries the test clock permit is refused.

## 4. Hosts, TLS and cookies

Three hosts, one build: the proxy decides the surface from the `Host` header. TLS ends at the load balancer, which must
send `X-Forwarded-Proto: https`; the app then sets HSTS and `upgrade-insecure-requests`. Session cookies are always
`Secure` and host-only (the insecure-cookie switch exists for end-to-end runs and is refused in production). The public
host carries no session; the quote link lives there so it never shares an origin with a client cookie.

## 5. Database

Roles (`deploy/reference/postgres/01-roles.sh` shows the layout): `inrp2p_migrator` owns the schema and runs
migrations; `inrp2p_app_login` (web) is a member of `inrp2p_app`; `inrp2p_worker_login` of `inrp2p_worker` (which includes
`inrp2p_app`); `inrp2p_readonly_login` of `inrp2p_readonly`. Every privilege is granted by the migrations; nothing runs as a
superuser; a process connected as the owner or a superuser refuses to start (`databaseDeploymentProblems`), and the
database itself recognises the owner (`inrp2p_is_application_session()`, migration 0027).

Pools: the web app holds two pools per instance (application and auth, 10 each by default); the worker one
(`INRP2P_WORKER_POOL_SIZE`, default 10). Keep instances × pools below `max_connections` with headroom for the migrator
and an operator session; `db_connections_percent` warns at 70 %.

## 6. Backups and recovery

**Mechanism.** Continuous WAL archiving with point-in-time recovery: on a managed PostgreSQL, the platform's own PITR;
on the reference stack, `archive_command` to a volume with `archive_timeout=60` (for drills, not production). A logical
dump (`scripts/backup-drill.ts`) is a second, independent check — it is not the backup.

**Targets — proposed for the owner (D-06).** RPO ≤ 5 minutes (a managed platform ships logs at about that interval;
the reference stack's bound is its 60 s archive timeout). RTO ≤ 2 hours from the decision to restore to the desk
reconciling; the database recovery is the small part of it. Retention of the recovery window, snapshots and the audit
archive is an owner decision with legal input (SECURITY §9); the configuration only enforces that the audit archive has
a retention.

**Measured.** `scripts/pitr-drill.ts` on the reference stack (2026-10-09, release `56961d5`, Docker `postgres:18.6`, a
small database): base backup 0.6 s, recovery to the target 1.2 s, checks 0.2 s, the web image ready against the
recovered database in production mode 2 s. That proves the mechanism, not a production time; a drill of production size
on the chosen platform is gate 2 (**NOT RUN**).

**Recovering.** Never in place: recover a new instance to the target time, run `migrate` (a no-op when the schema
matches), point web and worker at it. Outgoing payments are held on the recovered database from its first moment — it
is on a new timeline, and its last heartbeat names the old one — and the worker's first heartbeat raises the restore
fence and pauses new business. On a platform that hides the database's cluster and timeline from the application, raise
the fence by hand before anyone opens the desk. Reconcile against the bank and the chain, two people lift the fence,
then new business is resumed (RUNBOOKS `incident-recovery`, `restore-fence`, `backup-restore-drill`).

**What a restore replays, and why it is safe.** The restored jobs run again, and every one is state-guarded: outbox
events are delivered at least once into idempotent handlers; a client email keeps its provider idempotency key, derived
from the event and the person; sealing and the seal export continue from what is recorded, adopting a range written but
not recorded; the scanner re-reads from its restored cursor and records each transfer once (unique by transaction and
log index). The platform sends no money itself (watch-only), so nothing in a restored database can pay anyone; the fence
keeps people from paying twice what it no longer remembers.

**The migrator is not a superuser.** Migrations and the queue schema install as `inrp2p_migrator`, the database's owner
and nothing more — as on a managed platform, whose administrative user is not a PostgreSQL superuser either. The
reference drill migrates that way, twice in a row.

## 7. Jobs

The worker's crontab (`apps/worker/src/tasks.ts`): `outbox_dispatch` (minute), `audit_seal` (hourly), `audit_seal_export`
(daily), `capacity_day_rollover`, `deposit_address_cooldown_release`, `quote_expiry_sweep`, `settlement_sla`,
`settlement_reconcile` (daily), `tron_scan`, `tron_confirm`, `tron_orphan_sweep`, `tron_backfill`, `custody_observe`,
`trader_orders_sweep`, `receipt_store_backfill`, `worker_heartbeat`. Every job is state-guarded and safe to run twice.

## 8. Health, readiness and alerts

| Endpoint | Who | Says |
|---|---|---|
| `/api/health/live` (every host) | anyone | the process answers |
| `/api/health/ready` (every host) | anyone | yes/no only: the database answers; in production also the schema version, the login and the configuration |
| `/api/health/status` (desk host) | monitoring token or an operator with `economics:view` | every signal with its group, thresholds and runbook; new business open or paused; outgoing payments flowing or held; each worker's heartbeat |
| `/api/health/metrics` (desk host) | same | the same in Prometheus text |

Signals are grouped by what fails: **money** (ledger, custody observations, blocking cases, reconciliation, route
obligations, capacity, address pool, the audit-seal archive, outgoing payments held after a database change), **infrastructure** (scanner, providers, quorum, outbox, codes and emails, audit
seal and its export, trader sweep, worker heartbeat, database connections), and **liquidity** (traders ready per side).
Liquidity is reported apart and never makes the deployment "not ready": a trader-funded exchange with nobody online is
quiet, not broken (D-16); a platform balance of zero is normal and is not a signal at all.
The monitor sends the token in the `x-inrp2p-health-token` request header, to the desk host only (behind the load
balancer, which also sets `X-Forwarded-Proto: https`); `/api/health/status` answers 503 while any money or infrastructure
signal is in alarm, so a plain HTTP check can page on it. `deploy/reference/prometheus/alerts.yml` turns states into
pages and tickets. Whether a page reaches a person is
tested only against the real paging setup (gate 2, **NOT RUN**).

## 9. Procedures

RUNBOOKS: `pause-new-business` (System → New business: no new requests, quotes, acceptances or trader offers, while
everything started settles), `incident-recovery`, `payout-ambiguous`, `secret-rotation`, `field-encryption-keys`,
`email-delivery`, `provider-outage`, `worker-stopped`, `database-pressure`, `backup-restore-drill`, `restore-fence`,
`audit-archive-mismatch`.
