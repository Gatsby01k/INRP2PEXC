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

CI's `upgrade` job proved the data side of this transition while it was the next one. It now proves the next one, from
the release at 45 (§ Stage 3), the same way (`scripts/upgrade-check.ts`).

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
| `TELEGRAM_LOGIN_CLIENT_ID`, `TELEGRAM_LOGIN_CLIENT_SECRET` | ✔ | | secret ✔ | optional (ADR 0026): Log In with Telegram, from @BotFather → the alerts bot → Login Widget; needs `TELEGRAM_BOT_TOKEN`/`_USERNAME` too |
| `ANTHROPIC_API_KEY`, `ROBOT_AI_MODEL` | ✔ | | key ✔ | optional (ADR 0034): the robot's model answers, used only after the owner switches answers to *rules, then a model*; model defaults to `claude-opus-5-5` (`claude-haiku-5-5` costs far less) |
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
database itself recognises the owner (`inrp2p_is_application_session()`, migration 0027). In the web app that check runs
before the process's first statement rather than at its start, and nothing reaches the database until it has passed: the
proxy — a process of its own on Vercel, at the edge — never uses the database and so never checks it (ADR 0021 §4).

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
(daily), `deposit_address_cooldown_release`, `quote_expiry_sweep`, `settlement_sla`,
`settlement_reconcile` (daily), `tron_scan`, `tron_confirm`, `tron_orphan_sweep`, `tron_backfill`, `custody_observe`,
`trader_orders_sweep`, `receipt_store_backfill`, `worker_heartbeat`, and the exchange's own rails (ADR 0017): `onchain_cycle`
(every minute and on every planned send: plan payouts, fuel and sign, follow transactions to the end, close holds) and
`network_fee_refresh` (every 10 minutes: the chain's energy and bandwidth prices), `trx_rate_refresh` (hourly: the TRX
price from Kraken and CoinGecko — outbound HTTPS to api.kraken.com and api.coingecko.com). Every job is state-guarded and safe
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
repository, the worker's secret (created with `SET-ME` placeholders, filled in the console — plus
`INRP2P_CUSTODY_SEED_SEALED`, added by hand and empty until a custody seed exists; the template never changes the
secret's value after creation), log group, cluster, task
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
    request, quote, payout, refund or destination change can use them, and the desk will not reveal them
    — nothing tries to decrypt them. The traders keep their status; a deal with them would need a new bank account,
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

The desk's own record, entered in the desk once the release runs (System health shows it in alarm until then): the
custody provider's pool of TRC20 deposit addresses SELL deposits go to (`deposit_pool_free`, D-02). Until it exists, no SELL
trade can be accepted — nothing wrong happens, nothing happens.

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
4. **Secrets and settings.** Secrets Manager `inrp2p/worker`: add `INRP2P_CUSTODY_SEED_SEALED` by hand, **before** the
   stack update — the task definition reads that key, and without it the task does not start. The template never
   carries it: the secret's placeholder in the template is frozen (a changed placeholder would make the stack update
   overwrite every value filled in by hand with `SET-ME`; a unit test holds it). Stack parameters: `CustodyKeyArn` = the key's ARN (`CustodyKekId` stays `custody-v1`). Vercel,
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

1. Price the request on the desk: the builder shows the network fee and the net margin; a rate below the break-even is
   refused and the builder says by how much.
2. The client sees the exact amount it pays and receives, "nothing is deducted", and accepts.
3. BUY: the trader's USDT reaches the deal's escrow; the client pays the trader's account; the trader confirms the rupees
   against its bank; the payout appears on **Network → Sends** as *Needs approval* — a second person approves it, and the
   signer sends the USDT straight to the client's wallet; the leg completes when TRON makes it final (the client's screen
   shows the transaction hash meanwhile). SELL: the client's USDT reaches the escrow; the trader pays the client's account;
   the client confirms the rupees against its bank, and the signer releases the USDT to the trader.
4. After completion: the trade's **Network** block shows what the price carried, what the network actually cost and
   what the trade left; the budget wallet's chain balance matches the records on the Network page.

## 12. Removed: Clean INR

ADR 0018's collecting account, statements and payment window are gone (ADR 0027): rupees go straight between the two sides.

## Stage 3: migration 46, only P2P remains (ADR 0027)

From schema 45. It drops the tables and columns of the old settlement models and refuses, whole, if any of them ever carried
money. It cannot be undone except from the backup below, and the web app and worker serve only the schema they were built for,
so the steps below are one release, with a short window where the site answers 503. Nothing here is done without the owner.

1. **Ask first, change nothing.** `DATABASE_MIGRATOR_URL=… node scripts/p2p-only-preflight.ts`, from the commit of this
   release, on the direct (non-pooler) endpoint. It runs the migration's own checks in a read-only transaction. Exit 1 lists
   what the migration would refuse over: stop there, and the owner decides what those rows are.
