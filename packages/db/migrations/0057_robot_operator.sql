-- 0057 The robot runs the front line (2026-11-28, ADR 0034 — "INRP2P Operator").
--
-- 1. `robot_policy`: what the robot may do on its own — reach people outside the app (OFF, DRY_RUN, ON), answer with
--    rules or with a model as well, the quiet hours in India, a daily cap on model answers, playbooks switched off.
--    Append-only, set by a person; the latest row is in force. Starts in DRY_RUN: it decides and records, sends nothing.
-- 2. `robot_preference`: each person's consent — every suggestion (ALL), only about what they started (SERVICE, the
--    default), or nothing outside the app (NONE); what they snoozed; what of the robot's news they have seen.
-- 3. `robot_touch`: every message the robot decided to send, or would have in a dry run — whom, which playbook, about
--    what, which attempt, the one channel outside the app, the words, how its delivery went and whether the person then
--    did the thing (`acted_at`). The robot's memory of whom it told what; nothing in it moves money.
-- 4. `robot_case`: a question the robot could not answer, passed to a person at INRP2P, and the person's answer.
-- 5. `robot_exchange`: the questions people asked the robot and what it answered — for its memory, the desk's view of
--    what people ask, and the model's daily cap. Kept 90 days.
-- 6. The inbox says: a note from the robot, the desk's answer to a question.
--
-- 0001–0056 are not edited.


-- 1. What the robot may do -------------------------------------------------------------------------------------------

CREATE TABLE robot_policy (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  outreach        text NOT NULL CHECK (outreach IN ('OFF', 'DRY_RUN', 'ON')),
  answers         text NOT NULL CHECK (answers IN ('RULES', 'AI')),
  -- Hours in India (IST) between which nothing is sent outside the app; equal hours mean no quiet hours.
  quiet_from      smallint NOT NULL CHECK (quiet_from BETWEEN 0 AND 23),
  quiet_to        smallint NOT NULL CHECK (quiet_to BETWEEN 0 AND 23),
  ai_daily_limit  integer NOT NULL CHECK (ai_daily_limit BETWEEN 0 AND 10000),
  playbooks_off   text[] NOT NULL DEFAULT '{}' CHECK (cardinality(playbooks_off) <= 50),
  reason          text CHECK (length(reason) <= 500),
  set_by          text NOT NULL,
  set_at          timestamptz NOT NULL DEFAULT inrp2p_now()
);
CREATE INDEX robot_policy_set_idx ON robot_policy (set_at DESC, id DESC);
CREATE TRIGGER robot_policy_no_update BEFORE UPDATE OR DELETE OR TRUNCATE ON robot_policy
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();
INSERT INTO robot_policy (outreach, answers, quiet_from, quiet_to, ai_daily_limit, reason, set_by)
VALUES ('DRY_RUN', 'RULES', 22, 9, 300, 'decides and records, sends nothing until a person switches it on', 'MIGRATION:0057');


-- 2. Each person's consent -------------------------------------------------------------------------------------------

CREATE TABLE robot_preference (
  user_id     uuid PRIMARY KEY REFERENCES auth_user (id),
  outreach    text NOT NULL DEFAULT 'SERVICE' CHECK (outreach IN ('ALL', 'SERVICE', 'NONE')),
  -- A playbook the person said "not now" to, and until when: `{ "set_prices": "2026-12-01T00:00:00Z" }`.
  snoozed     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(snoozed) = 'object'),
  -- The robot's news the person last opened, so it is marked new only when it is.
  seen_key    text CHECK (length(seen_key) <= 80),
  seen_at     timestamptz,
  set_via     text CHECK (set_via IN ('APP', 'TELEGRAM', 'EMAIL')),
  updated_at  timestamptz NOT NULL DEFAULT inrp2p_now()
);


-- 3. Whom the robot told what ----------------------------------------------------------------------------------------

