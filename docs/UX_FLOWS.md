# INRP2P Exchange — UX Flows, Navigation, Components, Wireframes

Status: Phase 0, revision 3 (`DECISIONS.md` Revision 3). Visual authority: `docs/source/DESIGN_SYSTEM_BRIEF.md`. This file adds structure, flows and wireframes; it does not restyle the brief.

All examples use realistic values: 100,000 USDT · ₹10,200,000 · ₹104.20 · ₹102.00 · ₹220,000.

## 1. Brand tokens — logo-derived, accessibility-checked

The supplied logo was sampled: field **`#F04E23`**, mark **pure white `#FFFFFF`** (not ivory). The logo file is used as supplied (`brand/inrp2p-mark.png`), never redrawn.

Contrast findings (WCAG 2.x):

| Pair | Ratio | Result |
|---|---|---|
| White text on `#F04E23` | 3.61 | Fails AA for normal text; passes for large text (≥ 24px, or ≥ 18.7px bold) and UI graphics (3:1) |
| White text on `#FF4B2B` (brief suggestion) | 3.34 | Same, slightly worse |
| White text on `#C8401A` | 5.00 | Passes AA |
| `#91959D` muted text on `#FFFFFF` / `#F7F5F0` | 3.00 / 2.76 | **Fails AA** |
| `#6B6F77` on `#FFFFFF` / `#F7F5F0` | 5.04 / 4.63 | Passes AA |
| `#656A73` secondary on `#F7F5F0` | 4.99 | Passes |

Approved semantic tokens (`DECISIONS.md D-10`: logo orange `#F04E23` as brand colour, `#C8401A` for text-bearing orange, accessible muted text):

| Token | Value | Use |
|---|---|---|
| `--brand-primary` | `#F04E23` | Brand signal, arcs, active rails, focus rings, large numerals accents, selected state fills without small text |
| `--brand-action` | `#C8401A` | Primary button fill (white label), orange text links |
| `--brand-action-hover` | `#B83A16` | Hover/pressed |
| `--brand-soft` | `#FDEDE7` | Selected row tint, lock background |
| `--bg-app` | `#F7F5F0` | App background |
| `--bg-surface` | `#FFFFFF` | Surfaces |
| `--bg-subtle` | `#FBFAF7` | Table zebra / inset |
| `--text-primary` | `#121317` | |
| `--text-secondary` | `#656A73` | |
| `--text-muted` | `#6B6F77` | Replaces `#91959D` for any readable text |
| `--text-disabled` | `#91959D` | Disabled / decorative only (exempt from AA) |
| `--ivory` | `#FFF8EE` | Receipt paper / quote link backdrop |
| `--status-success` | `#157A45` | Confirmed / received / completed (5.38 on white) |
| `--status-warning` | `#8A5A00` | Expiring, delayed (5.93) |
| `--status-danger` | `#B42318` | Failed / blocked / destructive (6.57) |
| `--border-default` | `#E8E4DC` | |
| `--border-strong` | `#D5D0C5` | |
| `--radius-control` 8px · `--radius-input` 10px · `--radius-surface` 14px | | |
| `--shadow-low` `0 1px 0 rgba(18,19,23,.04)` · `--shadow-medium` `0 4px 16px rgba(18,19,23,.06)` | | |
| Density: `--row-h-comfortable` 56px · `--row-h-compact` 36px | | |
| Motion: `--dur-fast` 150ms · `--dur-base` 220ms · `--dur-complete` 380ms · `--ease` `cubic-bezier(.2,0,0,1)` | | |

Typography: **Geist** (sans) + **Geist Mono** only for tx hashes/UTRs. `font-variant-numeric: tabular-nums` on every numeric cell/figure. Scale: 64 / 48 / 32 / 24 / 20 / 16 / 15 / 14 / 13 / 12 / 11. Weights 400 / 500 / 600 only.

Status is never color-only: every status carries a text label and, where used, the three-arc glyph state (○ ◔ ●) or an icon.

## 2. Navigation

### Client (`app.inrp2p.com`)
| Item | Route | Content |
|---|---|---|
| **Exchange** (home) | `/` | Direction toggle, amount, destination, request quote → firm quote → accept |
| Trades | `/trades` | Active (non-terminal) trades, most recent first |
| History | `/history` | Completed/cancelled, receipts, CSV export |
| Destinations | `/destinations` | INR bank accounts, USDT wallets — read-only, added and archived by the desk until client TOTP exists (TD-11); `/accounts` redirects here |
| Account | `/account` | Profile, users (client admin), security, notifications |