2. **The backup of record:** a Neon branch of production named `before-46-<date>`. It is the only way back.
3. **Stop the worker** (ECS desired count 0) and confirm its last heartbeat. With no deal open it may stay up: an old worker
   only logs errors until step 6, and a migration that deadlocks against it rolls back whole and can simply run again.
4. **Migrate.** `DATABASE_MIGRATOR_URL=… node scripts/migrate.ts` (45 → 46), through the migrator login on the direct endpoint.
   A refusal changes nothing: go back to step 1.
5. **The web app.** Merge the release to `main`; Vercel deploys it. It is ready once `/api/health/ready` answers 200 on the
   public, app and desk hosts. Merged before step 4, the site would answer 503 until the migration ran: this order keeps that
   window to the deployment.
6. **The worker.** The *Worker image* workflow builds only from `main`, so run it now, update the stack to the digest it
   prints (`inrp2p-worker@sha256:…`, not a tag), start it, and confirm its heartbeat and `onchain_cycle`.

If the release does not come up: fix forward, or recover from the branch of step 2 and redeploy the previous release. CI's
`upgrade` job proves the data side on every change: the release at 45 writes its own data and seals its audit log, and this
release carries it to 46 with nothing lost, the books balanced and the seal chain continued (`scripts/upgrade-check.ts`).

## 13. P2P escrow (ADR 0019)

For a desk with no Indian bank account: the rupees go straight between client and trader, INRP2P holds the USDT.

1. **Migration 39.** `DATABASE_MIGRATOR_URL=… node scripts/migrate.ts` (38 → 39); the release then requires 39. Nothing
   changes until the programme says P2P.
2. **The programme settles P2P.** Every trader route is P2P: migration 46 moves any older one, and a live route can be nothing
   else. Before it, at schema 45, an older route refuses acceptance until Desk → Traders → Programme is saved once.
