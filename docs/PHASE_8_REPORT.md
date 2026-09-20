# Phase 8 — Finance outputs

Status: **implementation complete, awaiting review (2026-09-20).** Phase 9 not started.

Plan line: *P&L page (realized vs expected), receipts (PDF/CSV/JSON from immutable snapshot, grayscale print
check), exports, reconciliation job + manual bank statement import, remaining exception resolutions. Exit:
receipt byte-stable regeneration from snapshot (hash matches); reconciliation opens exceptions idempotently;
P&L equals ledger revenue.*

---

## 1. What this phase produces

Everything here is an **output**: a document, a file or a screen that says what already happened. Nothing in
this phase moves money, and the one thing that writes to the domain — the statement import — writes only
exception cases, through the same command path as everything else.

| Output | Where | What it is |
|---|---|---|
| P&L | `/pnl` (`pnl:view`) | Realized against expected, the trades behind both, and a line saying whether the page agrees with the ledger. |
| Receipt | `/api/receipts/{ref}` (`receipt:view`, or the client's own trade) | One settled trade as JSON, CSV, a print-ready HTML document, or a PDF. |
| Exports | `/api/exports/{trades,ledger,receipts}` (`ledger:export`) | Period-bounded CSV, hashed and audited. |
| Bank statement import | the INR screen (`statement:import`, ⧗) | The bank's own record, held against what the desk said it paid. |
| Exception resolutions | the exception panel | Every case type now has a way out, and the table is tested against the domain's list. |

One new package, `@inrp2p/reporting` (ARCHITECTURE §3 `reporting/`), holds the receipt snapshot, the artifacts,
the exports and the single CSV writer they share. It depends on `kernel`, `db`, `audit`, `commands`, `outbox`,
`quotes` and `ui` — the last one only for display formatting, because a printed figure must be grouped the way
every other surface groups it (D-11), and one formatter is how that stays true.

### The receipt is a copy, not a view

A receipt is taken **once**, at completion, as a snapshot of everything it will ever say — strings, already
formatted, in one canonical JSON document. It is not a query that runs when someone opens it. The rows keep
moving: a destination gets archived, a client is renamed, a later adjustment lands. A receipt that followed
those would be a different document every time it was read, which is the opposite of what a receipt is for.

Every artifact — JSON, CSV, HTML, PDF — is then a **pure function of that snapshot**, and the sha256 of each one
is recorded when the receipt is issued. Serving a receipt regenerates it and checks it against the recorded hash;
a mismatch is a 500, never a download. Handing someone a document that differs from the one we issued, without
saying so, is the one failure a receipt cannot survive.

The snapshot passes `assertClientSafe` before it is written — in production, not only in a test — so no route,
margin, payer or provider fact can reach a document that goes to a client (SECURITY §5, S14).

### The P&L states its own reconciliation

Realized margin on `/pnl` is the **ledger's**: credits to `REVENUE:GROSS_MARGIN` in the period, which only
completion and approved adjustments post (FI-43). Expected margin is what open trades would make if they all
settled as agreed. They are reported side by side and never added, and every row says which kind it is.

The page also sums the completed trades' own margins the long way and shows both totals with a plain-English
verdict. A P&L that only ever reported its own arithmetic could not tell anyone it had drifted; this one says
"Ledger and trades agree" or names the two figures and asks for the page not to be believed until it is
explained (FI-44).

### The bank statement is the only control that can catch a fake UTR

Everything else in the payout path proves that an **operator** said a payment was made — uniqueness on the UTR,
the evidence they attached, the authenticator they had to produce. None of it proves the **bank** moved the
money. Only the bank's own statement does, and V1 gets it by hand because there is no bank API yet
(SECURITY §5 S7).

The import asks two questions:

1. For each line in the file, is there a payment we recorded with that reference, for that amount? A different
   amount is `MISMATCHED` and opens a case. A line we never recorded is `UNRECORDED` and opens nothing — a real
   statement is full of fees, sweeps and transfers this system never made, and a case for each would bury the
   ones that matter.
2. For each payment we recorded as **confirmed** in the period, on that account, does the statement show it? A
   payment the bank has never heard of is the fake-UTR case. It opens a blocking `RECONCILIATION_MISMATCH`
   against the transfer, which puts its trade on hold until someone explains it.

The whole import — the file, its lines, their outcomes and every case they open — is one transaction. A
half-imported statement would be worse than none, because the missing half would look reconciled. The file is
identified by the sha256 of the bytes as received, unique per account, so re-importing the same file is refused
(`DUPLICATE_STATEMENT`) rather than counted twice. The audit records the hash and the counts; the statement's
contents are never stored, because it carries every other customer of that bank account and the question this
answers does not need them kept.

---

## 2. Decisions taken in this phase

**Hashes, not blobs.** The `receipt` table stores the snapshot and the sha256 of each artifact. There is no
object store in V1, so `json_key`, `csv_key` and `pdf_key` exist and are null. This is a deliberate choice, not
an omission: the snapshot plus a deterministic renderer *is* the document, and the hash proves it. Recorded as
debt (TD-12) for the phase that introduces object storage.

**The PDF renderer is a port, and it is off by default.** Printing needs a browser, which is a deployment
decision — a binary that has to be installed and supervised. `INRP2P_PDF_RENDERER=chromium` says a deployment
has one; without it `UnconfiguredPdfRenderer` refuses and the route answers 503 naming the three formats that do
work. Refusing is the honest answer: the receipt is not missing, and a deployment that quietly served something
that was not a PDF would be worse than one that said no. `ChromiumPdfRenderer` is implemented and tested.

**A statement's period is typed, not guessed.** The import form starts with both dates empty. A statement is
almost never for today — it is for yesterday, or last week, or the month that just closed — and the period is
what every "missing payment" is judged against. A date the screen guessed is a date nobody checked.

**Exports are period-bounded, always.** "Everything" is not a period, and a finance file nobody can bound is a
file nobody can reconcile. Every generation is audited with its row count and the sha256 of the bytes, and the
same hash is returned in `x-inrp2p-sha256`, so two people holding files that disagree can find out which one
this system produced.

**Every CSV this system writes goes through one writer**, which quotes what needs quoting, doubles quotes, ends
lines with CRLF, and prefixes a tab to any field starting `=`, `+`, `-` or `@` so a spreadsheet cannot read it as
a formula. The statement reader removes that tab, so a file exported here and re-imported means the same thing.

**The receipt does not get a page baseline.** Every capture in the page suite asserts that all of its text is
drawn in the bundled Geist, which is what makes a baseline reproducible on another machine. The receipt is the
one document that must *not* depend on a bundled font: it is printed, saved and reopened on machines this system
will never see, so it asks for the system's sans-serif and fetches nothing at all. What it needs proving about
is proved in `packages/reporting/test/print.unit.test.ts` instead — see §3.

**The INR screen's day now comes from the business clock.** `istToday` in `@inrp2p/inr-accounts` read
`statement_timestamp()` while the rest of the system read `inrp2p_now()`. Those are the same function in a
deployed database, so nothing changes in production — but in the pinned-clock fixture the INR page printed
whatever day the run happened on, while every trade reference on it carried the frozen day. That would have made
`operator-inr` mismatch every day after it was recorded, and this phase adds three more date fields to that
page. Both now read the business clock, and the fixture's capacity day, page header and trade references agree.

**Read models hand out strings.** `pnlPage` now returns decimal strings rather than `Money`, because the page is
a server component handing its view to a client component, where a class instance arrives as a plain object with
its methods gone. Found by the end-to-end run, which is where it should have been found.

---

## 3. Exit criteria

### Receipt byte-stable regeneration from snapshot (hash matches)

`packages/reporting/test/receipts.int.test.ts` settles a trade in two payments, issues its receipt, then
**renames the client and archives the destination** and regenerates — the same bytes, the same hash, for all
three text formats. `regenerateReceipt` throws `RECEIPT_HASH_MISMATCH` when they differ, and the route turns
that into a 500 rather than a download. The end-to-end run fetches the same receipt twice through the product
and compares the bodies and the `x-inrp2p-sha256` header.

The grayscale print check is `packages/reporting/test/print.unit.test.ts`: it reads the colours out of the
rendered document and asserts every one of them is near-neutral (so flattening to luminance moves it by a few
points at most), that both inks clear 4.5:1 against both papers, that the document fetches no image, font or
stylesheet, and that it carries a print stylesheet. A future edit that introduces a red "overdue" or a green
"paid" fails there rather than at a client's printer.

### Reconciliation opens exceptions idempotently

`packages/settlement/test/statements.int.test.ts` imports a statement that is missing a confirmed payment and
carries a mismatched amount, and asserts the two cases open; re-importing the *same* file is refused as a
duplicate, and an equivalent file with a different hash opens **no** second case, because `openExceptionInTx`
is keyed on the open case for that subject. Unrecorded lines open nothing.

### P&L equals ledger revenue

`packages/desk/test/pnl.int.test.ts` settles one trade, leaves another open, and holds `pnlPage` against a
direct query of `REVENUE:GROSS_MARGIN` for the period: the summary, the page's own sum and the ledger all agree,
the open trade's expected margin never reaches the realized figure, and a period before the completion reports
zero realized while still listing what is open. The end-to-end run reads the same thing through the product and
asserts the page says the two agree.

---

## 4. Gates

| Gate | Result |
|---|---|
| `pnpm run lint` | pass |
| `pnpm run typecheck` | pass |
| `pnpm run versions:check` | pass (26 manifests) |
| `pnpm run secret-scan` | pass (716 files) |
| `pnpm run workspace:graph` | pass (acyclic) |
| `pnpm run test:unit` | 278 tests, 18 files |
| `pnpm run test:integration` | 591 tests, 28 files |
| `pnpm --filter @inrp2p/web build` | pass |
| `pnpm --filter @inrp2p/web test:e2e` | 8 tests (3 desk, 5 client-mobile) |
| `pnpm --filter @inrp2p/web test:visual:selfcheck` | 22 captures, reproduced |
| `pnpm --filter @inrp2p/web test:lighthouse` | pass (perf 97, a11y 100, best practices 96) |

Canonical visual comparison still cannot run in the development environment (`mcr.microsoft.com` is refused by
the organization's egress policy), so the self-check path was used, as in Phases 6 and 7.

**Review action — the page baselines must be re-recorded before `visual-pages` can pass.** This phase adds two
captures (`operator-pnl`, `operator-statement`) and changes one existing page (`operator-inr` gains the statement
panel). The committed set is the 20 from Phase 7, so compare-only CI will report two missing baselines and one
mismatch until the canonical update workflow is dispatched and its reviewed baselines merged
(`docs/VISUAL_BASELINES.md §5`). Recorded as TD-13, which also records the clock fix below.

### The end-to-end run

`apps/web/e2e/finance.spec.ts` settles a trade through the real commands and then uses everything this phase
added, in one signed-in session: reads the P&L and its ledger check, downloads all three exports and asserts the
audit recorded them, fetches the receipt in every format (including the 503 for PDF, since the harness has no
browser to print with), and imports a bank statement through the INR screen — with the ⧗ prompt, the outcome
line, and the duplicate refusal on the second attempt.

Two harness facts came out of writing it, both about the product's own rules rather than the tests:

* **An authenticator code is single-use.** Better Auth refuses a code it has already accepted, as it must, so
  the harness now waits for the TOTP window to roll rather than handing over a spent code.
* **Authentication is rate-limited** — five TOTP verifications per five minutes, five sign-ins per fifteen
  (SECURITY §2.1). Four scenarios back to back spend a real operator's whole hour in two minutes, so the harness
  clears the counter between scenarios, the way real time would. The rule itself is unchanged and is tested
  where it belongs, in the identity suite.

---

## 5. Schema

Two migrations, both insert-only with no updates and no deletes:

* `0018_receipts.sql` — `receipt`: `trade_id`, `version`, the canonical `snapshot_json`, the sha256 of the
  snapshot and of each artifact, nullable object-store keys (see §2), and `UNIQUE (trade_id, version)`. A
  trigger refuses every column change; another refuses deletion.
* `0019_bank_statements.sql` — `bank_statement_import` (account, period, filename, sha256, the four counts,
  `UNIQUE (inr_account_id, sha256)`) and `bank_statement_line` (sequence, value date, direction, amount,
  reference, outcome, and the transfer it matched, with `CHECK ((outcome = 'UNRECORDED') = (fiat_transfer_id IS
  NULL))`). The import row is written **once**, with its final counts, which is why the command resolves every
  line's outcome before it inserts anything: evidence that gets updated after the fact is evidence with a gap in
  it.

`statement:import` is new in the RBAC matrix — OWNER and FINANCE, step-up — and in the table in SECURITY §3 that
the matrix is parity-tested against. `receipt.generated`, `statement.imported` and the existing
`export.generated` are named in SECURITY §8 with exactly what each one records.

---

## 6. What is not done

* **No object store.** Receipt artifacts are regenerated on demand and proved by hash; the `*_key` columns wait
  for the phase that introduces storage (TD-12).
* **PDF printing is opt-in** and therefore off in every environment that has not been given a browser (TD-12).
* **No scheduled reconciliation job.** The plan line says "reconciliation job + manual bank statement import";
  what exists is the import and the route-obligation reconciliation query (`routeObligationMismatches`, FI-64)
  that the properties suite already asserts. A recurring job has nothing to run against until a bank feed exists
  — a scheduler that re-reads the same manually imported files would report the same answer on a timer. Recorded
  as TD-14.
* **TD-07 remains open.** The TRON provider smoke gate has still never been executed, and it still blocks any
  environment that settles real USDT. Nothing in this phase changes that, and nothing here should be read as
  production readiness.
* **TD-04 remains open** (no email provider), as do TD-03 (no KMS KEK) and TD-11 (no client TOTP enrolment).

---

## 7. Files

**New packages and modules**

* `packages/reporting/` — `canonical.ts` (sorted-key JSON, sha256), `csv.ts` (the one writer), `snapshot.ts`,
  `artifacts.ts`, `issue.ts` (`issueReceipt`, `receiptHandler`, `getReceipt`, `regenerateReceipt`), `exports.ts`.
* `packages/adapters/src/pdf.ts`, `packages/adapters/src/chromium-pdf.ts` — the renderer port and its one
  implementation.
* `packages/settlement/src/statements.ts` — `importBankStatement`, `parseStatementCsv`, `listStatementImports`.
* `packages/desk/src/pnl.ts` — `pnlPage`, `istToday`.

**Web**

* `apps/web/src/app/(operator)/pnl/` — the P&L screen.
* `apps/web/src/app/(operator)/inr/StatementImport.tsx` — the reconciliation panel.
* `apps/web/src/app/api/exports/[kind]/route.ts`, `apps/web/src/app/api/receipts/[tradeRef]/route.ts`.
* `apps/web/src/server/pdf.ts`, `apps/web/src/server/actions/finance.ts`.
* `apps/web/src/components/panels/resolutions.ts` — every exception type's resolutions, held against the
  domain's own list by `apps/web/test/resolutions.unit.test.ts`. A case type the desk cannot close is not a gap
  in the UI: it is a client whose money has stopped moving with nobody able to start it again.

**Worker**

* `receiptHandler` joins the task list, and `receipt.generate` leaves the acknowledged-signals list in
  `packages/notifications/src/signals.ts` — it is consumed now, not acknowledged (TD-10, half closed).