CREATE TABLE robot_touch (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id            uuid NOT NULL REFERENCES auth_user (id),
  client_id          uuid REFERENCES client (id),
  playbook           text NOT NULL CHECK (playbook ~ '^[a-z_]{3,40}$'),
  subject            text NOT NULL CHECK (length(subject) BETWEEN 1 AND 80),
  attempt            smallint NOT NULL CHECK (attempt BETWEEN 1 AND 10),
  mode               text NOT NULL CHECK (mode IN ('LIVE', 'DRY_RUN')),
  -- The one channel outside the app; null: the inbox alone.
  channel            text CHECK (channel IN ('TELEGRAM', 'PUSH', 'EMAIL')),
  title              text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  -- As long as an inbox note may be: the inbox carries the same words.
  body               text NOT NULL CHECK (length(body) BETWEEN 1 AND 400),
  href               text CHECK (length(href) <= 300),
  -- The opt-out link of an email (the token's SHA-256, hex); the token itself is only ever in the email.
  quiet_token_hash   text CHECK (quiet_token_hash ~ '^[0-9a-f]{64}$'),
  delivery           text NOT NULL DEFAULT 'NONE' CHECK (delivery IN ('NONE', 'PENDING', 'SENT', 'FAILED')),
  delivery_attempts  smallint NOT NULL DEFAULT 0 CHECK (delivery_attempts BETWEEN 0 AND 50),
  delivery_ref       text CHECK (length(delivery_ref) <= 200),
  delivery_error     text CHECK (length(delivery_error) <= 80),
  created_at         timestamptz NOT NULL DEFAULT inrp2p_now(),
  delivered_at       timestamptz,
  acted_at           timestamptz,
  UNIQUE (user_id, playbook, subject, mode, attempt),
  -- A dry run sends nothing; a live touch with no client has no inbox, so it needs a channel to reach anyone.
  CHECK (mode = 'LIVE' OR delivery = 'NONE'),
  CHECK (mode = 'DRY_RUN' OR client_id IS NOT NULL OR channel IS NOT NULL),
  CHECK ((delivery = 'SENT') = (delivered_at IS NOT NULL))
);
CREATE INDEX robot_touch_user_idx ON robot_touch (user_id, created_at DESC);
CREATE INDEX robot_touch_recent_idx ON robot_touch (created_at DESC);
CREATE INDEX robot_touch_open_idx ON robot_touch (created_at) WHERE acted_at IS NULL;


-- 4. A question for a person -----------------------------------------------------------------------------------------

CREATE SEQUENCE robot_case_ref_seq;
CREATE TABLE robot_case (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  ref               text NOT NULL UNIQUE DEFAULT ('RC-' || inrp2p_ref_number(nextval('robot_case_ref_seq'), 6)),
  user_id           uuid REFERENCES auth_user (id),
  client_id         uuid REFERENCES client (id),
  channel           text NOT NULL CHECK (channel IN ('APP', 'TELEGRAM')),
  -- Where a question asked on Telegram is answered (a private chat's id is its person's Telegram id).
  telegram_chat_id  bigint,
  question          text NOT NULL CHECK (length(question) BETWEEN 1 AND 2000),
  -- What the robot knew when it passed the question on: the person's stage, open request and deals, in words.
  context           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context) = 'object'),
  status            text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ANSWERED', 'CLOSED')),
  answer            text CHECK (length(answer) BETWEEN 1 AND 2000),
  answered_by       text,
  answered_at       timestamptz,
  closed_at         timestamptz,
  -- When the answer reached the asker outside the inbox (Telegram or email), so a redelivered event never sends it twice.
  reply_sent_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT inrp2p_now(),
  updated_at        timestamptz NOT NULL DEFAULT inrp2p_now(),
  CHECK (user_id IS NOT NULL OR telegram_chat_id IS NOT NULL),
  CHECK ((status = 'ANSWERED') = (answer IS NOT NULL AND answered_by IS NOT NULL AND answered_at IS NOT NULL)),
  CHECK ((status = 'OPEN') = (closed_at IS NULL))
);
-- One open question per person: a second one joins it.
CREATE UNIQUE INDEX robot_case_one_open ON robot_case (user_id) WHERE status = 'OPEN' AND user_id IS NOT NULL;
CREATE INDEX robot_case_open_idx ON robot_case (created_at) WHERE status = 'OPEN';


-- 5. What people asked -----------------------------------------------------------------------------------------------

CREATE TABLE robot_exchange (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  -- Null for a Telegram chat nobody linked: its questions are counted, never tied to a person.
  user_id     uuid REFERENCES auth_user (id),
  channel     text NOT NULL CHECK (channel IN ('APP', 'TELEGRAM')),
  intent      text NOT NULL CHECK (intent ~ '^[A-Z_]{2,30}$'),
  source      text NOT NULL CHECK (source IN ('RULE', 'AI', 'CASE')),
  question    text NOT NULL CHECK (length(question) BETWEEN 1 AND 1000),
  answer      text NOT NULL CHECK (length(answer) BETWEEN 1 AND 2000),
  case_id     uuid REFERENCES robot_case (id),
  created_at  timestamptz NOT NULL DEFAULT inrp2p_now()
);
CREATE INDEX robot_exchange_user_idx ON robot_exchange (user_id, created_at DESC);
CREATE INDEX robot_exchange_day_idx ON robot_exchange (created_at DESC);