3. **The platform's TRX budget.** P2P transfers are paid from the platform's budget, not a trader's deposit: send TRX
   from a wallet no trader registered to the budget wallet and record it on the Network page (*Record a top-up*,
   *the platform's own*). Each deal holds about two transfers' worth until it closes.
4. **Every trader's and client's own bank account.** A trader is paid into, and pays from, the account on its trader
   file; a client likewise from its registered account. The counterparty's account is shown only to the side that pays,
   only while it is to pay.
5. **The client rate on assignment.** A P2P order is sized at the client rate the desk will quote: *Assign* asks for it,
   and the quote must use exactly that rate.

The worker's `escrow_deadlines` job (every minute) cancels a deal whose seller did not fund the escrow in 30 minutes
(the trader of a BUY, the client of a SELL) or a BUY not paid in time — the trader's USDT then goes back by the signer —
and gives the desk a case for a late payment or a late confirmation (RUNBOOKS `p2p-escrow`). An unfunded escrow is
cancelled only once the deposit scanner has completed a read of the whole chain 5 minutes past its deadline and nothing
is on its way into it, so it does nothing while chain monitoring is down. It needs nothing configured; the signer must
be switched on for escrow returns to be sent.

## 14. Desks (ADR 0020)

### 14.0 The release from production at 37 (stage 1 of desks)

Production stopped at schema 37 on 2026-10-16 (new business paused, the signer's automatic sends off). This release
carries 38 (§12), 39 (§13) and 40 (below) at once, with one web deployment and one worker image. In order:

1. **The code.** The branch merged to `main` with all seven CI jobs green on its final commit — `visual-pages` against
   baselines recorded by the canonical workflow (the desk's, the P2P and the Desks/Revenue pages are new) — and the
   worker image built for that commit by the *Worker image* workflow (`inrp2p-worker@sha256:…`, not a tag).
2. **Stop the worker** (ECS desired count 0) and confirm its last heartbeat. Nothing may write while the schema moves.
3. **The backup of record**: a Neon branch of production named `before-40-<date>` (a physical copy: the audit seal chain
   restores intact). A logical JSON-rows backup as on 2026-10-16 may be taken beside it, but it cannot tell a JSON `null`
   from SQL `NULL` in `jsonb` columns, so the first audit seal of a database restored from it does not verify (seen in
   the rehearsal below) — it is not the backup to roll back to.
4. **Migrate 37 → 40** through the migrator login on the direct (non-pooler) endpoint:
   `DATABASE_MIGRATOR_URL=… node scripts/migrate.ts`. Rehearsed on 2026-10-23 on a local copy of production's rows (the
   2026-10-16 backup, at 36): 37–40 applied in 75 ms; trades, journals, entries, audit events and seals the same before
   and after, not one audit or ledger row changed; every read model of the release answered on that data.
5. **The web app.** Vercel deploys `main` on merge; it is ready once `/api/health/ready` answers 200 on the public, app
   and desk hosts (it checks schema 40 through the application login). Optional new settings: `TELEGRAM_*` (item 6 below).
6. **The worker image.** Update the stack to the image digest of step 1 (a change set, as on 2026-10-16), start it, and
   confirm its heartbeat and `onchain_cycle`. The signer stays off for automatic sends until step 8.
7. **What the owner decides on the desk**, in this order: the programme to **P2P** (§13 item 2); the TRX price renewed
   (Network); each trader's TRX network deposit sent from its registered wallet (item 2 below); the revenue wallet
   registered (item 7 below).
8. **Resume**: the signer's automatic sends on, then new business open — once the first controlled deal has settled
   end to end.

1. **Migration 40.** `DATABASE_MIGRATOR_URL=… node scripts/migrate.ts` (39 → 40), with the backup taken as for 37; the
   release then requires 40, the web app and the worker image alike. Nothing changes for open deals.
2. **P2P network fees move to the traders.** From 40 on, every new P2P quote is funded by its trader's network deposit
   (IX103): before switching the programme to P2P, each trader sends TRX from its registered wallet to the budget wallet
   (Traders → Network deposit) — about 40 TRX holds one open deal at today's prices. The platform's own TRX is no longer
   used by P2P deals; a P2P trader without TRX receives no orders (`NETWORK_DEPOSIT_SHORT`).
3. **Fees.** `fee_policy` starts at 0.25% (own deal) and 0.6% (network deal, stage 2). A change is proposed on
   *Desks* → Fee by someone with `fees:propose` and approved by another person with `fees:approve` (block 11).
4. **Team invitations are emailed** by the worker (`client_invite.send`, handler `team_invite_email`), registered whatever
   the email configuration, like acceptance codes: without `RESEND_*` they fail visibly, and an invited person can still
   sign in and accept on the client app. Links in them use `CLIENT_BASE_URL`.
5. Desks themselves need nothing configured: an approved trader's administrator opens one under **Desk** in the client
   workspace. Its page is `PUBLIC_BASE_URL/<handle>` and its links
   `PUBLIC_BASE_URL/d/<token>`, both on the public host; taking a deal from either happens in the client app (`/desks/<handle>`,
   `/d/<token>`), after signing in.
6. **Telegram alerts (optional).** Create a bot with @BotFather. On the worker (AWS): add `TELEGRAM_BOT_TOKEN` to the
   secret `inrp2p/worker` by hand **first** (a task whose secret lacks a referenced key does not start), then update
   the stack with the current template and the parameter `TelegramBotUsername`. On the web app and the worker alike,
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` (without @) and, on the web app, `TELEGRAM_WEBHOOK_SECRET` (24+ random
   characters). Then point the bot at the public host once:
   `curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" -d url="$PUBLIC_BASE_URL/api/telegram/webhook" -d secret_token="$TELEGRAM_WEBHOOK_SECRET" -d allowed_updates='["message"]'`.
   Without these, no "Connect Telegram" is shown and the worker registers no Telegram channel.
7. **INRP2P's earnings (block 10).** Register the platform's **revenue wallet** on *Revenue* (an address INRP2P holds the
   keys of — a hardware wallet or its cold wallet, never a deal address or an exchange account). Until it is registered
   nothing is swept: earnings stay, safe, at their deal addresses. Sweeps are paid from the **platform's** TRX budget
   (Network budget → record a TRX deposit to the budget wallet as the platform's); without platform TRX they wait. Set
   the minimum an address must hold to be worth a sweep on *Revenue* → Sweeping (default 20 USDT). TRX reclaims from idle
   deal addresses need nothing configured.
8. **INRP2P's controls over desks (block 11).** *Desks* (`/desk-ops` on the operator host) needs `desks:view` (OWNER,
   DEALER, FINANCE); suspending, hiding a page and renaming need `desks:moderate` (OWNER, DEALER) and a step-up; the fee
   needs two people (`fees:propose`, `fees:approve`: OWNER, FINANCE). Nothing to configure; the desk is told each decision
   in the app and, when connected, in Telegram.

## 15. Network fees in USDT through GasFree (ADR 0022)

Migration `0041` (schema 41) adds GasFree but **does not switch it on**: production keeps TRX deposits (`BURN`), as at
40, and nothing has to be configured for the release. Once switched on (step 4), new P2P deals get GasFree accounts as
their addresses and carry their network in USDT; nobody prepays anything — no TRX for desks, no float for the platform.
Deals already accepted keep their terms and addresses.

1. **Release order** (from production at 40): the code on `main` with all CI jobs green; stop the worker; a Neon branch
   `before-41-<date>`; `node scripts/migrate.ts` through the migrator login (direct endpoint); Vercel ready on 41; the
   worker image of the same commit. Nothing on Vercel changes: the web app derives GasFree addresses itself and never
   calls GasFree.
2. **A GasFree API key** (developer.gasfree.io, the owner's account, free): `GASFREE_API_KEY` and `GASFREE_API_SECRET`.
   First on Nile (`GasFreeNetwork = nile`, a staging stack) for the walkthrough in RUNBOOKS `gasfree`, then mainnet.
3. **The worker's secret first, then the stack.** Add `GASFREE_API_KEY` and `GASFREE_API_SECRET` to `inrp2p/worker`
   (empty strings until GasFree is used) **before** updating the stack: ECS refuses to start a task that names a key the
   secret does not have. Then update the stack with `GasFreeNetwork`, all other parameters `UsePreviousValue`. The worker
   logs `GasFree: mainnet` at start and refuses to start on half the credentials. Within ten minutes it reads GasFree's
   fees from the controller (`gasfree_fee_refresh`; the Network page shows them).
4. **Switching deals to GasFree** is one policy change (*Network* → *Deal on GasFree*, step-up), refused until the fees
   were read within the hour. **Back to TRX deposits** is the same switch the other way, never refused; deals already
   on GasFree finish on GasFree.
5. **Desks** need nothing: no deposit, no TRX. TRX left in old network deposits stays withdrawable on *Network deposit*.
6. **Custody (accepted by the owner, ADR 0022 §3):** while a deal is open its USDT sits in a GasFree account and moves only
   through GasFree. If GasFree stops answering, deals wait (RUNBOOKS `gasfree`); the health check
   `gasfree_permits_stuck` says so.


## 16. A P2P deal's chat and its time to pay by rail (ADR 0023)

Migration `0042` (schema 42) adds the deal chat (`deal_message`, `deal_file`), the per-deal pay window
(`p2p_pay_window`) and the programme's `p2p_timing` (UPI 15 / IMPS 30 / NEFT 60 / RTGS 45 minutes to pay, NEFT 180 and
RTGS 90 to confirm, a 5-minute final period). Deals waiting for their rupees at the migration keep their 30 minutes. No
new secret, bucket or service: chat files are stored in the database (3 MB each), and server actions accept up to 4 MB.

1. **Release order** (from production at 41): the code on `main` with all CI jobs green; stop the worker; a Neon branch
   `before-42-<date>`; `node scripts/migrate.ts` through the migrator login; Vercel ready on 42; the worker image of the
   same commit. The web app and the worker must both be at 42: the worker opens, warns and closes the pay windows, the
   web app shows them.
2. **Times** are changed on the desk, Traders → Programme → "P2P deal times" (`traders:configure`, ⧗); a running deal
   keeps the times it opened with.
3. **Support calls** arrive on the desk's queue as "Support called to a deal chat" (`P2P_SUPPORT`, a warning, never a
   hold); INRP2P answers in the deal's chat on the trade's panel and closes the case with "Answered in the deal chat".

## 17. Sign in with email or Telegram, confirm with another factor (ADR 0026)

Migration `0043` (schema 43) records how each session was opened, lets a step-up be a code to the email or to Telegram,
and keeps a person's linked Telegram as Better Auth's account row. Client sessions now last 30 days (7 without use).

1. **Release order** (from production at 42): the code on `main` with all CI jobs green; a Neon branch
   `before-43-<date>`; `node scripts/migrate.ts` through the migrator login; Vercel ready on 43; the worker image of the
   same commit (it checks the schema version too). Sessions opened before 43 keep working and read as opened by email.
2. **Log In with Telegram (optional, recommended).** In @BotFather open the alerts bot (`TELEGRAM_BOT_USERNAME`) → *Login
   Widget*: add the allowed URLs `https://<APP_HOST>` and `https://<APP_HOST>/api/auth/callback/telegram` (exactly
   `CLIENT_BASE_URL` + that path), keep the signing algorithm RS256, and copy the Client ID and Client Secret into the web
   app's `TELEGRAM_LOGIN_CLIENT_ID` and `TELEGRAM_LOGIN_CLIENT_SECRET` (the secret is a secret). Redeploy. "Continue with
   Telegram" then appears on the client sign-in, and "Connect Telegram" in Account & security. Without them, sign-in and
   confirmation are the email code and the authenticator, and Telegram alerts link by their `/start` code as before.
3. **Nothing to tell clients first.** A client with only their email who next adds a second bank account, withdraws, or
   changes the team is asked to connect Telegram or set up an authenticator — in place, in a minute.
4. **A lost Telegram** is disconnected by the desk after confirming the person: `client_user.reset_mfa` with
   `factor: 'TELEGRAM'` (OWNER or SUPPORT, step-up, a reason). It ends every session of that person.

## 18. Onboarding by rule and limits from the reserve (ADR 0024)

Migration `0044` (schema 44) adds to the programme `auto_review` (**off**), `risk_policy` (**on**, the default levels) and
`settlement_change_hold_hours` (24); to each trader `approved_at` (filled from the last review of approved and paused
traders), `auto_review_flags`, `auto_reviewed_at`, `proposal_effective_at`, `proposed_by`; IX138; and the inbox kind
`TRADER_SETTLEMENT_CHANGE`. No new secret or service.

1. **Release order** (from production at 43): CI green on the commit; stop the worker; a Neon branch `before-44-<date>`;
   `node scripts/migrate.ts` through the migrator login; Vercel ready on 44; the worker image of the same commit. The
   worker runs the review (`trader_auto_review` handler) and applies due changes (`trader_orders_sweep`).
2. **Before switching auto-review on:** the programme's default Security Reserve must be set (an application is never
   approved by rule without it). Then Traders → Programme → "Approve traders by rule"; every application already waiting
   is reviewed at once.
