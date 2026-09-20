# Phase 9 — Public site & hardening

Status: **implementation complete, awaiting review (2026-09-20).** Three launch-checklist items remain open and
are not closable by engineering; they are named in §6 rather than marked done.

Plan line: *Landing + SEO routes (metadata, structured data without fabricated figures, sitemap), copy review
for zero regulatory claims (D-07), security headers/CSP, rate limits, load test on quote accept and payout
confirm, backup/restore drill, monitoring + alerts, runbooks, launch checklist. Exit: launch checklist complete,
penetration test findings triaged, counsel sign-off (D-07).*

---

## 1. The public site

Six routes, exactly as PRODUCT §7.4 names them, served only on the public host: `/`, `/usdt-to-inr`,
`/inr-to-usdt`, `/sell-usdt-in-india`, `/buy-usdt-in-india`, `/usdt-otc-india`. Everything they say lives in
`apps/web/src/content/site.ts`, which is also what generates the sitemap and what the copy guard reads — so a
route cannot be published without being listed, listed without existing, or edited without the guard seeing it.

The site ships **no JavaScript of its own**. It is server-rendered, its only inline script is its structured
data, and its whole CSP is one nonce. That is most of why it measures where it does on a throttled phone.

**Structured data** is Organization, WebSite, WebPage and a breadcrumb — and nothing that would need a number.
No `aggregateRating`, no `review`, no `offers`, no `priceRange`: every one of those would be a figure we
invented. A price in this product exists only inside a quote issued to a client, so there is nothing to mark up
as one, and the end-to-end test asserts those keys are absent.

**The home page has exactly one URL.** `/` in this build is the operator desk, and two route groups cannot own
one path, so the public home renders from `/home` behind a rewrite. Next runs the proxy again on the rewritten
path — which is how the first version of this returned 401 for `/` — so `/home` has to pass the public gate; a
request that arrives there from outside is answered with a permanent redirect to `/`. The canonical link, the
sitemap and the structured data all name `/`.

**`robots.txt` and `sitemap.xml` are answered on every host**, without a session, because a private app that
replies `401` to `robots.txt` has told the crawler nothing — and nothing is not "do not index me". The desk and
the client app disallow everything and publish no sitemap; the public host allows crawling, disallows `/q/`
(a quote link is private to whoever was sent it) and names its sitemap.

## 2. The copy review, as a test (D-07)

`apps/web/test/site-copy.unit.test.ts` reads every sentence the public site says, every notification a client
can receive, and the receipt's own words, and fails on two things:

* **A regulatory claim** — "regulated", "licensed", "registered with", "approved by", "compliant", FIU, PMLA,
  RBI, SEBI. Until counsel confirms what may be said (D-07), the product claims no standing with any authority.
  `registered` on its own is *not* caught, because destinations are registered in advance and the site says so.
* **An invented figure** — volumes, rates, settlement times, customer counts, reviews, "24/7", "instant",
  "guaranteed", "best rates". On the public site the rule is stronger still: after removing protocol names like
  TRC20, no digit may appear at all, because a site with no data behind it has nothing a number could come from.

Receipts and notifications are exempt from the second rule and only the second rule: their figures are the
client's own trade. A test asserts that exemption is real, so nobody "fixes" the guard by stripping figures out
of a receipt.

The guard is also held against twelve sentences written to fail it — the ones a well-meaning person actually
writes when asked to make a landing page convincing. A rule that has only ever been run against text written to
satisfy it proves nothing about the rule.

## 3. Security headers and the policy

`apps/web/src/server/headers.ts` is pure and unit-tested; the proxy applies it to every response on every
surface. The policy is deliberately **identical** on all three: a desk, a client app and a marketing page have
different contents and the same attack surface, and a weaker policy on the host somebody thinks of as "just
marketing" is how an attacker gets a foothold on a domain that shares a registrable domain with the rest.

```
default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none';
frame-src 'none'; object-src 'none'; base-uri 'none'; manifest-src 'self'; worker-src 'self';
media-src 'none'; upgrade-insecure-requests
```

Plus `Strict-Transport-Security` (two years, subdomains, preload-eligible), `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy` and
`Cross-Origin-Resource-Policy: same-origin`, `X-DNS-Prefetch-Control: off`, and a `Permissions-Policy` in which
every feature this product does not use has an empty allow-list.

Three decisions worth stating:

* **`'strict-dynamic'` with a per-request nonce.** The nonce is generated in the proxy, forwarded to the render
  on both `x-inrp2p-nonce` and a request-side `Content-Security-Policy` header — the second is how Next finds it
  and puts it on its own bootstrap scripts. Without that the framework's scripts would be blocked and every page
  would render as dead HTML that looks fine until you click something. The end-to-end test types into the client
  sign-in form and asserts the button becomes enabled, which only happens if React hydrated.
* **`style-src` keeps `'unsafe-inline'`.** Components that draw a proportion — a capacity meter, a settlement
  progress bar — set a width as a style attribute. A style cannot execute; removing this is defence in depth,
  not a live hole, and is not worth a refactor of the design system in a hardening phase.
* **HSTS is sent only over https.** Sent over plain http it is ignored; sent from a local harness it would be
  remembered by a developer's own browser for two years and break every other plain-http thing they run.

## 4. Rate limits

SECURITY §7 lists seven limits. Six existed from Phase 3 (link opens per IP, OTP sends per quote and per IP, OTP
verification attempts per challenge, link decisions per token, sign-in and TOTP through Better Auth's own
counters). The seventh — **sixty financial mutations per user per minute** — did not, and this phase added it.

It lives at the **edge a person acts through** (`runCommand`, `runClientCommand` and `withOperator` in the web
layer) rather than in the command pipeline. The pipeline is also how the worker and the scanner move money, and
throttling those would mean the outbox falling behind exactly when it has the most to do. The first version of
this put it in the pipeline and made sixteen integration tests fail — which was the limiter correctly reporting
that a test suite drives more mutations in a minute than a human being ever will.

The limiter itself moved from `@inrp2p/quotes` to `@inrp2p/commands`, next to the pipeline, and is re-exported
where it was. `packages/commands/test/rate-limit.int.test.ts` covers the three properties that matter: the limit
refuses at the limit and not two later; **refusals count** (a limiter that counts only successes lets an
attacker try forever, since their attempts all fail by definition); and subjects and buckets are independent,
with only a hash of the subject stored.

## 5. Load, health, backups, runbooks

**Load** (`packages/settlement/test/load.int.test.ts`, `pnpm run load:test`). Concurrent lanes accept quotes and
confirm payouts against one another — acceptance allocating deposit addresses from a shared pool, payouts
competing for a single account-day row. Volume is an environment variable with a small default so CI exercises
the path on every run. At 180 trades on 12 lanes on this development container: `quote.accept` p50 223ms / p95
324ms, `payout.confirm` p50 69ms / p95 93ms. The timings are reported, never asserted — a latency budget on a
shared runner fails for reasons that have nothing to do with the product. What *is* asserted is what concurrency
did to the invariants: no address assigned twice, every trade completed exactly once, no trade over its
obligation, the account-day never over capacity, the ledger still netting to zero, and a deliberate three-way
race on one payout confirming exactly once.

**Health** (`packages/desk/src/health.ts`, `/api/health/{live,ready,status}`). Liveness touches nothing — an
orchestrator uses it to decide whether to *restart*, and restarting a healthy process because the database
blinked turns a short outage into a long one. Readiness asks the database one question. Status carries the nine
signals with their thresholds and their runbooks, and is therefore **not** open: a monitoring token or an
operator session with `economics:view`, and no third way in. It answers 503 when a signal is in alarm, so a
check that only reads the status code still works.

The nine signals are the alert definitions: ledger imbalance (alarm at any non-zero value), scanner lag, failed
outbox events, oldest undelivered event, audit seal age, open blocking exceptions, overdue route obligations,
INR capacity left today, and free deposit addresses. Each names what it means, both thresholds, and the runbook
it points at — and a unit test holds every `runbook` id against a heading in `docs/RUNBOOKS.md`, so an alert
cannot exist without somewhere to send the person it wakes.

**Backups** (`scripts/backup-drill.ts`). Dumps, restores into a **new** database — never over an existing one —
and then asks the restored copy whether it is at the same migration, whether its ledger still nets to zero,
whether its audit chain still recomputes, whether every completed trade is still fully settled, and whether the
counts match. The checks are separated into `scripts/restore-checks.ts` and tested against databases corrupted
in each of those ways, because a check that passes on a bad restore is worse than no check: it is what stands
between a bad backup and the decision to rely on it. The drill itself has never been run against real
infrastructure (TD-16) — see §6.