-- 6. What the inbox says ---------------------------------------------------------------------------------------------

ALTER TABLE client_notification DROP CONSTRAINT client_notification_kind_check;
ALTER TABLE client_notification ADD CONSTRAINT client_notification_kind_check CHECK (kind IN (
  'QUOTE_SENT', 'QUOTE_EXPIRED', 'REQUEST_DECLINED', 'TRADE_OPENED', 'PAYOUT_CONFIRMED', 'TRADE_COMPLETED', 'TRADE_CANCELLED',
  'DESTINATION_ADDED', 'DESTINATION_ARCHIVED', 'TRADE_DESTINATION_CHANGED',
  'TRADER_APPROVED', 'TRADER_REJECTED', 'TRADER_PAUSED', 'TRADER_RESUMED', 'TRADER_ORDER_NEW', 'TRADER_ORDER_ACCEPTED',
  'TRADER_ACTION_REQUIRED', 'TRADER_PAYMENT_CONFIRMED', 'TRADER_ORDER_COMPLETED', 'TRADER_ORDER_CLOSED', 'TRADER_RESERVE_ISSUE',
  'PAYMENT_RETURNED', 'TEAM_CHANGED', 'P2P_DISPUTE_OPENED', 'P2P_DISPUTE_DECIDED', 'P2P_REFUND', 'DESK_NOTICE',
  'DEAL_MESSAGE', 'P2P_PAY_FINAL', 'P2P_RECEIPT_LATE', 'TRADER_SETTLEMENT_CHANGE', 'TRADER_PRICE_REQUEST',
  'P2P_PAY_NOW', 'P2P_PAYMENT_SENT', 'TRADER_SIDE_EMPTY', 'DESTINATION_REJECTED', 'DESTINATION_PAUSED',
  'WAITING_PRICE_READY', 'WAITING_ENDED', 'TRADER_CLIENTS_WAITING',
  'PEER_MATCH_OFFERED', 'PEER_MATCH_WAITING', 'PEER_MATCH_ENDED', 'PEER_NEARBY', 'WAITING_RESUMED', 'PEER_DEAL_STARTED',
  'ROBOT_NOTE', 'ROBOT_REPLY'));
-- The robot's one action is often a page with its terms filled in ("/exchange?again=RQ-…", "?direction=sell&amount=2000"):
-- a note's link may now carry a short query of plain characters. Still a path on the client's own host, never a URL.
ALTER TABLE client_notification DROP CONSTRAINT client_notification_href_check;
ALTER TABLE client_notification ADD CONSTRAINT client_notification_href_check
  CHECK (href ~ '^/[A-Za-z0-9/_\-]{0,120}(\?[A-Za-z0-9=&._%\-]{1,160})?$');


-- Grants -------------------------------------------------------------------------------------------------------------

GRANT SELECT, INSERT ON robot_policy, robot_preference, robot_touch, robot_case, robot_exchange TO inrp2p_app;
GRANT UPDATE (outreach, snoozed, seen_key, seen_at, set_via, updated_at) ON robot_preference TO inrp2p_app;
GRANT UPDATE (quiet_token_hash, delivery, delivery_attempts, delivery_ref, delivery_error, delivered_at, acted_at) ON robot_touch TO inrp2p_app;
GRANT UPDATE (channel, telegram_chat_id, question, context, status, answer, answered_by, answered_at, closed_at, reply_sent_at, updated_at) ON robot_case TO inrp2p_app;
-- Questions and answers are kept 90 days, then deleted by the robot's sweep.
GRANT DELETE ON robot_exchange TO inrp2p_app;
GRANT USAGE ON SEQUENCE robot_case_ref_seq TO inrp2p_app;
GRANT SELECT ON robot_policy, robot_touch, robot_case TO inrp2p_readonly;
GRANT SELECT (user_id, outreach, set_via, updated_at) ON robot_preference TO inrp2p_readonly;
GRANT SELECT (id, user_id, channel, intent, source, case_id, created_at) ON robot_exchange TO inrp2p_readonly;