Desktop: top bar with logo left, nav center, account right; content column max 560px (Exchange) / 960px (Trades, History).
Mobile: bottom tab bar (5 items), primary CTA sticky above it.

### Operator (`desk.inrp2p.com`)

The desk is organised by the operator's job, not by table: **Work** (what needs a person now), **Liquidity** (what
the desk can price and pay with), **Book** (who it trades with and what it made). Items the operator's roles cannot
use are not shown (Traders needs `traders:view`; P&L `pnl:view`; System health `economics:view`); the server
re-checks every page and every command regardless.

| Group | Item | Route | Go to | Content |
|---|---|---|---|---|
| Work | **Desk** (home) | `/` | `G D` | Operational strip (route rates with staleness, INR and USDT available, open trades, margin), then the priority queue — Needs action · Exceptions · Settlement · Waiting on client · Processing — filterable by group. Selecting a row opens the **context panel** beside the queue: the quote builder for a request, the sent quote for a quote, the trade workspace for a trade. |
| Work | Exceptions | `/exceptions` | `G E` | Every open exception case — trade-bound and not (unattributed deposits, statement lines nobody recorded) — by severity, with who has taken it; pending **approvals** (adjustments, cancellations) as their own list. A case opens beside the list with its resolutions. |
| Work | Orders | `/orders` | `G O` | Every trade, by state (open, on hold, completed, cancelled), searchable by ref / client / UTR / tx hash. |
| Work | Trade record | `/orders/{ref}` | — | One trade, full page: lifecycle, money in, payout legs, cases, adjustments, the audited timeline (UTRs masked), and every action the trade allows in its current state. |
| Liquidity | Rates | `/rates` | `G R` | A rate board per route and direction (publish with ↑/↓ steps of ₹0.01), recent rate changes with the rate each replaced, and **Route positions** (open route obligations and route settlements — `route_positions:view`). |
| Liquidity | INR accounts | `/inr` | `G I` | Settlement accounts with today's capacity as a meter (used / reserved / available), capacity changes (step-up), bank statement import and reconciliation history. |
| Liquidity | USDT treasury | `/usdt` | `G U` | Treasury position, watch-only wallets, the deposit-address pool with its low-pool warning, scanner state, transfers (filter: awaiting finality, unattributed). |
| Liquidity | Traders | `/trader-desk` | `G T` | Applications and settlement-detail changes to review, approved traders, the programme defaults; per trader: decision and terms, submitted details, Security Reserve, rewards, orders with their settlement. |
| Book | Clients | `/clients` | `G C` | The dealer book with volume, margin and last trade; client detail with a new request form, recent trades (repeat), destinations and who may accept a quote. |
| Book | P&L | `/pnl` | `G P` | Realized (ledger) against expected (open trades, labelled a forecast), the ledger ↔ trades reconciliation line, exports. |
| Book | System health | `/system` | `G S` | The nine monitored signals (`HEALTH_CHECKS`) against their thresholds, grouped Money · Pipelines · Desk, each with its runbook and the desk page to act on. |

Desktop: persistent 232px ink sidebar (search, grouped navigation with live counts on Desk and Exceptions,
shortcut sheet, operator), a warm off-white workspace, and a right **context panel** that keeps the list visible.
Pages refresh themselves after a command succeeds (and on a quiet interval), so a list never lies about a row the
operator just changed.

**Command bar** (`⌘K` or `/`): find a trade by ref / UTR / tx hash, a client by name, a request or quote by ref, a
case by ref; jump to any page; start an action (new request for a client). Results open where the work is done —
a trade opens its record, a case opens Exceptions on that case.

**Keyboard** (`?` shows the sheet): `G` then a letter goes to a page; in any list ↑/↓ or `J`/`K` move, `Enter` opens;
on the queue `Q` quotes, `P` opens the payout (or client-funds confirmation), `U` records or confirms a reference,
`E` resolves an exception; in the quote builder ↑/↓ steps the rate and `Q` sends. Nothing fires while typing or
with a modifier held.

**High-impact actions** are never one click. A destructive action (cancel, refund, reject, fail a leg, pause a
trader) opens a guarded confirmation that states its consequence in words and, where the audit needs one, asks
for the reason; actions marked ⧗ ask for the authenticator (step-up) at the moment they run. Each intent carries
one idempotency key, so a retry after a network error cannot act twice.

## 3. Core flows