**Runbooks** (`docs/RUNBOOKS.md`). Eleven, including the six the checklist names. Each one is written for the
person who has just been woken up: what you were told, what to check first, what to do, and **what never to
do** — because most of the ways this system can lose money involve someone doing something reasonable-sounding
under pressure, and those answers are better decided now than at 3am.

## 6. What this phase could not close

Three checklist items are open, and none of them can be closed by writing code:

* **Counsel sign-off (D-07).** External. The product's part is done and enforced: no regulatory claim appears
  anywhere client-facing, and a test fails if one is added.
* **Penetration test.** External.
* **Drills against real infrastructure** — the backup/restore drill (TD-16), the seven-day ledger-zero watch in
  staging, MFA enrolment and OWNER break-glass, and the off-site audit-seal export (TD-17). Each needs a
  deployment that does not exist yet. The scripts, checks and alerts they will use are built and tested.

**TD-07 also remains open**: the TRON provider smoke gate has still never been executed against real providers,
and it still blocks any environment that settles real USDT. Nothing in this phase changes that, and nothing here
should be read as production readiness.

New debt recorded: **TD-15** (the public site cannot be edge-cached while its CSP nonce is per-request; the fix
is a hash-based policy for those pages), **TD-16**, **TD-17**. **TD-13** was closed for Phase 8 by the canonical run that landed during this phase
and is reopened for the two public-site captures.

---

## 7. Gates

| Gate | Result |
|---|---|
| `pnpm run lint` | pass |
| `pnpm run typecheck` | pass |
| `pnpm run versions:check` | pass (26 manifests) |
| `pnpm run secret-scan` | pass (748 files) |
| `pnpm run workspace:graph` | pass (acyclic) |
| `pnpm run test:unit` | 611 tests, 21 files |
| `pnpm run test:integration` | 616 tests, 32 files |
| `pnpm --filter @inrp2p/web build` | pass |
| `pnpm --filter @inrp2p/web test:e2e` | 16 tests (11 desk, 5 client-mobile) |
| `pnpm --filter @inrp2p/web test:visual:selfcheck` | 24 captures, reproduced |
| `pnpm --filter @inrp2p/web test:lighthouse` | quote link 94 · public home 100 (performance, quiet host) |
| `pnpm run load:test` | 180 trades on 12 lanes, invariants held |

Two notes on measurement, because both numbers move:

* **Lighthouse performance varied between 87 and 97** on this development container while the database, three
  app servers and a test suite were sharing it. Both pages measure in the mid-nineties when the host is quiet.
  The quote link keeps its Phase 7 budget of 90; the public home is gated at 85 with SEO gated at 90 — SEO is
  gated *only* there, because it is the only page that exists to be found, and the link page is deliberately
  `noindex`, which Lighthouse scores as a failure.
* **Canonical visual comparison still cannot run here** (`mcr.microsoft.com` is refused by the organization's
  egress policy), so the self-check path was used, as in Phases 6 to 8. Phase 8's baselines were recorded
  canonically while this phase was being built (run `35495412975`, 22 baselines at `36700c4`); the two public
  captures this phase adds need one more record run before `visual-pages` can pass (TD-13).

## 8. Files

**Public site** — `apps/web/src/content/site.ts`, `apps/web/src/app/(public)/` (layout, shell, page view, six
routes), `apps/web/src/app/robots.txt/route.ts`, `apps/web/src/app/sitemap.xml/route.ts`,
`apps/web/src/server/site.ts`.

**Headers** — `apps/web/src/server/headers.ts`, applied in `apps/web/src/proxy.ts`; gate changes in
`apps/web/src/server/surface.ts`.

**Rate limits** — `packages/commands/src/rate-limit.ts` (moved from `@inrp2p/quotes`), applied in
`apps/web/src/server/command.ts` and `apps/web/src/server/client.ts`.

**Health** — `packages/desk/src/health.ts`, `apps/web/src/app/api/health/{live,ready,status}/route.ts`.

**Operations** — `scripts/backup-drill.ts`, `scripts/restore-checks.ts`, `docs/RUNBOOKS.md`.

**Tests** — `apps/web/test/{site-copy,headers}.unit.test.ts`, `apps/web/e2e/public.spec.ts`,
`packages/commands/test/rate-limit.int.test.ts`, `packages/desk/test/health.{unit,int}.test.ts`,
`packages/settlement/test/load.int.test.ts`, `test/integration/restore-check.int.test.ts`.
