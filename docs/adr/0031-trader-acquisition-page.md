# ADR 0031 — `inrp2p.com/traders`: the trader acquisition page, and where traders come from

Status: **Accepted** — owner's requirement of 2026-11-21: `inrp2p.com/traders` is the single page every external trader
campaign links to (Telegram, LinkedIn, affiliates, communities, later paid campaigns), designed as a cold-traffic funnel,
with campaign and referral attribution kept through sign-in, application and activation, and nothing sensitive in
analytics. Migration `0053`, schema 53. Nothing of the escrow, the ledger, settlement, the trader programme's rules, the
client site's design or the workspace's Traders screen changes.

## 1. Context

`inrp2p.com/traders` existed, but as a door: the proxy sent any page request for a workspace section on the public host to
the same path on the app's host, so a stranger from a Telegram post landed on a sign-in form for a product they had never
heard of. The home page's "For traders" section sold the programme to people already reading the client site; nothing
spoke first to a USDT holder, someone with rupees to put to work, or an OTC desk. And nothing in the database could say
which post, partner or campaign a trader came from — so neither the owner nor a partner could see what a campaign was
worth beyond "people applied".

## 2. Decision

### 2.1 One address, its own page
On the public host, exactly `/traders` is rendered from `/lp/traders` by a rewrite in the proxy, as `/` is from `/home`;
`/lp/traders` asked for from outside is sent to `/traders` (308). Everything **under** `/traders` (`/traders/orders`, …)
is still the workspace's and still redirected to the app host, and the app host's `/traders` is the Traders screen as
before. A trader who used the old address to reach their workspace finds "Trader sign in" in the page's bar, which opens
`app…/traders` — the Traders screen, or the sign-in in front of it.

The page is the public site's in everything a crawler or a link preview sees (indexed, canonical `/traders`, its own card,
FAQ structured data, in the sitemap) and in its room and materials, but not in its frame: a campaign visitor gets a funnel,
so the page has its own bar — its sections, the market's rate, "Trader sign in", the one call to action — and a footer
that keeps only Telegram, the way to the client site and the site's notes. The client site's own design is unchanged; its
"For traders" link now leads here.

### 2.2 Three kinds of trader, one page
A USDT holder, an INR liquidity provider and an OTC merchant each get their own words where they differ — the hero's
lede and the deal's four steps — behind one switch ("I hold USDT" / "I have rupees" / "I run an OTC desk"). All three are
in the markup; the switch shows one. `?for=usdt|inr|otc` opens the page on a side, so a LinkedIn campaign for OTC desks
links straight to theirs. The side chosen travels with the application and pre-selects what the applicant provides
(`USDT` / `INR` / both); they can change it.

### 2.3 Attribution: first-party, in the visitor's own cookie, carried in the link
The proxy reads the arrival — `utm_source/medium/campaign/content/term`, a referral code (`ref`), which ad network's click
it was (`gclid`/`gbraid`/`wbraid`, `fbclid`, `li_fat_id`, `msclkid`, `ttclid`, `twclid`, with its id) and the referring
**host** — and keeps it in `inrp2p_touch`, a first-party, HttpOnly, SameSite=Lax cookie for 90 days: a random visitor id,
the first touch (kept for good) and the last touch that said where the visitor came from (a direct visit does not replace
it). Every value is cut to a small alphabet and a length or dropped (`server/acquisition.ts`). The page's calls to action
carry it to `app…/become-a-trader?t=…&for=…`, where the proxy keeps it in the app host's own cookie — the earlier first
touch wins — and redirects to the clean address. No third party is loaded or told anything; the CSP is unchanged.

### 2.4 The funnel
- On the page, the browser reports only **what** was done — seen, a side chosen, the earnings example tried, a call to
  action pressed, a contact or a question opened — by beacon to `/api/acquisition` (public host only). Who and which
  campaign are read from the cookie, so a request from elsewhere records nothing; the example's figures never leave.
- On the app host, reaching the trader sign-in is an `ENTRY`; signing in on the trader path before applying links the
  visitor id to the sign-in identity (`acquisition_link`).
- Everything after is read from where it already is: the application (`trader_profile.applied_by`), its approval, the
  Security Reserve on the ledger (`LIAB:TRADER_RESERVE:<trader>`), the trader's completed orders. Nothing about the
  business is copied into analytics, so the funnel can never disagree with it.
- The desk's Traders page has an **Acquisition** view (`traders:view`): visitors in 7/30/90 days by campaign, referral
  code or side, each counted once in the group of its first touch, through applied, approved, reserve held and first deal;
  and the latest applications that came through the page, with where each came from.

Writes never stand between a person and a page: they happen after the response (`after()`), and a write the database
refuses is logged and dropped.

### 2.5 What is kept
`acquisition_visitor` (once per visitor), `acquisition_event`, `acquisition_link` — append-only (no UPDATE or TRUNCATE),
never exported, deletable by the database owner. No IP address, email, name, phone, amount, bank or wallet detail; the
user agent is reduced to a kind of device and the edge's country is kept as its ISO code. The link to a person exists only
once they signed in on the trader path, and only as their sign-in identity's id.

## 3. Consequences

- A release at 53 needs the migration before the web deploys (the app at 53 refuses 52) and a worker image of the same
  commit; the worker reads none of these tables.
- Campaign links follow one pattern: `inrp2p.com/traders?utm_source=…&utm_medium=…&utm_campaign=…&ref=…&for=…`; the desk's
  Acquisition view shows it.
- Copy on the page lives in `content/traders.ts`, read by the copy guard like the rest of the site: no regulatory claim,
  no invented figure; the programme's terms only as `{margin}` and `{fee}`.