3. **Limits** are on from the release. Check each live trader's "Open of limit" on Traders: a trader whose open deals are
   already above its new limit keeps them; it receives nothing new until they finish or it deposits more. Change the
   levels, or switch the limits off, in the same form (⧗).
4. **A payee change already waiting** at the migration has no hold clock: the desk decides it as before.

## 19. Automatic prices (ADR 0025)

Migration `0045` (schema 45) adds `pricing_policy` (seeded **off**), the traders' firm offers and rails on `trader_block`,
`auto_quote`, `rfq`, `rfq_invite`, `rfq_bid` and the inbox kind `TRADER_PRICE_REQUEST`. No new secret or service: the worker
reads two public order books (WazirX, CoinDCX) with no key.

1. **Release order** (from production at 44): all CI jobs green; stop the worker; a Neon branch `before-45-<date>`;
   `node --env-file=$HOME/.config/inrp2p/neon-production.env scripts/migrate.ts`; Vercel ready on 45; the worker image of
   the same commit (it runs `reference_rate_refresh` every five minutes and `rfq_sweep` every minute).
2. **Before switching on**: the worker has published both references (Rates → Automatic prices shows their age); traders
   have made at least one side firm (Traders → their side → Instant orders); `network_fee_policy` and GasFree fees are fresh.
