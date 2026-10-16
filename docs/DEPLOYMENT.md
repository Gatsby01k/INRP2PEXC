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
schema check: its web instances would keep answering "ready" against 36, and nothing has shown that its code is safe
on 36 (0025 changes how a trade is funded; 0033–0036 add triggers its code never expected). And this release
refuses 23. So there is no rolling path for this one transition — it is a short maintenance window:

1. Note the recovery point (the time, for point-in-time recovery) and announce the window. The desk finishes or holds
   what is in hand: no payout marked sent during the window.
2. Stop the old worker (SIGTERM), so nothing scans, confirms, sweeps or delivers under the old rules once the schema
   moves.
3. Stop the old web — or put the load balancer in maintenance. The release at 23 cannot pause new business (that
   control arrives in 0033), so stopping it is the only way to be sure no request, quote or acceptance is written
   half under the old rules.
4. `migrate`: 0024–0036 and the queue schema, as `inrp2p_migrator`. Check `select inrp2p_schema_version()` = 36.
   0035 adds the shared trader reserve wallet (D-17); the scanner starts watching it from its cursor — a transfer to it
   from before that point is found when the trader hands in its hash, or through a backfill (RUNBOOKS). 0036 lets the
   schema owner move sealed values to another key, should a key ever be retired with values that must stay readable
   (RUNBOOKS `field-encryption-keys`); this deployment's first transition needs no re-seal (§10).
5. Start the new worker. It checks its configuration and the schema, records its first heartbeat — no restore fence:
   no earlier database identity is on record — and starts its jobs. The scanner continues from its cursor; events the
   old release left in the outbox are delivered to handlers that are idempotent.
6. Start the new web instances. Readiness turns 200 when configuration, login and schema are right; only then does
   traffic arrive.
7. Check System health: the expected alarms on a database that has never recorded a drill (`restore_drill_age_days`)
   aside, nothing in alarm; trades already open keep the funding model they were accepted under
   (`LEGACY_EXCHANGE_FUNDED`).
8. If the new release does not come up, do not start the old release against 36. Fix forward, or recover the database
   to the point noted in step 1 — the restore fence then holds outgoing payments until two people have reconciled —
   and redeploy the old release.