### F1 — Client SELL USDT (in-app)
1. Exchange: toggle **Sell USDT** → type `100,000` → destination `HDFC •••• 8219` (preselected default) → optional target rate → **Request quote**.
2. State `REQUESTING`: arc loader; "Desk is pricing your request". Client can leave; notification when quoted.
3. State `QUOTE AVAILABLE / LOCKED`: `₹10,200,000` receive, `₹102.00 / USDT`, TRC20, countdown arc `01:12`. **Accept quote**.
4. At ≤ 15s: `EXPIRING` — arc and time in `--status-warning`, no flashing.
5. Accept (authenticated session, user with quote-accept permission) → `ACCEPTED` → navigates to Trade: deposit instructions — the **unique deposit address for this trade** (copy + QR), exact amount `100,000.000000 USDT`, network TRC20 warning, "Send only to this address for this trade".
6. Trade progress: Quote accepted ✓ → USDT received (Detected… → Confirmed ✓) → INR payout (`₹4,500,000 / ₹10,200,000 received`) → Completed → Receipt.
7. `EXPIRED`: "Quote expired" + **Get new quote** (prefills same request).

### F2 — Quote link (messenger)
Dealer creates quote from Desk (link quotes: default validity 3:00, minimum 2:00; the link option is disabled when less than 2:00 remains) → **Copy link** → pastes in Telegram.
1. Client taps → `/q/{token}` → sees only amount, rate, INR, network, masked destination, expiry. Opening the page changes nothing.
2. **Accept** → "Confirm it's you": masked recipients of authorized users (`a•••@acmepay.in`); one recipient is preselected if only one exists → **Send code**.
3. Six-digit code field (autofocus, `inputmode=numeric`, `autocomplete=one-time-code`), quote countdown still visible, **Resend** after 30s (max 3), attempts remaining shown after a wrong code.
4. **Confirm & accept** → one server step verifies code and accepts → confirmation with trade ref and deposit instructions (unique address) → "Open in INRP2P" (sign in) for tracking.
5. Quote expires during verification → "Quote expired" + "Ask the desk for a new quote"; the code is void.
6. **Not now** (no code) → local dismissal only: "Closed on this device. The quote stays open until it expires." No server call; the quote remains SENT.
7. **Reject with code** → same verification as step 2–3 → "Rejected. The desk has been notified." (`quote.reject_via_link`).

### F3 — Client BUY USDT
Toggle **Buy USDT** → amount in USDT or INR (fixed side switch) → destination wallet `TRC20 · TXq…9fA2` → quote → accept → pay INR instructions: our collection account (masked name + full details shown once to authenticated client), exact amount, reference code → client submits UTR → operator confirms → USDT sent (tx hash shown when confirmed) → Completed.

### F4 — Dealer quoting
Desk queue row "New request · 100,000 USDT → INR · asks 102.00 · route 104.20 · +₹220,000" → **Quote** opens right panel: client rate prefilled with target (editable), validity 90s in-app (switches to 3:00 default, minimum 2:00, when **Create link** is ticked), live computed INR + margin → **Send** (+ copy link). Changing rate below/above target marks it **Counter**. **Decline** requires reason.

### F5 — Settlement operator payout (SELL)
Trade reaches FIRST_LEG_CONFIRMED → queue group "Settlement · Create INR payout" → panel shows obligation `₹10,200,000`, remaining `₹10,200,000` → **Paid by**:
- **Exchange account** → account list with today's available capacity → select `HDFC · Company A` → amount `₹2,000,000` → reserve & create leg → **Mark sent** → **Add UTR** → **Confirm** (step-up).
- **Route (direct)** (only on `DIRECT_TO_CLIENT` trades) → amount `₹10,200,000` → create leg → **Route reported sent** → **Add UTR** → **Confirm** (step-up). One confirm completes the client leg and records the route side; no capacity is used. Operators without `economics:view` see no route amounts.
→ next leg… → auto-complete when remaining = 0.

### F5b — Route positions (FINANCE)
Rates → Route positions: per obligation, *route delivers* (e.g. ₹10,420,000 · allocated ₹10,200,000 direct · remaining ₹220,000) and *exchange delivers* (100,000 USDT · remaining 100,000) → **Record route settlement** (route → exchange, exchange → route) with UTR/tx → **Confirm** (step-up), which posts the movement journal and allocates the side the settlement was recorded against in the same transaction. There is no separate allocate action. Direct allocations appear read-only, linked to the client leg and its UTR — confirming that leg already allocated the route side (FI-64).