3. **Switch on** on Rates → Automatic prices (`pricing:configure`, ⧗, with the reason). Price requests are a second switch.
   Switching off is never refused: requests then wait for a person.

## 20. The fully automatic exchange (ADR 0028)

Migration `0047` (schema 47) adds a side's market rate and its open-ended firm offer to `trader_block`, how an order's market
rate was derived to `trader_order` (IX143), the client's network line to `quote` and `trade_economics` (IX144) and
`trade_request.no_price_reason`. No new secret, service or job.

1. **Release order** (from production at 46): all CI jobs green; stop the worker; a Neon branch `before-47-<date>`;
   `node --env-file=$HOME/.config/inrp2p/neon-production.env scripts/migrate.ts`; Vercel ready on 47; the worker image of
   the same commit. Quotes sent before the migration keep their terms (their network out of the margin) and are accepted
   as they were; every quote made after it carries the client's network line.
2. **Traders**: on their side, "Your rate → Follow the market" with their margin (and, if they want, the rate they never go
   past), then "Instant orders → On until I turn it off". A fixed rate still works, firm for at most seven days.
3. **Switch on** automatic prices and price requests on Rates → Automatic prices, as in §19. From then on a request nothing
   prices honestly closes with a plain answer to the client; nothing is left in the desk's queue for pricing.

## 21. One price for a trader (ADR 0028 §2.7)

Migration `0048` (schema 48) lets a desk's price follow its side (`desk_price.basis`, `rate_micro` and `valid_until` empty for
it). Nothing else in the schema changes; no new secret, service or job.

1. **Release order** (from production at 47): all CI jobs green; a Neon branch `before-48-<date>` (or note the time and WAL
   position: the history is the restore point); `scripts/migrate.ts` with the production env; then merge — Vercel deploys
   `main` at once, and the app at 48 refuses a database at 47. The worker image of the same commit after (it checks the
   schema when it starts).
2. Existing desk prices keep their numbers and their time; a desk changes a direction to "As on Traders" on Prices.

## 22. A deal's hand-offs, and the ways to pay a trader chose (launch audit, 2026-11-10)

Migration `0049` (schema 49) adds three inbox kinds — `P2P_PAY_NOW`, `P2P_PAYMENT_SENT`, `TRADER_SIDE_EMPTY` — to
`client_notification_kind_check`. No table, column, money rule, secret, service or job changes.

