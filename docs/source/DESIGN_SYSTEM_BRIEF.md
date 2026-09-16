# INRP2P Exchange — Design System

## Source of truth

The design system is part of the product architecture.

Do not build the functional product first and "redesign it later".

Before implementing production pages, define and implement the visual system, layout rules, financial components, and interaction patterns that all INRP2P Exchange surfaces will use.

Use the supplied existing INRP2P logo as the brand source of truth.

Do not redesign, reinterpret, or replace the logo.

The logo contains the core visual DNA:

- Indian rupee at the center
- three surrounding structural arcs
- three connected nodes
- circular movement
- strong coral/orange field
- warm ivory mark

Evolve these ideas into the interface without literally repeating the logo everywhere.

---

## Product character

INRP2P Exchange is an India-first INR ↔ USDT exchange built for professional/high-risk payment flows.

It must feel:

- serious
- fast
- expensive
- clear
- financial
- operational
- confident

It must not feel:

- crypto-casino
- cyberpunk
- Web3-template
- generic SaaS
- consumer neobank
- AI-generated
- gamified
- over-designed

No fake futurism.

No unnecessary decorative 3D crypto coins.

No neon grids.

No glowing blockchain networks.

No excessive glassmorphism.

No gradients used merely to make empty screens look "premium".

Premium quality must come from:

- typography
- spacing
- hierarchy
- precision
- motion
- financial information design
- interaction quality
- consistency

---

## Brand palette

Use a restrained palette derived from the existing logo.

Suggested core brand orange:

`#FF4B2B`

Refine from the actual logo asset if necessary.

Warm ivory:

`#FFF8EE`

Application background:

`#F7F5F0`

Primary surface:

`#FFFFFF`

Primary text:

`#121317`

Secondary text:

`#656A73`

Muted text:

`#91959D`

Borders:
very subtle warm neutral grey.

Orange is not the page background throughout the product.

Use orange intentionally for:

- primary action
- active quote
- rate lock
- selected state
- brand signal
- important operational focus
- controlled motion

Use green only for:

- confirmed
- received
- completed
- positive operational state

Use red only for:

- failed
- blocked
- critical exception
- destructive action

Do not use random status colors.

---

## Typography

Use a modern high-quality grotesk suitable for financial interfaces.

Prefer:

- Geist
- Inter
- or an equivalent production-safe font

Do not use futuristic display fonts.

Money and rates are the visual center of the product.

Support high-quality tabular numerals.

Use tabular numeric alignment wherever amounts or rates are compared vertically.

Examples:

`100,000 USDT`  
`₹10,200,000`  
`₹102.00`  
`₹220,000 margin`

Large financial numbers should feel calm and precise.

Avoid excessive ultra-bold typography.

Suggested hierarchy:

- Display: 48–72px desktop where appropriate
- Page title: 28–36px
- Section heading: 18–24px
- Body: 14–16px
- Operational table: 13–15px
- Micro/meta: 11–13px

Use typography hierarchy before adding containers/cards.

---

## Spacing

Use a consistent 4px base spacing system.

Primary steps:

- 4
- 8
- 12
- 16
- 20
- 24
- 32
- 40
- 48
- 64
- 80

Do not invent arbitrary margins page by page.

Favor strong whitespace on client surfaces.

Favor compact but readable density on operator surfaces.

---

## Radii

Avoid oversized generic SaaS rounded cards.

Suggested:

- small controls: 8px
- inputs/buttons: 10–12px
- major interactive surfaces: 14–16px

Do not use 24–32px rounding everywhere.

---

## Shadows

Use shadows sparingly.

Prefer:

- border
- surface contrast
- subtle elevation

over large blurred shadows.

Financial interfaces should feel structurally precise rather than floating.

---

## Brand motif

The three arc segments in the existing logo become a subtle reusable product motif.

Use them to express:

- quote
- transfer
- settlement

or:

- requested
- funded
- completed

Examples:

- a rate-lock countdown may use one thin circular arc
- a completed trade may resolve into the complete three-segment motif
- loading states may use one moving brand arc instead of a generic spinner
- settlement progress may use three structured stages inspired by the mark

Do not turn every progress indicator into the logo.

