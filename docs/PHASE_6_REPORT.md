# INRP2P Exchange — Phase 6 Report (Operator product)

Status: complete, awaiting review. Phase 7 not started.
Base: `3f8a1d5` (Phase 5 review corrections). Scope: `IMPLEMENTATION_PLAN.md` Phase 6 only — the desk a dealer actually works: strip, grouped queue, context panels, Orders, Rates with route positions, INR, USDT, Clients, the command bar, keyboard flows and step-up dialogs. No client surfaces (Phase 7), no attachments, no receipts, no notifications.

## 1. The shape of the phase in one paragraph

Phases 2–5 built a domain that decides everything: what a quote may say, who may send it, what makes money move, what makes a chain transfer count. Phase 6 adds **no decisions**. It adds a way to see the desk and a way to say the next thing — every button is one domain command, carrying the actor, the payload and an idempotency key, and nothing else. The one genuinely new piece of thinking is the read layer: `packages/desk` composes the domain modules' public APIs into the five or six shapes a page needs, and enforces view permissions by **field absence**, so a settlement operator's payload does not contain a margin to leak. What the panel previews and what the command computes are the same kernel function, so the figure a dealer sends is the figure the trade is written with.

## 2. What exists

```
packages/desk       NEW — the read layer: access, strip, queue, trade, request, orders, positions,
                    treasury, clients. Pure reads; no writes, no policy of its own.
apps/web/src/server + operator.ts (context, page guard, can/assertCan), command.ts (runCommand and the
                      operator-facing message map), chain.ts (the verifier the desk's manual confirmations
                      use), env.ts (runtime configuration reads), actions/ (25 server actions, search)
apps/web/src/app    + (operator) route group: desk, orders, rates, inr, usdt, clients, client detail;
                      sign-in
apps/web/src/components + panels (quote, payout, exception), useCommand (one key per intent + step-up),
                      useHotkey, CommandBarHost
apps/web/e2e        NEW — world (seed), server (the built desk), demo.spec, keyboard.spec, support
packages/ui         ~ 'use client' on every interactive component; ActionQueue rows carry data-row-id;
                    CommandBar takes an inputRef; RateComparison is the single margin/economics block
.github/workflows   + an `e2e` job: the built app against PostgreSQL 18.6 with Chromium
```

## 3. The read layer (`packages/desk`)

A page needs a shape that no single domain module owns — the queue mixes requests, quotes and trades; the payout panel needs legs, capacity, wallets and the route side at once. Putting those joins in the page would spread SQL through React; putting them in a domain module would make that module know about pages. So they live in one read-only package that depends on the domain modules' public APIs and on nothing of the app.

Two rules make it safe to return its output to a browser:

**Field absence, not blanking (SECURITY §5).** `accessFor(actor)` projects the same RBAC matrix the commands enforce into three view flags (`economics`, `routePositions`, `pnl`). A read model that must not show economics does not include the key at all — `routes` and `realizedMarginToday` are absent from a settlement operator's strip, not null and not zeroed. A payload that has no margin in it cannot leak one through a screenshot, an export or a devtools panel.

**No decisions.** Nothing in `packages/desk` authorizes an action or computes a figure that money depends on. `deskTrade` reports what a trade owes by reading what the domain already recorded; the payout panel's "Maximum ₹4,200,000" is a hint, and the command re-checks the obligation, the capacity and the route side inside its own transaction. Deleting the whole package would cost the desk its eyes, never its rules.

19 integration tests cover it, including the ones that matter most: the same trade read by an OWNER and by a SETTLEMENT_OPERATOR, asserting the fields are **missing** rather than empty; a direct-to-client route leaving the payout read-only with the residual the exchange still owes; and every queue group/status/action mapping across the lifecycle.

## 4. One button, one command, one key

`runCommand` is the only path from a page to the domain:

```
server action → runCommand(build, { name, idempotencyKey, financial }) → executeCommand(db, command, …)
```

The app layer supplies the actor (from the session) and the payload (from the form). It does not pre-check permissions to decide whether the command will succeed — `can()` decides only whether a **button** is drawn, and the command authorizes itself again in its own transaction. A page that is out of date can therefore be wrong about what is possible, and it will be told so by the domain rather than by a stale render.

**One idempotency key per intent (FI-50).** `useCommand.run` mints a key per button press, not per network call. A double click reuses the key; a lost response reuses the key; a step-up retry reuses the key. Only a fresh press makes a new one. Two legs of ₹6,000,000 are therefore two presses, and an impatient operator cannot pay one of them twice.

**Step-up (SECURITY §2.1).** A command that needs re-verification answers `STEP_UP_REQUIRED`. `useCommand` holds the intent, shows the dialog, posts the code straight to Better Auth's `two-factor/verify-totp`, and then runs the *same* command with the *same* key. The desk never sees a secret and never decides that a step-up is satisfied; it only carries the code to the place that checks it, and asks the domain again.

The failure map in `command.ts` turns domain codes into sentences an operator can act on ("That account does not have enough capacity left today"), and every code it does not know falls through with the domain's own message. It never invents a reason.

## 5. What the review of the running desk found

Three defects were found by making the end-to-end run real, and all three are fixed in this phase:

**The step-up dialog could never be completed.** `run()` set `busy` for the whole life of the held intent, and the dialog's confirm button is disabled while busy — so the prompt appeared and could not be answered. Busy now covers the call itself; waiting for an operator to read an authenticator is not busy. (`useCommand.tsx`)

**Runtime configuration was being frozen at build time.** `process.env.OPERATOR_BASE_URL` and friends were read as static member expressions, which the bundler replaces with the value present when the app was *built*. In the built app they were `undefined`, so operator auth fell back to `https://${DESK_HOST}` and refused every sign-in with `INVALID_ORIGIN`; the same bug would have made a configured TRON provider look unconfigured in production. All server environment reads now go through `apps/web/src/server/env.ts`, which reads a computed key and is therefore opaque to substitution. `apps/web/test/proxy.int.test.ts` now signs in from an origin that only a runtime read can trust, so the regression cannot come back silently.

**An advertised shortcut did nothing.** The quote panel's button showed `Q`; nothing was bound to it. `useHotkey` makes it real, scoped to the panel, ignoring modifiers and text entry (a checkbox or a button is not text entry, so the key still works there). The command bar had the mirror problem: ⌘K opened it without moving focus into it, which is invisible with a mouse and fatal without one.

## 6. The end-to-end runs

Both run against the **built** app, a real PostgreSQL created from the migrations, real Better Auth sessions with real TOTP enrolment, and the real commands. `global-setup.ts` seeds the world and *then* starts the desk, in that order, because Playwright's own `webServer` starts before global setup and would connect to a database about to be dropped.

**`demo.spec.ts` — the launch-checklist scenario.** 100,000 USDT sold at ₹102.00 against a ₹104.20 route, settled in two INR legs, completing with ₹220,000.00 of realized margin read out of the ledger. Everything an operator does happens through the UI: the request, the price, the send, the legs, the references, the confirmations. The two things the operator product must never do are done the way the world does them — the **client** accepts their own quote through `quote.accept` (D-01), and the **chain** delivers the USDT into the assigned deposit address, discovered by the Phase 5 scanner jobs over a fake chain with two fake providers.

The step-up rule is proved in both directions: the sign-in verification is deliberately aged past its window before the first confirmation, so the desk must ask; the second confirmation, inside the fresh window, must **not** ask.

**`keyboard.spec.ts` — quote → payout without a pointer.** Nothing is clicked and focus is never set programmatically: `pressUntilFocused` tabs until the control has focus, so a control the tab order cannot reach fails the run. Sign-in, the request, the price, the `Q` the button advertises, ⌘K to find the trade by reference, the row hotkey to open its panel, and the whole leg — amount, reserve, mark sent, reference, confirm, authenticator code — all by keyboard.

## 7. Visual regression for the operator validation list

The Phase 1.5 validation stories already carry pixel baselines for the operator list — desk, clients, rates, INR accounts, USDT treasury, P&L, new request / quote creation, trade processing with partial settlement, exception trade — recorded in the canonical Playwright image and compared by the `visual` CI job on every push (`docs/VISUAL_BASELINES.md`). Phase 6 changed UI components only in ways that do not alter rendering (`'use client'` directives, a `data-row-id`, an optional `inputRef`), so those baselines are expected to compare clean; the `RateComparison` duplication removed from the quote panel was app-level markup, not a story.

**Not re-run here.** This environment is not the canonical baseline environment (`docs/VISUAL_BASELINES.md`: baselines are only comparable inside `mcr.microsoft.com/playwright:v1.56.1-noble` on linux/amd64, and the suite refuses to run elsewhere). CI runs it. What the baselines do **not** yet cover is the built pages themselves — see TD-08.

## 8. Gates

| Gate | Result |
|---|---|
| `pnpm install --frozen-lockfile` | clean, lockfile passes supply-chain policy |
| `pnpm run workspace:graph` | acyclic, 22 projects |
| `pnpm run versions:check` | version matrix OK (22 manifests) |
| `pnpm run secret-scan` | 596 files clean |
| `pnpm run lint` | clean |
| `pnpm run typecheck` | clean (root, `apps/web`, `packages/ui`) |
| `pnpm run test:unit` | 13 files, **215 tests** passed |
| `pnpm --filter @inrp2p/web build` | clean |
| `pnpm run test:integration` | 20 files, **525 tests** passed (includes the 19 new `packages/desk` tests and the built-app proxy test) |
| `pnpm --filter @inrp2p/web test:e2e` | **2 tests** passed (demo scenario, keyboard-only) |
| `pnpm --filter @inrp2p/ui test:visual` | **not run here** — canonical image only (§7) |
| `pnpm smoke:tron` | **not run** — TD-07, unchanged by this phase |

## 9. Exit criteria

| Criterion | Where |
|---|---|
| E2E demo scenario driven entirely through operator UI + fake chain | `apps/web/e2e/demo.spec.ts` — passing |
| Keyboard-only run of quote → payout | `apps/web/e2e/keyboard.spec.ts` — passing |
| Visual regression for operator validation list | `packages/ui/visual/__screenshots__/validation-operator-desk--*.png`, compared by the `visual` CI job; not runnable in this environment (§7) |

## 10. Debt

TD-08 recorded (visual regression covers the Storybook validation stories, not the built operator pages). TD-01 – TD-04, TD-06 and TD-07 are unchanged; TD-07 in particular still blocks Phase 5 being *fully* closed and is not affected by anything here.