### F6 — Exception
Scanner detects `99,950 USDT` on a 100,000 trade → trade hold → queue group "Exception" with red rail + label "Short by 50 USDT" → panel shows resolution options (Wait for top-up · Adjust trade to received (approval) · Refund & cancel) → chosen command → audit.

## 4. Component inventory

| Component | Purpose | Variants / props (semantic) | Used in |
|---|---|---|---|
| `MoneyInput` | Large exact amount entry | `currency`, `density`, `max`, rejects excess decimals | Exchange, quote panel, payout |
| `CurrencySelector` | Asset/fiat + network display | `readonly` in V1 (USDT·TRC20, INR) | Exchange |
| `DirectionToggle` | Sell / Buy | `size` | Exchange, quote link header |
| `RateDisplay` | One rate with unit | `kind="client" | "route" | "reference"` (distinct styling + label always) , `state="indicative" | "firm"` | everywhere |
| `RateComparison` | Client vs route vs spread | operator only | Desk panel, trade economics |
| `FirmQuote` | Locked quote block | `state` REQUESTING…UNAVAILABLE | Exchange, quote link |
| `QuoteCountdown` | Single thin arc + mm:ss | `expiresAt` (server), reduced-motion fallback = text only | FirmQuote |
| `QuoteStatus` | Text + glyph | quote states | Orders, link |
| `MarginDisplay` | System-computed margin | `realized | expected`, sign | Desk, P&L, trade |
| `TradeHeader` | `100,000 USDT → ₹10,200,000` + rate, ref, start time | `audience="client" | "operator"` | Trade |
| `TradeProgress` | 4 structural stages | direction-aware labels | Trade |
| `SettlementProgress` | received / remaining with bar | | Trade |
| `SettlementLegRow` | amount · status · UTR masked · time | `density`, `audience` | Trade, payout panel |
| `CapacityMeter` | capacity / used / reserved / available | `status` | INR |
| `BankAccountRow` | masked account + bank + status | | Destinations, pickers |
| `WalletRow` | shortened address + network + label | | Destinations, pickers, USDT |
| `UTRField` | normalized entry with duplicate check feedback | | Payout |
| `TransactionHash` | mono, middle-ellipsis, copy, explorer link | | Trade, USDT |
| `OperationalStatus` | lifecycle label + hold overlay | | Desk, Orders |
| `ActionQueue` | grouped priority list with next action | groups: Needs action · Processing · Waiting client · Settlement · Exception | Desk |
| `TradeTable` | dense sortable table | `density="compact"` | Orders, Clients, P&L |
| `NumericCell` | right-aligned tabular numbers | `currency`, `emphasis` | tables |
| `PnlSummary` | realized row + separated expected row | | P&L |
| `Receipt` | document layout (screen + print) | | Receipt page, PDF |
| `EmptyState` | calm text, one action | | all |
| `ExceptionBanner` | blocking/warning with resolution entry | | Trade, panel |
| `AcceptanceVerification` | recipient picker + `OtpInput` + resend/attempts, inside the quote countdown | states: choose · sent · invalid · locked · expired | Quote link |
| `OtpInput` | 6-digit one-time code entry | `autocomplete=one-time-code` | Quote link, client login |
| `DepositAddress` | unique per-trade TRC20 address, copy, QR, exact amount | | Trade, link confirmation |
| `PayerSelector` | payout leg payer: exchange account / route (direct), mode-aware | | Payout panel |
| `RoutePositionRow` | route obligation: delivers / receives / allocated / remaining | operator with `route_positions:view` | Rates → Route positions |
| `DepositPoolStatus` | capability + available/assigned/cooldown counts | | USDT |
| `Button` | `intent="primary" | "secondary" | "ghost" | "danger"`, `size` | | all |
| `ArcLoader` | one moving brand arc | | loading |
| `StepUpDialog` | MFA re-verification | | operator money actions |
| `CommandBar` | ⌘K search | | operator |

Formatting rules (in `ui/format`, `DECISIONS.md D-11`): INR uses **international three-digit grouping** on client and operator surfaces (`₹10,200,000`, `₹10,200,000.00` where paise matter); the formatter is deterministic and ignores browser/runtime locale. Exports and JSON carry ungrouped decimals. Compact forms (`₹6.5M`) only in summaries, never in a row where exact value is the evidence. USDT shown to 2 dp in summaries, 6 dp in deposit instructions and receipts.