1. **Release order** (from production at 48): as §21 — CI green, a restore point, `scripts/migrate.ts` with the production
   env, then merge (the app at 49 refuses a database at 48), then the worker image of the same commit. The worker composes
   the new messages, so until its image is updated the new events (`p2p.pay_window_opened`, `trader.side_empty`) wait in
   the outbox and are delivered when it starts — the email channel withholds anything older than its freshness limit.
2. **What changes for people, with no setting to switch:**
   - Each timed step of a P2P deal is announced to the side it has just become — the seller told to lock its USDT (with the
     minutes it has), the buyer told its time to pay has started (with the IST time), the seller told the buyer says it
     paid — in the inbox and by email, not only in a linked Telegram chat.
   - A deal offers only the rails its trader's side uses (`trader_block.rails`, "Clients pay you by" / "You pay clients by").
     A trader who unticked UPI is no longer paid by UPI; every existing side has all four rails on, as before.
   - A trader's application offers UPI among "How you are paid to this account", and the sides of a trader approved on an
     account it submitted itself start with what it chose. An account the desk added narrows nothing.
   - A client must have a bank account on file before it asks for a price to **buy** USDT (`PAYER_ACCOUNT_REQUIRED`); the
     Exchange, a desk's page and a deal link each offer to add it in place.
   - A client cannot archive the bank account or wallet an open trade pays to, or its trader account settles with
     (`DESTINATION_IN_USE`). The desk still can.
3. **Visual baselines** change on: the trader application's last step, the Traders home (each side shows its rails), the
   Exchange ticket when buying, and Bank accounts (the per-account transfer list is no longer shown). Re-record them.

## 23. UPI IDs as payment destinations of their own (ADR 0029)

Migration `0050` (schema 50) adds `upi_id`, `p2p_pay_window.payee_upi_id`, `fiat_transfer.payer_upi_id`, the inbox kind
`DESTINATION_REJECTED` and two guards (IX145, IX146). No secret, service or job changes.

1. **Release order** (from production at 49): CI green, a restore point, `scripts/migrate.ts` with the production env, then
   merge — the app at 50 refuses a database at 49 — then the worker image of the same commit. Merging first makes the
   site answer 500 until the migration runs (as on 2026-11-09 and 2026-11-10).
2. **What changes for people at once:** no deal is paid by UPI until someone has a verified UPI ID. Deals that would have
   gone by UPI to the account address go by IMPS until then. Nothing in progress changes: a window already open keeps its
   method.
3. **The desk's new task:** Clients → "UPI IDs to verify". For each, start a payment to the address in a UPI app without
   paying, type the name it shows, and verify — or reject with a note the client reads.
4. **Before switching it on for real money:** one rupee by a deal's code to a verified UPI ID from GPay, PhonePe and Paytm
   on Android and iOS.

## 24. The one who pays a UPI ID checks it (ADR 0030)

Migration `0051` (schema 51): `upi_id` gains `name_confirmed_*` and `reported_*`, `p2p_pay_window` gains
`payee_name_confirmed_at`, a UPI ID may go `ACTIVE → PENDING_REVIEW`, `ACTIVE` no longer needs a reviewer, and the inbox
kind `DESTINATION_PAUSED`. It makes any UPI ID still waiting from 0050 live, and gives verified ones their confirmation.
No secret, service or job changes; no new IX code.

1. **Release order** (from production at 50): CI green, `gh pr view` to see the PR is **not merged yet**, a restore point,
   `scripts/migrate.ts` with the production env, then merge — the app at 51 refuses a database at 50 — then the worker
   image of the same commit. The worker at 50 keeps running on a database at 51 until it restarts: it handles no event of
   0051 (`client.destination_paused` waits for the new worker; nothing about money depends on it).
2. **What changes for people at once:** a UPI ID is ready the moment it is added — up to ₹25,000 a payment and a day until
   one deal to it is confirmed. A buyer paying it ticks "My UPI app shows <name>" before "I've paid", or says it shows
   another name and pays the bank account instead.
3. **The desk's task changes:** Clients → "UPI IDs paused by a payer" lists only addresses a payer reported. Look the address
   up in a UPI app: the owner's own name puts it back (full limits); another name rejects it with a note.
4. **Before real money** (unchanged from §23.4): one rupee by a deal's code to a UPI ID from GPay, PhonePe and Paytm.

## 25. Where each sign-in came from

Migration `0052` (schema 52): the table `sign_in`, one row per sign-in on either surface — who, the session it opened,
how (email code, Telegram, password), the address Better Auth resolved, the country / subdivision / city from Vercel's
`x-vercel-ip-country`, `x-vercel-ip-country-region` and `x-vercel-ip-city` headers, and the user agent. The application
adds and reads rows; it cannot update or delete them (`sign_in_append_only`, grants). Rows are never exported. No secret,
service or job changes; no new IX code; nothing is sent to a third party to look an address up.