The motif should feel discovered, not forced.

---

## Client UX principle

The client interface must be simpler than the operator interface.

A client should understand the core exchange interaction within seconds.

Primary client navigation:

- Exchange
- Trades
- History
- Bank & Wallets
- Account

Do not present a generic dashboard before Exchange.

Exchange is the default home surface.

---

## Client Exchange page

The visual center is the exchange itself.

Example:

### SELL USDT

`100,000`

`USDT · TRC20`

↓

### YOU RECEIVE

`₹10,200,000`

`₹102.00 / USDT`

Bank:

`HDFC •••• 8219`

Quote:

`01:12 remaining`

**Sell USDT**

The screen should feel like a premium financial calculator.

Do not place this inside five nested cards.

Use typography, alignment, and whitespace.

Provide a clear direction switch:

- Sell USDT
- Buy USDT

Switching direction must feel instant.

---

## Quote states

Design explicit states:

- REQUESTING
- QUOTE AVAILABLE
- LOCKED
- EXPIRING
- ACCEPTED
- EXPIRED
- UNAVAILABLE

A firm quote must visually feel different from an indicative rate.

Never make indicative pricing look executable.

---

## Quote lock

Create a distinctive INRP2P rate-lock interaction.

The locked rate is the focal point.

Example:

`₹102.00`

Quote locked

`00:42`

Use a restrained circular/arc progress treatment inspired by the logo.

Do not use aggressive flashing countdowns.

At low time:
increase emphasis subtly.

On expiry:

**Quote expired**

`Get new quote`

No error theatrics.

---

## Quote Link

Private quote pages must be extremely clean and trustworthy on mobile.

They are often opened from Telegram or WhatsApp.

Show only:

- INRP2P Exchange branding
- trade direction
- amount
- rate
- expected settlement amount
- network
- bank/wallet target
- expiry
- Accept
- Reject

Do not expose operator-side information.

Do not require navigating the entire application just to accept a quote.

---

## Trade screen

Trade view must feel like a settlement record, not a chat.

Desktop layout:

Left/main:
- trade economics
- progress
- settlement legs

Right:
- summary
- wallet
- bank information
- documents
- support/exception action

Example header:

`100,000 USDT`

→

`₹10,200,000 INR`

Rate:

`₹102.00`

Trade ID:

`IX-260916-1842`

Started:

`16:11 IST`

Settlement progress:

- Quote accepted ✓
- USDT received ✓
- INR payout ●
- Completed ○

Use simple structural hierarchy.

Do not turn every state into a colored chip.

---

## Settlement legs

INR payout legs must be visually excellent because this is a core product workflow.

Example:

`₹2,000,000`  
Received  
UTR ••••7118  
16:31

`₹2,500,000`  
Received  
UTR ••••4412  
16:36

`₹2,500,000`  
Processing

`₹1,200,000`  
Pending

Show:

`₹6.5M received`  
`₹3.7M remaining`

at the top.

Each payout row must be scannable immediately.

---

## Operator design principle

The operator side is desktop-first and information-dense.

Do not use the same visual density as the client app.

Operator navigation:

- Desk
- Orders
- Rates
- INR
- USDT
- Clients
- P&L
- Settings

Potential later modules must not distort V1 navigation.

---

## Operator Desk

This is the most important internal screen.

Do not create a generic dashboard containing six equal statistic cards.

The primary question is:

**What needs action right now?**

Top operational strip may show:

- USDT → INR route rate
- INR → USDT route rate
- INR available
- USDT available
- Open trades
- Today's gross margin

Then immediately show the live work queue.

Example row:

`100,000 USDT → INR`

Client asks:

`102.00`

Route:

`104.20`

Potential margin:

`+₹220,000`

Status:

`New request`

Action:

`Quote`

Numbers must align vertically.

Potential margin should be immediately recognizable without becoming visually loud.

Use thin orange active rails or emphasis for rows requiring action.

Avoid rainbow status pills.

---

## Desk queue

Support clear priority groups:

- Needs action
- Processing
- Waiting client
- Settlement
- Exception

Do not bury critical operational items inside filters.

A dealer should see today's work immediately after login.

---

## Rates page

Rates must feel like a dealer control surface, not a crypto market terminal.