## 5. Wireframes

### W1 — Exchange (client, desktop; mobile = same column, full width, CTA sticky)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [mark] INRP2P Exchange        Exchange  Trades  History  Bank & Wallets   ◐ │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                    ┌────────────┬────────────┐                               │
│                    │ Sell USDT ▪│  Buy USDT  │                               │
│                    └────────────┴────────────┘                               │
│                                                                              │
│                    SELL                                                      │
│                    100,000                          ← 56px tabular, input     │
│                    USDT · TRC20                                              │
│                                                                              │
│                    ↓                                                         │
│                                                                              │
│                    YOU RECEIVE                                               │
│                    ₹ —                              ← until firm quote        │
│                    Rate provided by desk                                     │
│                                                                              │
│                    Receive to   HDFC •••• 8219                    Change ›   │
│                    Target rate  ₹ ______  (optional)                         │
│                                                                              │
│                    [          Request quote          ]                       │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### W2 — Firm quote (LOCKED → EXPIRING → EXPIRED)

```
                    SELL
                    100,000 USDT · TRC20

                    YOU RECEIVE
                    ₹10,200,000

                     ◜‾‾‾‾‾‾◝
                    ⎛ ₹102.00 ⎞    Quote locked            ← thin orange arc = time left
                     ◟______◞     01:12 remaining

                    Receive to   HDFC •••• 8219
                    Settlement   INR in multiple transfers, tracked per UTR

                    [          Accept quote          ]
                    Decline

  EXPIRED:          ₹102.00 (struck, muted)
                    Quote expired
                    [         Get new quote          ]
```

### W3 — Quote link (mobile 375px)

```
┌───────────────────────────────┐
│ [mark] INRP2P Exchange        │
│                               │
│ Private quote · Q-8F2K        │
│                               │
│ You sell                      │
│ 100,000 USDT                  │
│ TRC20                         │
│                               │
│ You receive                   │
│ ₹10,200,000                   │
│ at ₹102.00 / USDT             │
│                               │
│ To  HDFC •••• 8219            │
│                               │
│ ◔  Valid for 01:12            │
│                               │
│                               │
│ [        Accept quote       ] │  ← thumb zone, sticky
│   Not now · Reject with code  │
└───────────────────────────────┘
```

### W3b — Quote link acceptance verification (mobile 375px)

```
┌───────────────────────────────┐
│ [mark] INRP2P Exchange        │
│                               │
│ You sell 100,000 USDT         │
│ You receive ₹10,200,000       │
│ ◔  Valid for 00:58            │
│                               │
│ Confirm it's you              │
│ We'll send a code to          │
│ ◉ a•••@acmepay.in             │
│ ○ r•••@acmepay.in             │
│                               │
│ Code                          │
│ [ _  _  _  _  _  _ ]          │
│ Resend in 0:24                │
│                               │
│ [     Confirm & accept      ] │
│         Cancel                │
└───────────────────────────────┘
```

### W4 — Trade (client, desktop; mobile stacks right column below, legs vertical)

```
┌──────────────────────────────────────────────────────┬──────────────────────┐
│ IX-260916-1842 · Started 16:11 IST                   │ Summary              │
│                                                      │ Rate      ₹102.00    │
│ 100,000 USDT  →  ₹10,200,000                         │ Network   TRC20      │
│ at ₹102.00                                           │ You sent  from       │
│                                                      │   TXq…9fA2           │
│ ● Quote accepted        16:11                        │ Receive   HDFC ••8219│
│ ● USDT received         16:14  tx 7c1e…a90b ↗        │                      │
│ ◔ INR payout            in progress                  │ Documents            │
│ ○ Completed                                          │   Receipt (on done)  │
│                                                      │                      │
│ INR SETTLEMENT                                       │ Need help?           │
│ ₹4,500,000 received          ₹5,700,000 remaining    │   Report a problem   │
│ ████████████░░░░░░░░░░░░░░░                           │                      │
│                                                      │                      │
│ ₹2,000,000   Received    UTR ••••7118   16:31        │                      │
│ ₹2,500,000   Received    UTR ••••4412   16:36        │                      │
│ ₹2,500,000   Processing                              │                      │
│ ₹2,000,000   Pending                                 │                      │
│ ₹1,200,000   Pending                                 │                      │
└──────────────────────────────────────────────────────┴──────────────────────┘
```

### W5 — Operator Desk (desktop 1440)