1. **Release order** (from production at 51): CI green, `gh pr view` to see the PR is **not merged yet**, a restore point,
   `scripts/migrate.ts` with the production env, then merge — the app at 52 refuses a database at 51 — then the worker
   image of the same commit. The worker at 51 keeps running on a database at 52 until it restarts; it writes no sign-in.
2. **What changes at once:** every sign-in from then on is recorded. Clients → Joined shows the city of a client's first
   recorded sign-in; a client's page shows its first sign-in and the latest ones with place, address and device; a trader's
   applicant sheet shows where it signed in from. Clients who signed in before 52 show their live sessions' address and
   device, without a place, until they sign in again.
3. **Who sees it:** `client:manage` only — the roles that see a client's contacts.


## 26. Where traders come from: `inrp2p.com/traders` (ADR 0031)

Migration `0053` (schema 53): three new tables — `acquisition_visitor`, `acquisition_event`, `acquisition_link` — and
nothing else in the schema changes. The application adds and reads rows; it cannot update them (`*_append_only`, grants).
Rows are never exported. No secret, env variable, service or job changes; no new IX code; no third party is loaded.

1. **Release order** (from production at 52): CI green, `gh pr view` to see the PR is **not merged yet**, a restore point,
   `scripts/migrate.ts` with the production env, then merge — the app at 53 refuses a database at 52 — then the worker
   image of the same commit. The worker at 52 keeps running on a database at 53 until it restarts; it reads none of these.
2. **What changes at once:** `inrp2p.com/traders` is the trader page instead of a redirect to the workspace (everything
   under it still redirects); the client site's "For traders" links lead there; the trader sign-in's "Back" leads there;
   the sitemap lists it. Desk → Traders → **Acquisition** shows the funnel from the first visit on.
3. **Campaign links:** `https://inrp2p.com/traders?utm_source=telegram&utm_medium=post&utm_campaign=<name>&ref=<code>&for=usdt`
   (`for` is `usdt`, `inr` or `otc`; every parameter is optional).


## 27. Opening an account with Telegram (ADR 0026, amended 2026-11-22)

Migration `0054` (schema 54): a check on `auth_user` (a `@telegram.invalid` placeholder address belongs only to a client
and is never verified) and a new body for the IX136 trigger (an account without a verified email may hold only the
Telegram its placeholder names). No table, secret, env variable, service or job changes; no new IX code.

1. **Release order** (from production at 53): CI green, `gh pr view` to see the PR is **not merged yet**, a restore point,
   `scripts/migrate.ts` with the production env, then merge — the app at 54 refuses a database at 53 — then the worker
   image of the same commit. The worker at 53 keeps running on a database at 54 until it restarts; it never creates users.
2. **What changes at once** (where Login with Telegram is configured): "Continue with Telegram" on the workspace sign-in
   opens an account for someone new instead of sending them to email first; the sign-in page says either way opens an
   account. Such a person is shown by their Telegram (`@username`) in the workspace and on the desk, adds their email from
   Account & security (or when a change first needs a second factor), and cannot disconnect Telegram until they have.
3. **The same person, twice:** a still-empty Telegram account that adds the email of an account opened earlier joins it —
   the Telegram moves there, the empty one is closed. Audited as `client_user.identity_joined` and `user.telegram_linked`
   (`via: joined`).

## 28. No client turned away (ADR 0032)

Migration `0055` (schema 55): `trade_request.waiting_since/waiting_until` (a request nothing priced waits for a trader),
`no_price_reason` allowed on a request that waited, `auto_quote.held` and a new body for the IX139 trigger (a price held for
a waiting client is 600 seconds, IX147: only for a request that waited), and three inbox kinds — `WAITING_PRICE_READY`,
`WAITING_ENDED`, `TRADER_CLIENTS_WAITING`. A new worker job, `waiting_requests_sweep` (every minute), and a Telegram handler
for those three notes. No secret, env variable or service.

1. **Release order** (from production at 54): CI green, `gh pr view` to see the PR is **not merged yet**, a restore point,
   `scripts/migrate.ts` with the production env, then merge — the app at 55 refuses a database at 54 — then the worker image
   of the same commit. Until that image runs nobody looks at a waiting request again — it is never priced, and the old
   worker's expiry closes it after a day without a message — so roll the worker the same hour.
2. **What changes at once** (with automatic prices on): a request nothing prices is no longer declined. It stays open for
   24 hours; the traders with that side hear "A client is waiting for your price" (inbox, email, Telegram — once per half
   hour each); the Traders home leads with the waiting demand. The minute a firm offer takes it, the price is held for the
   client for 10 minutes and it is told by inbox, email and Telegram; a day with no price closes it with a plain message.