Show:

- Current route rate
- Previous rate
- Last updated
- Available amount
- Direction

Example:

### USDT → INR

`₹104.20`

Previous:

`₹104.00`

Updated:

`16:42 IST`

Available:

`780,000 USDT`

**Update route rate**

Below:
recent rate history.

Do not add candlestick charts.

A simple historical line/table is enough when useful.

---

## Margin visualization

Client rate and route rate are different concepts.

Design them visually so an operator cannot confuse them.

Example:

Client:

`₹102.00`

Route:

`₹104.20`

Spread:

`₹2.20`

Volume:

`100,000 USDT`

Gross margin:

`₹220,000`

Gross margin must be calculated by the system and never manually typed.

---

## INR Accounts

Design as an operational capacity screen.

Example:

### HDFC · Company A

Working capacity:

`₹2.5M`

Used:

`₹1.7M`

Reserved:

`₹0`

Available:

`₹800k`

`ACTIVE`

Use a restrained progress/capacity bar.

Do not create flashy charts.

The operator must understand available settlement capacity in one glance.

---

## USDT Treasury

Design around operational position.

Example:

### TRC20

Observed:

`1,840,220 USDT`

Reserved:

`640,000`

Available:

`1,200,220`

Incoming:

`315,000`

Outgoing:

`230,000`

Today received:

`2.1M`

Today sent:

`1.7M`

Do not make this look like a retail crypto wallet.

No token price charts.

No token discovery.

---

## Clients

Client list should resemble an efficient dealer book.

Columns:

- Client
- Contact
- Typical volume
- Last rate
- Completed volume
- Margin generated
- Last trade
- Status

Client detail:

- identity/contact
- Telegram
- WhatsApp
- bank accounts
- wallets
- pricing notes
- recent trades
- completed volume
- margin generated

Primary actions:

- Create Quote
- Repeat Trade

Do not turn Clients into Salesforce.

---

## P&L

P&L is operational, not decorative.

Primary numbers:

- Realized gross margin today
- Completed volume today
- Average margin / USDT
- Completed trades

Then trade-level detail.

Open trade expected margin must be visually separated from realized margin.

Never combine realized and expected P&L into one headline number.

---

## Receipt design

Settlement receipts are part of the brand.

They must feel like professional financial documents.

Header:

**INRP2P Exchange**

**SETTLED**

Use the completed three-arc logo motif subtly.

Show:

- Trade ID
- date
- direction
- USDT amount
- INR amount
- executed rate
- network
- blockchain tx
- INR payout legs
- UTRs
- settlement duration
- fees if any
- completion time

Use warm white, near-black text, and controlled orange details.

No gradients inside PDF receipts.

Receipts must print correctly in grayscale.

---

## Landing page

Do not build a generic startup landing page.

Do not start with:

- The future of...
- Revolutionizing...
- Next-generation...
- Seamless...
- Unlock...

Use concrete language.

Recommended hero:

# INRP2P Exchange

## Buy & Sell USDT in India.

Large trades.  
Locked rates.  
INR settlement.

**Sell USDT**  
**Buy USDT**

Include a live-looking exchange module in the hero using real product UI.

Do not show fabricated volume or rates.

Below hero, explain actual workflow:

1. Request rate
2. Lock quote
3. Send funds
4. Track settlement

Then show the real Trade UI.

Then explain large INR settlements / settlement tracking.

Then security/operational reliability.

Then FAQ.

Do not create twenty marketing sections.

SEO pages must reuse the same design system.

---

## Motion

Motion is functional.

Use approximately:

- 120–180ms for small feedback
- 180–260ms for normal transitions
- up to 400ms for significant state completion

Use controlled easing.

No springy/bouncy fintech buttons.

Good motion:

- quote value updates smoothly
- rate locks into place
- countdown arc progresses
- trade stage completes
- settlement total increments when a payout is confirmed
- receipt transitions to SETTLED

Bad motion:

- floating cards
- random background movement
- parallax for no reason
- rotating crypto tokens
- constant glowing elements

---

## Mobile

Client Exchange and Quote Link are mobile-first quality.

Important mobile requirements:

- large numeric inputs
- thumb-accessible primary CTA
- clear quote expiry
- easy bank/wallet selection
- no horizontal financial tables

Trade payout legs become vertical rows.

Operator Desk is desktop-first.

On mobile, provide functional monitoring and critical actions, but do not destroy desktop information density just to make every operator feature identical on mobile.

---

## Accessibility

Meet WCAG AA contrast.

All financial states must remain understandable without relying only on color.

Keyboard navigation must work for operator workflows.

Visible focus states.

Inputs need labels.

Respect prefers-reduced-motion.

---

## Component system

Create reusable financial components instead of page-specific JSX/CSS.

At minimum:

- MoneyInput
- CurrencySelector
- DirectionToggle
- RateDisplay
- RateComparison
- FirmQuote
- QuoteCountdown
- QuoteStatus
- MarginDisplay
- TradeHeader
- TradeProgress
- SettlementLegRow
- SettlementProgress
- CapacityMeter
- BankAccountRow
- WalletRow
- UTRField
- TransactionHash
- OperationalStatus
- ActionQueue
- TradeTable
- NumericCell
- PnlSummary
- Receipt
- EmptyState
- ExceptionBanner

Create semantic component variants.

Example:

`<Button intent="primary">`  
`<Button intent="secondary">`  
`<Button intent="danger">`

Do not create classes such as:

- orangeButton
- greenCard
- specialTradeButton

---

## Style tokens

Create centralized semantic tokens.

Examples:

- --bg-app
- --bg-surface
- --bg-subtle
- --text-primary
- --text-secondary
- --text-muted
- --brand-primary
- --brand-primary-hover
- --brand-soft
- --status-success
- --status-warning
- --status-danger
- --border-default
- --border-strong
- --radius-control
- --radius-surface
- --shadow-low
- --shadow-medium

Do not reference raw hex colors throughout components.

---

## Density modes

Client interface:
comfortable.

Operator tables:
compact.

Use shared tokens with controlled density variants rather than two unrelated design systems.

---

## Responsive grid

Use a consistent application grid.

Desktop operator:

- persistent sidebar
- wide central workspace
- optional right context panel

Client:

- centered financial workspace
- controlled max-width

Do not stretch forms across 1600px displays.

---

## Design implementation quality

Use one component architecture.

No duplicate components for nearly identical use cases.

No page-level styling hacks.

No random one-off spacing.

No arbitrary font sizes.

No hard-coded colors inside components.

Create a component development surface such as Storybook or an equivalent internal component gallery.

Before major pages, implement and review:

- colors
- typography
- spacing
- inputs
- buttons
- financial number formatting
- tables
- statuses
- quote components
- trade components
- settlement components

Add visual regression tests for core components and critical screens.

---

## Design validation

Before calling the design complete, validate at minimum:

### Client
- Exchange desktop
- Exchange mobile
- Firm quote
- Expired quote
- Quote link mobile
- Active trade
- Partial INR settlement
- Completed trade
- History
- Receipt

### Operator
- Desk
- New request
- Quote creation
- Trade processing
- Partial settlement
- Exception trade
- Rates
- INR accounts
- USDT treasury
- Clients
- P&L

Test with realistic values:

- 100,000 USDT
- ₹10,200,000
- ₹104.20
- ₹102.00
- ₹220,000 margin

Do not design using tiny placeholder amounts such as ₹100 or 10 USDT.

Large real financial values must fit without breaking layouts.

---

## Design principle

Client side:

**as easy as messaging an exchange desk**

Operator side:

**more organized than Telegram + Excel + calculator + blockchain explorer**

The UI is successful only if a real exchange operator could keep INRP2P open all day.

Do not prioritize visual novelty over operational clarity.

But do not accept generic SaaS quality either.

INRP2P must be visually recognizable without relying on its logo:

- warm off-white
- near-black financial typography
- controlled coral/orange signal
- large precise money figures
- three-arc settlement motif
- clean settlement progress
- strong operational tables

This is the visual language of INRP2P Exchange.

---

## Conflict rule

If the Master Prompt and Design System ever conflict:

- Master Prompt wins on financial/business correctness.
- Design System wins on visual/interaction decisions.
- If the conflict affects both, stop and report the conflict instead of guessing.