```
┌────────┬──────────────────────────────────────────────────────────────────────────────────┐
│ Desk ▪ │ USDT→INR route ₹104.20 · INR→USDT route ₹100.00 · INR avail ₹18.4M ·              │
│ Orders │ USDT avail 1,200,220 · Open trades 7 · Gross margin today ₹612,400 (realized)      │
│ Rates  ├──────────────────────────────────────────────────────────────────────────────────┤
│ INR    │ NEEDS ACTION (3)                                                                 │
│ USDT   │▌Acme Pay   SELL 100,000 USDT  asks 102.00  route 104.20  +₹220,000  New request [Quote]  │
│ Clients│▌Nova OTC   SELL  45,000 USDT  —           route 104.20  —         USDT confirmed [Create INR payout] │
│ P&L    │▌Orbit Ltd  BUY   20,000 USDT  101.10      route 100.00  +₹22,000  INR claimed  [Confirm INR]  │
│        │ SETTLEMENT (2)                                                                   │
│ ────── │  Kite FX    SELL 250,000 USDT  102.10  104.30  +₹550,000  ₹14.5M/₹25.5M  [Add UTR]  │
│Settings│ WAITING CLIENT (1)                                                               │
│        │  Delta Pay  SELL  60,000 USDT  quote 102.05 · expires 00:48            [Copy link]  │
│        │ PROCESSING (1)                                                                   │
│        │  Sigma      SELL 100,000 USDT  USDT detected · 12/19 blocks                         │
│        │ EXCEPTION (1)                                                                    │
│        │▌Zen Pay     SELL 100,000 USDT  Short by 50 USDT                          [Resolve]   │
└────────┴──────────────────────────────────────────────────────────────────────────────────┘
 ▌ = thin rail: --brand-primary for action, --status-danger for exception. Numbers right-aligned tabular.
 Row select opens right context panel (quote builder / payout builder / exception resolver) without leaving the queue.
 Note: "12/19 blocks" wording to be validated against the TRON solidification signal actually exposed.
```

### W6 — INR settlement panel (operator, right context panel 380px + legs)

```
┌───────────────────────────────────────────┐
│ IX-260916-1842 · Acme Pay · SELL          │
│ Obligation          ₹10,200,000           │
│ Confirmed           ₹4,500,000            │
│ In flight           ₹2,500,000            │
│ Unallocated         ₹3,200,000            │
│ ─────────────────────────────────────     │
│ New payout leg                            │
│ Paid by (•) Exchange account ( ) Route    │
│ From  HDFC · Company A                    │
│       Available today ₹800,000  ▓▓▓▓▓░    │
│       ICICI · Company B                   │
│       Available today ₹6,100,000 ▓▓░░░░   │
│ Amount ₹ [ 2,000,000 ]  max ₹3,200,000    │
│ [ Reserve & create leg ]                  │
│ ─────────────────────────────────────     │
│ L3 ₹2,500,000 Processing  ICICI·B         │
│    UTR [______________]  [Save UTR]       │
│    Proof [Attach]        [Confirm ⧗]      │
│ L4 ₹2,000,000 Pending    ICICI·B [Mark sent]│
└───────────────────────────────────────────┘
```

## 6. Responsive rules

| Breakpoint | Client | Operator |
|---|---|---|
| ≥ 1280 | Centered column (Exchange 560, lists 960) | Sidebar + workspace + right panel |
| 1024–1279 | Same | Sidebar collapses to icons; right panel overlays |
| 768–1023 | Same, top nav | Queue as full width; panel as full-height sheet |
| < 768 | Bottom tab bar; CTA sticky; all tables become vertical rows; no horizontal scroll of financial data | Monitoring mode: queue as cards with the single next action; confirmation actions allowed; quote building, capacity changes and adjustments hidden ("Open on desktop") |

Other rules: minimum touch target 44px; amounts never truncate — they wrap or step down one type size (max two steps) and the layout reflows; `prefers-reduced-motion` removes arc animation and number tweening (instant updates); keyboard: Desk rows navigable with ↑/↓, Enter opens panel, action hotkeys shown on hover (Q quote, P payout, U UTR, E exception).

## 7. Validation list (before design sign-off)
Client: Exchange desktop/mobile, Firm quote, Expired quote, Quote link mobile, Active trade, Partial INR settlement, Completed trade, History, Receipt.
Operator: Desk, New request, Quote creation, Trade processing, Partial settlement, Exception trade, Exceptions & approvals, Trade record, Rates, INR accounts, USDT treasury, Clients, P&L, System health.