3. **Nothing to switch:** it follows automatic prices. With them off, requests wait for a person as before, and a request
   that was waiting when they were switched off goes to the desk's queue at the next minute.

## 29. One book: clients meet clients, and nothing waiting is lost (ADR 0033)

Migration `0056` (schema 56): `peer_policy` (off, 25 bps, 50 USDT minimum), `peer_match` (IX148), `peer_strike`,
`push_subscription`/`push_delivery`; `trade_request.wait_hours/peer_paused_at/held_lapses/peer_told_at/peer_told_rate_micro`,
status `MATCHED`, `no_price_reason = 'OUTSIDE_LIMIT'`, `target_rate_micro` movable by its client; `trader_profile.status =
'PERSONAL'` (and `PERSONAL > UNDER_REVIEW`); `quote.accepted_via = 'STANDING'`; IX144 allows the taker's half of a meeting's
network; `inrp2p_reserve_sender_trader` leaves personal sides out; six inbox kinds. A new worker job, `peer_sweep` (every
minute), handlers for the meetings' notes, `waiting.look_now` (the waiting sweep runs at once when a trader comes online, a
side changes or the market is read) and Web Push.

1. **Release order** (from production at 55): CI green, `gh pr view` to see the PR is **not merged yet**, a restore point,
   `scripts/migrate.ts` with the production env, then merge — the app at 56 refuses a database at 55 — then the worker
   image of the same commit, the same hour (until it runs, no meeting ends, no lapsed held price is resumed, nobody is told).
2. **Web Push (optional).** Generate one VAPID key pair (P-256, raw, base64url), for example in Node:
   `const e = crypto.createECDH('prime256v1'); e.generateKeys(); e.getPublicKey('base64url'); e.getPrivateKey('base64url')`.
   Set `WEB_PUSH_PUBLIC_KEY` on **both** Vercel and the worker, `WEB_PUSH_PRIVATE_KEY` and `WEB_PUSH_SUBJECT`
   (`mailto:` an address of INRP2P's) on the **worker only**. Without them "Notify me here" and the Account card are not
   shown and the worker logs `web push: not configured`; nothing else changes. Keep the pair: a new one drops every
   browser's subscription.
3. **What changes at once** (automatic prices on): a client's own price bounds every automatic price (a price past it is
   not sent — the request waits, `OUTSIDE_LIMIT`); a lapsed held price returns its request to the wait instead of the desk's
   queue; the client chooses how long it waits (1 h, a day, 3 days, a week) and gets "Keep looking" when a wait ends; "N
   traders online" replaces "N traders know"; a client's deal moments reach its Telegram (TD-46).
4. **Switch on (owner):** Rates → *Clients meet clients* → *Let clients meet clients* (reason + authenticator code). Fee
   and smallest meeting are on the same card. From then on two waiting clients see each other's price, meet in one tap, and
   the one asked starts the deal from its Exchange (`/deals/<ref>` follows it to the end).

## 30. The robot at the front line (ADR 0034)

Migration `0057` (schema 57): `robot_policy` (append-only; starts in a **dry run**, rules-only answers, quiet 22:00–09:00 IST,
300 model answers a day), `robot_preference` (each person's consent, snoozes, what they saw), `robot_touch` (every message it
decided, sent or rehearsed, and whether the person then acted), `robot_case` (a question passed to a person), `robot_exchange`
(questions and answers, deleted after 90 days); inbox kinds `ROBOT_NOTE`, `ROBOT_REPLY`; a note's link may carry a short
query (`/exchange?again=RQ-…`). A new worker job, `robot_sweep` (every ten minutes), and its delivery handler. The web app
serves `/robot`, `/api/client/robot`, the stop link `/robot-quiet/{touch}.{token}` (no session) and the desk's `/robot-desk`;
the bot now answers every message.

1. **Release order** (from production at 56): CI green, `gh pr view` to see the PR is **not merged yet**, a restore point,
   `scripts/migrate.ts` with the production env, then merge — the app at 57 refuses a database at 56 — then the worker image
   of the same commit, the same hour (until it runs, nothing is rehearsed and no answered question reaches its asker
   outside the inbox).
2. **What changes at once:** the robot appears in every workspace page's masthead and answers questions in the app and in
   the bot (rules first; anything else goes to a person on the desk's Robot page). Outside the app it **sends nothing**: it
   rehearses (dry run) and the desk reads every message it would have sent under Robot → Activity.
3. **Switch on (owner):** Robot → *Switch outreach on* (reason + authenticator code). Optional: set `ANTHROPIC_API_KEY` (and
   `ROBOT_AI_MODEL`) on Vercel, redeploy, then *Let a model answer too*. Each playbook can be switched off on the same card.
4. **Cost:** one indexed statement every ten minutes plus a few people's reads; at night or switched off, none. A model call
   only for a question no rule knows, capped per day.
