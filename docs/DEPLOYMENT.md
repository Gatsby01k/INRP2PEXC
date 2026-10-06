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
| `worker` (`worker-pdf` with Chromium for PDF receipts) | graphile-worker: outbox, chain scan/confirm, sweeps, seals | 1–2 (cron jobs are keyed, so two never run the same job) | SIGTERM: takes no new job, finishes running ones, closes its pool (`stop_grace_period` ≥ 60 s) |
| `migrate` | `scripts/migrate.ts`: SQL migrations under an advisory lock, then the queue schema | one-shot per release | — |

**Order of a release.** 1. `migrate` (as `inrp2p_migrator`). 2. Roll `web` and `worker` to the same release. A process
refuses to start against a schema that is not exactly its own (`SCHEMA_VERSION`), so an old instance never serves a
newer schema by accident and a new one never serves an old schema. Migrations are additive; mixed-version behaviour
of each one is stated in its header (0025: fails closed; 0027: replays across the deploy are refused, not repeated).
Roll forward; do not roll a schema back once new rows depend on it.

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
| `INRP2P_HEALTH_TOKEN` | ✔ | | ✔ | ≥ 32 characters; the monitor's access to status and metrics |
| `OPERATOR_BASE_URL`, `CLIENT_BASE_URL`, `CLIENT_LINK_BASE` | ✔ | `CLIENT_BASE_URL` | | https; default from the hosts |
| `INRP2P_KEK_PROVIDER=aws-kms`, `INRP2P_KEK_ID`, `INRP2P_KMS_KEY_ARN`, `INRP2P_FIELD_HMAC_BASE64` | ✔ | ✔ | HMAC ✔ | RUNBOOKS `field-encryption-keys`; credentials from the workload role |
| `INRP2P_KEK_PREVIOUS` | ✔ | ✔ | | during a key rotation |
| `RESEND_API_KEY`, `RESEND_FROM` | ✔ | ✔ | key ✔ | TD-04 |
| `INRP2P_TRON_PRIMARY_URL`/`_GROUP`/`_NAME`/`_KEY`, `INRP2P_TRON_SECONDARY_*`, `INRP2P_USDT_CONTRACT` | ✔ | ✔ | keys ✔ | two groups for large amounts (D-05) |
| `INRP2P_TRON_MONITORING` | | ✔ | | never `disabled` in production |
| `INRP2P_CUSTODY_PROVIDER` | ✔ | | | POOL (D-02) |
| `INRP2P_OBJECT_STORE_REGION`, `INRP2P_OBJECT_STORE_ENDPOINT` | ✔ | ✔ | | https |
| `INRP2P_RECEIPTS_BUCKET`, `INRP2P_RECEIPT_RETENTION_DAYS` | ✔ | ✔ | | optional (TD-12); retention is the owner's |
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

## 6. Jobs

The worker's crontab (`apps/worker/src/tasks.ts`): `outbox_dispatch` (minute), `audit_seal` (hourly),
`capacity_day_rollover`, `deposit_address_cooldown_release`, `quote_expiry_sweep`, `settlement_sla`,
`settlement_reconcile` (daily), `tron_scan`, `tron_confirm`, `tron_orphan_sweep`, `tron_backfill`, `custody_observe`,
`trader_orders_sweep`, `receipt_store_backfill`, `worker_heartbeat`. Every job is state-guarded and safe to run twice.

## 7. Health, readiness and alerts

| Endpoint | Who | Says |
|---|---|---|
| `/api/health/live` (every host) | anyone | the process answers |
| `/api/health/ready` (every host) | anyone | yes/no only: the database answers; in production also the schema version, the login and the configuration |
| `/api/health/status` (desk host) | monitoring token or an operator with `economics:view` | every signal with its group, thresholds and runbook; new business open or paused; each worker's heartbeat |
| `/api/health/metrics` (desk host) | same | the same in Prometheus text |

Signals are grouped by what fails: **money** (ledger, custody observations, blocking cases, reconciliation, route
obligations, capacity, address pool), **infrastructure** (scanner, providers, quorum, outbox, codes and emails, audit
seal, trader sweep, worker heartbeat, database connections), and **liquidity** (traders ready per side).
Liquidity is reported apart and never makes the deployment "not ready": a trader-funded exchange with nobody online is
quiet, not broken (D-16); a platform balance of zero is normal and is not a signal at all.
`deploy/reference/prometheus/alerts.yml` turns states into pages and tickets. Whether a page reaches a person is
tested only against the real paging setup (gate 2, **NOT RUN**).

## 8. Procedures

RUNBOOKS: `pause-new-business` (System → New business: no new requests, quotes, acceptances or trader offers, while
everything started settles), `incident-recovery`, `payout-ambiguous`, `secret-rotation`, `field-encryption-keys`,
`email-delivery`, `provider-outage`, `worker-stopped`, `database-pressure`, `backup-restore-drill`.
