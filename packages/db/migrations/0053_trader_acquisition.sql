-- 0053 Where traders come from (2026-11-21).
--
-- `inrp2p.com/traders` is the one page every trader campaign links to — Telegram posts, LinkedIn, affiliates, communities
-- and, later, paid campaigns. The owner needs to see, per campaign, how many visitors became applications and how many of
-- those became verified, collateralized, active traders. Nothing in the database could say where a trader came from.
--
-- 1. `acquisition_visitor`: one row per browser that reached the page, written once — a random id the page's own cookie
--    carries (never a person's, never derived from anything about them), the first touch it arrived with (the campaign's
--    `utm_*` words, a referral code, which ad network's click it was, the referring host — a host, never an address), the
--    side of the business it came for, and the country and kind of device the edge reported. No address, no email, no
--    name, no amount: nothing here identifies a person or says anything about their money.
-- 2. `acquisition_event`: what that browser did on the way in — saw the page, chose a side, tried the earnings example,
--    pressed a call to action, reached the trader sign-in — each with the touch it had at that moment (its last one).
--    The example's figures are never sent: only that it was used.
-- 3. `acquisition_link`: the moment a visitor signs in on the trader path, its id is linked to the person's sign-in
--    identity. From there the rest of the funnel is read from what already exists — the application (`trader_profile.
--    applied_by`), its review, the Security Reserve on the ledger and the trader's completed orders — so nothing in the
--    business is written twice and nothing about it is copied into analytics.
--
-- All three are records, not logs to edit: no UPDATE, no TRUNCATE. The application may only add and read. Rows are never
-- exported, and the database owner may delete them when they are no longer needed.
--
-- No error code belongs to this migration. 0001–0052 are not edited.

CREATE TABLE acquisition_visitor (
  id             uuid PRIMARY KEY,
  -- The first touch: a campaign's own words, lower-cased and cut to a safe alphabet by the application.
  source         text CHECK (source IS NULL OR source ~ '^[a-z0-9._~+-]{1,64}$'),
  medium         text CHECK (medium IS NULL OR medium ~ '^[a-z0-9._~+-]{1,64}$'),
  campaign       text CHECK (campaign IS NULL OR campaign ~ '^[a-z0-9._~+-]{1,64}$'),
  content        text CHECK (content IS NULL OR content ~ '^[a-z0-9._~+-]{1,64}$'),
  term           text CHECK (term IS NULL OR term ~ '^[a-z0-9._~+-]{1,64}$'),
  -- A partner's or a trader's referral code.
  ref            text CHECK (ref IS NULL OR ref ~ '^[a-z0-9_-]{1,40}$'),
  -- An ad network's click: which network, and its click id (kept so a future campaign can report its conversions back).
  click_kind     text CHECK (click_kind IS NULL OR click_kind IN ('GOOGLE', 'META', 'LINKEDIN', 'MICROSOFT', 'TIKTOK', 'X')),
  click_id       text CHECK (click_id IS NULL OR click_id ~ '^[A-Za-z0-9._~-]{1,200}$'),
  -- The referring page's host only (`t.me`, `linkedin.com`), never its path.
  referrer_host  text CHECK (referrer_host IS NULL OR referrer_host ~ '^[a-z0-9.-]{1,120}$'),
  segment        text CHECK (segment IS NULL OR segment IN ('USDT', 'INR', 'OTC')),
  -- What the edge said: ISO 3166-1 alpha-2, and the kind of device from its user agent (the agent itself is not kept).
  country        text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  device         text CHECK (device IS NULL OR device IN ('MOBILE', 'TABLET', 'DESKTOP')),
  -- When the first touch happened (the cookie's own time, bounded by the application), and when the row was written.
  first_at       timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (click_id IS NULL OR click_kind IS NOT NULL)
);
CREATE INDEX acquisition_visitor_first_at ON acquisition_visitor (first_at DESC);

CREATE TABLE acquisition_event (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  visitor_id     uuid NOT NULL REFERENCES acquisition_visitor (id),
  kind           text NOT NULL CHECK (kind IN ('VIEW', 'SEGMENT', 'ESTIMATE', 'CTA', 'CONTACT', 'SIGN_IN', 'FAQ', 'ENTRY')),
  -- Where it happened: the acquisition page, or the trader sign-in on the app's host.
  page           text NOT NULL CHECK (page IN ('TRADERS', 'BECOME_A_TRADER')),
  segment        text CHECK (segment IS NULL OR segment IN ('USDT', 'INR', 'OTC')),
  -- Which call to action, question or contact, in the page's own words for it (`hero`, `sticky`, `closing`).
  placement      text CHECK (placement IS NULL OR placement ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- The touch the visitor had at that moment: its last one.
  source         text CHECK (source IS NULL OR source ~ '^[a-z0-9._~+-]{1,64}$'),
  medium         text CHECK (medium IS NULL OR medium ~ '^[a-z0-9._~+-]{1,64}$'),
  campaign       text CHECK (campaign IS NULL OR campaign ~ '^[a-z0-9._~+-]{1,64}$'),
  content        text CHECK (content IS NULL OR content ~ '^[a-z0-9._~+-]{1,64}$'),
  term           text CHECK (term IS NULL OR term ~ '^[a-z0-9._~+-]{1,64}$'),
  ref            text CHECK (ref IS NULL OR ref ~ '^[a-z0-9_-]{1,40}$'),
  referrer_host  text CHECK (referrer_host IS NULL OR referrer_host ~ '^[a-z0-9.-]{1,120}$'),
  at             timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX acquisition_event_visitor ON acquisition_event (visitor_id, at);
CREATE INDEX acquisition_event_at ON acquisition_event (at DESC);

CREATE TABLE acquisition_link (
  visitor_id     uuid NOT NULL REFERENCES acquisition_visitor (id),
  user_id        uuid NOT NULL REFERENCES auth_user (id),
  at             timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (visitor_id, user_id)
);
CREATE INDEX acquisition_link_user ON acquisition_link (user_id, at);

CREATE TRIGGER acquisition_visitor_append_only BEFORE UPDATE OR TRUNCATE ON acquisition_visitor
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();
CREATE TRIGGER acquisition_event_append_only BEFORE UPDATE OR TRUNCATE ON acquisition_event
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();
CREATE TRIGGER acquisition_link_append_only BEFORE UPDATE OR TRUNCATE ON acquisition_link
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- Grants -------------------------------------------------------------------------------------------------------------

GRANT SELECT, INSERT ON acquisition_visitor, acquisition_event, acquisition_link TO inrp2p_app;
GRANT SELECT ON acquisition_visitor, acquisition_event, acquisition_link TO inrp2p_readonly;