CI's `upgrade` job proves the data side of this transition on every change: the release at 23 writes its own data —
its fixture world, and its own end-to-end run through its own screens — and seals its audit log as its worker does;
this release's migrations carry it to 36 with nothing lost, the books balanced, every old trade legacy-funded, the
old seal chain intact and continued by this release's first seal, every value it sealed under its local key moved to a
KMS key (an in-memory one in CI) and opening under that key alone, and this release able to read it
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
| `AWS_ROLE_ARN`, `AWS_REGION` | ✔ (Vercel) | | | the role assumed through Vercel's OIDC federation (§10); a worker on ECS uses its task role and sets neither. A long-term `AWS_ACCESS_KEY_ID` (`AKIA…`) is refused |
| `RESEND_API_KEY`, `RESEND_FROM` | ✔ | ✔ | key ✔ | TD-04 |
| `INRP2P_TRON_PRIMARY_URL`/`_GROUP`/`_NAME`/`_KEY`, `INRP2P_TRON_SECONDARY_*`, `INRP2P_USDT_CONTRACT` | ✔ | ✔ | keys ✔ | two groups for large amounts (D-05) |
| `INRP2P_TRON_MONITORING` | | ✔ | | never `disabled` in production |
| `INRP2P_CUSTODY_PROVIDER`, `INRP2P_CUSTODY_CAPABILITY` | ✔ | | | `POOL` (D-02, the default) or `DERIVED` (ADR 0017: the exchange's own HD wallet; provider `hd-wallet`) |
| `INRP2P_CUSTODY_XPUB` | ✔ | | | DERIVED only: the account's extended **public** key `m/44'/195'/0'` from `scripts/custody-seed.ts`; the web app may never hold the seed |
| `INRP2P_CUSTODY_SEED_SEALED` | | ✔ | ✔ | the HD seed sealed under the custody key (RUNBOOKS `custody-seed`); without it the worker signs nothing |
| `INRP2P_CUSTODY_KEK_PROVIDER=aws-kms`, `INRP2P_CUSTODY_KEK_ID`, `INRP2P_CUSTODY_KMS_KEY_ARN` | | ✔ | | a KMS key of its own, Decrypt only for the worker's role, only under the `custody-seed` context |
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
`trader_orders_sweep`, `receipt_store_backfill`, `worker_heartbeat`, and the exchange's own rails (ADR 0017): `onchain_cycle`
(every minute and on every planned send: plan payouts, fuel and sign, follow transactions to the end, close holds) and
`network_fee_refresh` (every 10 minutes: the chain's energy and bandwidth prices). Every job is state-guarded and safe
to run twice.

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

## 10. This deployment: Vercel, Neon and AWS (D-18)

| Part | Where | How it authenticates |
|---|---|---|
| web (desk, client app, public site) | Vercel project `inr463rergr`, production domains | database: `inrp2p_app_login` through Neon's pooler; KMS: the role `inrp2p-vercel-web`, assumed through Vercel's OIDC federation (`AWS_ROLE_ARN`) |
| database | Neon project, PostgreSQL 18, `us-east-1`; PITR is Neon's own | owner role `neondb_owner` for migrations and creating the logins only |
| worker | AWS ECS Fargate, `us-east-1` (`deploy/aws/inrp2p-aws.json`) | database: `inrp2p_worker_login`, direct (it listens for jobs); AWS: its task role; secrets: Secrets Manager `inrp2p/worker` |
| field-encryption key | AWS KMS, `eu-north-1`, made by the owner (`kms-2026a`, `arn:aws:kms:eu-north-1:075774506744:key/f15dbe8b-22b2-4c22-9775-6ea4b06c2f34`) | `kms:Encrypt`/`kms:Decrypt` only, only under the application's encryption context: the owner's role `inrp2p-vercel-web` for the web app, the stack's task role for the worker |
| audit-seal archive | S3 under Object Lock (COMPLIANCE), versioned, private, TLS only | the worker's task role |
| worker image | ECR `inrp2p-worker`, pushed by the `Worker image (ECR)` workflow from `main` | GitHub's OIDC federation and the role `inrp2p-worker-image-push` |

**GitHub OIDC identity.** GitHub repositories created after 2026-07-15 use an immutable subject that includes
the owner ID and repository ID ([GitHub's format](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims)).
INRP2PEXC was created on 2026-09-16. The stack parameter `GitHubRepository` is the identity segment of that subject:
`Gatsby01k@225718825/INRP2PEXC@1373536755`. The role still requires the exact `main` branch and
`sts.amazonaws.com` audience. A stack already created with the previous plain `Gatsby01k/INRP2PEXC` value must
update the **parameter value**: changing a template's default does not replace an existing stack's parameter.
Use the current template and previous values for the other parameters; keep `DesiredCount=0` until the image and
worker secrets are ready. For a different repository, use the identity segment in its actual OIDC subject.

No long-term AWS key exists anywhere: a production process refuses one (`AKIA…`).

**The AWS stack** (`deploy/aws/inrp2p-aws.json`, CloudFormation, created in `us-east-1`): the archive bucket, the ECR
repository, the worker's secret (created with `SET-ME` placeholders, filled in the console), log group, cluster, task
definition and service, GitHub's OIDC provider and the worker's three roles (execution, task, image push). It does
**not** create the field-encryption key, the web app's role or Vercel's OIDC provider — the owner made those
(2026-10-12); the task role is given the key by ARN (`FieldKeyArn`), across regions, which KMS allows. The key's policy
must let IAM grant its use (AWS's default key policy does); a key policy naming only the web role would refuse the
worker. The service is created with `DesiredCount` 0: nothing runs, and nothing is spent on compute, until the worker
is started. The bucket and the secret are kept if the stack is deleted.

**What it costs** — AWS list prices for `us-east-1` as known on 2026-10-11; confirm in the AWS Pricing Calculator
before creating anything.

| Item | Size | Per month |
|---|---|---|
| Fargate (x86) | 0.25 vCPU, 1 GB, all month | ≈ $10.63 |
| Public IPv4 address of the task | 730 h × $0.005 | ≈ $3.65 |
| KMS key | the owner's key, outside the stack: $1 a month; the worker's requests $0.03 per 10 000 | (≈ $1.00, already running) |
| Secrets Manager | one secret | $0.40 |
| CloudWatch Logs | ≈ 1 GB written, 90 days kept | ≈ $0.55 |
| ECR | up to 5 images | ≈ $0.20–0.60 |
| S3 audit seals, STS, data out (first 100 GB free) | kilobytes a day | < $0.10 |
| **Total for the stack, worker running** | | **≈ $15–16** |
| **Total for the stack while `DesiredCount` is 0** | secret, images | **≈ $0.60–1** |

Not AWS, but caused by it: a running worker holds a connection, so the Neon compute no longer suspends — about 183
compute-unit hours a month at 0.25 CU. Whether that is inside the Neon plan or billed is on the Neon billing page.

**Vercel's access to KMS** (made by the owner, 2026-10-12). Vercel → project → Settings → Security → *Secure backend
access with OIDC federation*: on, issuer mode *Team*; the role `arn:aws:iam::075774506744:role/inrp2p-vercel-web`,
`AWS_REGION=eu-north-1`. The role should trust `oidc.vercel.com/<team>` for `owner:<team>:project:inr463rergr:
environment:production` only, so previews and development cannot assume it. The web app reads the token Vercel puts
on each request and exchanges it at STS (`packages/adapters/src/aws-kms.ts`).

**Logins.** `scripts/database-logins.ts prepare` writes each login's connection string, with a fresh password, to a
local env file (mode 0600); `apply`, run by the owner role, creates the login if missing, makes it a member of its group
only and sets that password — as a SCRAM verifier on PostgreSQL (the password never reaches the server), as the
password itself on Neon, whose control plane takes role changes, accepts no verifier and stores it hashed (found in
the rehearsal) — then runs the release's deployment check as each. On Neon, roles belong to a branch: logins made on a
copy do not exist in production.

### The first transition (23 → 36)

Release `d0cc778` (schema 23) → this release (36). The rules of §2 hold: no rolling path, a short window, roll forward.
The site is down from step 8 until step 13.

Nothing sealed in production is moved to KMS. The only sealed values are the bank accounts of CL-0003 and CL-0004,
random test details the owner added (owner, 2026-10-11): the desk archives them in step 15, the ordinary way, and
`prod-v1` is retired with them. The re-seal (`scripts/reseal-fields.ts`) is not a step of this transition.

**Before the window — nothing changes in production:**

1. This release is reviewed and merged to `main`; its CI is green on the merge.
2. AWS (after the costs above are accepted): in `us-east-1`, create the stack from `deploy/aws/inrp2p-aws.json` with
   `DesiredCount` 0, `VpcId`/`SubnetIds` of the default VPC, `FieldKeyArn` (default: the owner's key). Note the outputs.
3. GitHub → Settings → Variables: `AWS_REGION=us-east-1`, `AWS_IMAGE_PUSH_ROLE_ARN` (output). Run *Worker image (ECR)*
   on `main`; update the stack's `WorkerImage` to the digest it prints (still `DesiredCount` 0).
4. Locally: `DATABASE_MIGRATOR_URL=… node scripts/database-logins.ts prepare --env-file ~/.config/inrp2p/neon-production.env --prefix PROD_`.
5. Secrets Manager `inrp2p/worker`: `WORKER_DATABASE_URL` = `PROD_WORKER_DATABASE_URL` from the file; `RESEND_API_KEY`;
   `INRP2P_FIELD_HMAC_BASE64` = the value Vercel has today (the lookup key does not change); `INRP2P_TRON_PRIMARY_KEY` or
   empty.
6. Vercel: OIDC federation on (above); production environment variables as listed in "What production still needs"
   below — `DATABASE_URL` = `PROD_DATABASE_URL` from the file, `INRP2P_KEK_ID` = the new KMS key's id. Setting them
   does not deploy anything.
7. Decide the undelivered notifications (below). Decided 2026-10-12: inbox entries kept, stale emails not sent.

**Where production stands (2026-10-12).** Steps 8–10 and 13–15 are done: the recovery branch `before-36-20261012`
(owner), the migration (11:31:41–11:31:50 UTC, `main` `849c8adc`; schema 36, the release's restore checks equal before
and after), both logins (passing the deployment check), the Vercel redeploy (`ready` 200 on www, app and desk), new
business paused (12:15 UTC), and both test accounts archived from the desk (12:18 and 12:19 UTC, audited under the
operator). Waiting: the stack and the worker image (steps 2–3, 5), then step 11 is nothing to do — the release with
the stale-email rule is the worker that starts — and steps 12, 16–18.

**The window:**

8. Note the time; Neon → Branches → create `before-36-<date>` from production (the recovery point). Confirm nothing
   else is connected (`preflight`: no sessions; no worker has ever run in this production).
9. `pnpm db:migrate` as `neondb_owner`, direct connection. `select inrp2p_schema_version()` = 36.
10. `scripts/database-logins.ts apply --env-file … --prefix PROD_`: both logins pass the deployment check.
11. The undelivered notifications, as decided in step 7: nothing to run by hand — the worker's email channel withholds
    stale emails itself (below).
12. The worker: the image built from the `main` that carries that rule; stack `DesiredCount` 1. Its log shows the configuration accepted and its first heartbeat; System →
    worker heartbeat present; the outbox drains.
13. Vercel: redeploy production. `https://app.inrp2p.com/api/health/ready` (and desk, www) answer 200.
14. Desk → System → New business → **Pause** ("transition checks"): no new request, quote or acceptance while the two
    test accounts are still active. (Until they are archived, nothing could pay them anyway: the release holds no key
    that opens them, and a payout needs the number revealed — it fails closed.)
15. The two test accounts, from the desk: Clients → CL-0003 → Bank accounts → **Archive**, reason "Random test details
    added by the owner; never a real account (D-18)", confirmed with the authenticator (OWNER or SUPPORT); then CL-0004.
    It is the desk, not the clients: both are traders only (Exchange closed), so their own Destinations page is not
    open to them, and their administrators have no authenticator. The command needs no key and is audited
    (`client_bank.archived`, the operator who did it); the client is told (`DESTINATION_ARCHIVED`). Afterwards no
    request, quote, payout, refund, destination change or trader reward can use them, and the desk will not reveal them
    — nothing tries to decrypt them. The traders keep their status; a reward to them would need a new bank account,
    which is then sealed under KMS.
16. Checks: System health (expected alarms aside: `restore_drill_age_days`); a sign-in code arrives; a trader's reserve
    page shows the shared address; `preflight` shows the two sealed values under `prod-v1` both `ARCHIVED`, and no
    other sealed value.
17. Desk → System → New business → **Resume**.
18. Afterwards: remove `INRP2P_KEK_BASE64` from Vercel. `prod-v1` protects nothing anyone will read — two archived test
    accounts, in the database and in older Neon branches alike — so it need not be kept.

**If step 9–13 fails:** do not start `d0cc778` against 36 (§2). Fix forward, or restore Neon to the step-8 branch —
the restore fence then holds outgoing payments until two people reconcile — and redeploy `d0cc778`.

### The notifications the release at 23 left undelivered

No worker ever ran in this production, so its outbox waits: the 14 events the release at 23 left, and since
2026-10-12 the two of the test accounts' archiving. When the worker starts it delivers them to their handlers, which
are idempotent and act on the rows as they are *now*. **Decided (owner, 2026-10-12): the inbox entries are kept;
stale emails are not sent.** The email channel withholds the email of any event more than `EMAIL_STALE_AFTER_HOURS`
(24) old when it is first dispatched (`packages/notifications/src/email.ts`) — this backlog, and any after a worker
outage — and the worker logs `client_email.withheld_stale`; the inbox entry is written as always. Nothing is changed in
the database by hand.

Production's pending events, read on 2026-10-12 at 12:27 UTC (read-only), and what the worker does with each:

| # | Written (UTC) | Event | Client | About | Inbox | Email today's code | Email with the rule |
|---|---|---|---|---|---|---|---|
| 1 | 09-20 16:23 | `desk.new_request` | — | RQ-260920-0001, accepted | — | — | — |
| 2 | 09-20 16:58 | `quote.sent` | CL-0001 | QT-260920-0001, cancelled | `QUOTE_SENT` | sent | withheld |
| 3 | 09-20 17:02 | `quote.sent` | CL-0001 | QT-260920-0002, accepted | `QUOTE_SENT` | sent | withheld |
| 4 | 09-20 17:05 | `trade.opened` | CL-0001 | IX-260920-0002, cancelled | `TRADE_OPENED` | — | — |
| 5 | 09-27 15:59 | `desk.new_request` | — | RQ-260927-0002, withdrawn | — | — | — |
| 6 | 09-28 19:10 | `trader.applied` | CL-0003 | | — | — | — |
| 7 | 09-28 22:12 | `client.trade_cancelled` | CL-0001 | IX-260920-0002 | `TRADE_CANCELLED` | sent | withheld |
| 8 | 09-28 22:16 | `client.destination_added` | CL-0003 | bank account ••••8634 | `DESTINATION_ADDED` | sent | withheld |
| 9 | 09-28 22:16 | `client.destination_added` | CL-0003 | wallet | `DESTINATION_ADDED` | sent | withheld |
| 10 | 09-28 22:18 | `trader.approved` | CL-0003 | | `TRADER_APPROVED` | sent | withheld |
| 11 | 10-10 02:16 | `trader.applied` | CL-0004 | | — | — | — |
| 12 | 10-10 02:18 | `client.destination_added` | CL-0004 | bank account ••••2187 | `DESTINATION_ADDED` | sent | withheld |
| 13 | 10-10 02:19 | `client.destination_added` | CL-0004 | wallet | `DESTINATION_ADDED` | sent | withheld |
| 14 | 10-10 02:20 | `trader.approved` | CL-0004 | | `TRADER_APPROVED` | sent | withheld |
| 15 | 10-12 12:18 | `client.destination_archived` | CL-0003 | bank account ••••8634 | `DESTINATION_ARCHIVED` | sent | sent until 10-13 12:18, withheld after |
| 16 | 10-12 12:19 | `client.destination_archived` | CL-0004 | bank account ••••2187 | `DESTINATION_ARCHIVED` | sent | sent until 10-13 12:19, withheld after |

Twelve inbox entries either way. Today's code would send 11 emails; with the rule none of 2–14 goes, and 15–16 go only
if the worker starts within a day of the archiving (to the owner's own test clients). Each client has one verified
recipient. The two `desk.new_request` find their requests closed and offer nothing to a trader; the two `quote.sent`
schedule an expiry that finds the quotes closed — no-ops, as the rehearsal showed.

### What production still needs

Vercel, project `inr463rergr`, environment *Production* (names only; values come from the owner's accounts):

| Setting | Value / source | Today |
|---|---|---|
| `INRP2P_ENV` | `production` | check |
| `DATABASE_URL` | `PROD_DATABASE_URL` from the local file (`inrp2p_app_login`, pooled) | set (2026-10-12) |
| `DESK_HOST`, `APP_HOST`, `PUBLIC_HOST` | `desk.inrp2p.com`, `app.inrp2p.com`, `www.inrp2p.com` | check |
| `OPERATOR_AUTH_SECRET`, `CLIENT_AUTH_SECRET` | ≥ 32 characters, different; keep today's values so sessions survive | check |
| `INRP2P_HEALTH_TOKEN` | ≥ 32 random characters; the monitor's | new |
| `INRP2P_KEK_PROVIDER`, `INRP2P_KEK_ID`, `INRP2P_KMS_KEY_ARN` | `aws-kms`, `kms-2026a`, the owner's key in `eu-north-1` | set (owner) |
| `INRP2P_FIELD_HMAC_BASE64` | **unchanged** | exists |
| `AWS_ROLE_ARN`, `AWS_REGION` | `arn:aws:iam::075774506744:role/inrp2p-vercel-web`, `eu-north-1` | set (owner) |
| `RESEND_API_KEY`, `RESEND_FROM` | Resend, a sender on the verified domain | not seen (no Vercel access) |
| `INRP2P_TRON_PRIMARY_URL`, `INRP2P_TRON_PRIMARY_GROUP`, `INRP2P_TRON_PRIMARY_KEY`, `INRP2P_USDT_CONTRACT` | the TRON provider; `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` | new |
| `INRP2P_TRON_SECONDARY_*` | a second, independent provider (D-05) | optional; without it large amounts do not confirm |
| `INRP2P_CUSTODY_PROVIDER` | the name of the custody provider whose pool addresses SELL deposits go to (D-02) | new |
| `INRP2P_KEK_BASE64` | removed (step 18): `prod-v1` is retired, not moved | exists |

The desk's own records, entered in the desk once the release runs (System health shows both in alarm until then):
the exchange's INR settlement and collection accounts with their daily capacity (`inr_capacity_available`), and the
custody provider's pool of TRC20 deposit addresses SELL deposits go to (`deposit_pool_free`, D-02). Until they exist,
no SELL trade can be accepted and no INR payout planned — nothing wrong happens, nothing happens.

AWS: the stack's parameters (`VpcId`, `SubnetIds`, `WorkerImage`, `FieldKeyArn`, retention), created in `us-east-1`, and the secret
`inrp2p/worker` (`WORKER_DATABASE_URL`, `RESEND_API_KEY`, `INRP2P_FIELD_HMAC_BASE64`, `INRP2P_TRON_PRIMARY_KEY`). The
worker's other settings are in the task definition.

## 11. The exchange's own USDT rails (ADR 0017)

What the owner sets up once, in this order. Nothing is spent and nothing is sent before step 8.

1. **Migration 37.** `DATABASE_MIGRATOR_URL=… node scripts/migrate.ts` (36 → 37); the release's deployment check then
   requires 37.
2. **A KMS key for the custody seed**, made by the owner (symmetric, `ENCRYPT_DECRYPT`; in the worker's region or any
   other — KMS allows the cross-region grant): the owner's own principal may Encrypt; the worker's task role gets
   Decrypt from the stack (`CustodyKeyArn`, below), only under `{app: inrp2p, purpose: custody-seed}`. About $1 a month.
3. **The seed.** On the owner's own machine, with an AWS session that may use that key:
   `node scripts/custody-seed.ts new` (RUNBOOKS `custody-seed`) — 24 words on paper twice; it prints the sealed seed,
   the account key, the budget wallet, the pool record address and deal address #0.
4. **Secrets and settings.** Secrets Manager `inrp2p/worker`: add `INRP2P_CUSTODY_SEED_SEALED` (an existing secret
   needs the key added by hand — the template's default applies only when the secret is created; without the key the
   task does not start). Stack parameters: `CustodyKeyArn` = the key's ARN (`CustodyKekId` stays `custody-v1`). Vercel,
   Production: `INRP2P_CUSTODY_PROVIDER=hd-wallet`, `INRP2P_CUSTODY_CAPABILITY=DERIVED`, `INRP2P_CUSTODY_XPUB=xpub…`;
   redeploy. `node scripts/custody-seed.ts verify` with the sealed value and `INRP2P_CUSTODY_XPUB` says they match.
5. **Register the wallet.** Desk → **Network** → *Register the exchange's HD wallet* (OWNER, authenticator): the budget
   wallet and the pool record address as the script printed them. From now on every new trade gets its own address.
6. **Publish the TRX price** (Network → TRX price, in USDT per TRX, with its source). Keep it fresh: quotes stop after
   72 hours without one (`trx_price_age_seconds`, TD-30).
7. **Start the worker** (`DesiredCount` 1). Its log says `custody signer: signing for hd-wallet (budget wallet T…)`;
   within ten minutes the Network page shows what one transfer costs.
8. **Fund the network.** Each trader sends TRX from its registered wallet to the budget wallet and hands in the hash
   on its Traders → Network deposit page (≈ 20 TRX per open Buy order, ≈ 40 TRX per open Sell order at today's
   prices; 200 TRX covers several orders at once). The platform budget needs TRX only for desk routes (≈ 40 TRX per
   open desk-route SELL) — trader-routed trades need none.

**The first controlled trade.** Pick one approved trader with a network deposit, a client the desk knows, and an
amount above the payout two-person threshold so a second person approves the transfer (C1).

1. Price the request on the desk: the builder shows the trader's reward, the network fee (≈ 18 TRX in INR at today's
   prices) and the net margin; a rate below the break-even is refused and the builder says by how much.
2. The client sees the exact amount it pays and receives, "nothing is deducted", and accepts.
3. BUY: the client pays INR as usual; the trader delivers USDT to the order's own address; once both are confirmed
   the payout appears on **Network → Sends** as *Needs approval* — a second person approves it, the signer tops the
   deal address up with TRX, signs and sends the USDT straight to the client's wallet; the leg completes when TRON
   makes it final (the client's screen shows the transaction hash meanwhile). SELL: the client sends USDT to the
   trade's own address; once the trader's INR is confirmed, the signer pays the trader from that address.
4. After completion: the trade's **Network** block shows what the price carried, what the network actually cost and
   what the trade left; the trader's Network deposit page shows the order's TRX spent and the INR paid back with its
   rewards; the budget wallet's chain balance matches the records on the Network page.

