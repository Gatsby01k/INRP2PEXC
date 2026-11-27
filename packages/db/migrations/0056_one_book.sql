-- 0056 One book: clients meet clients, and nothing waiting is lost (2026-11-27, ADR 0033).
--
-- 1. `peer_policy`: whether waiting clients meet each other, INRP2P's fee on a meeting and its smallest deal (append-only,
--    set by a person; off until switched on).
-- 2. `trade_request`: the client's price is a bound (`no_price_reason = 'OUTSIDE_LIMIT'`); the wait's length is the
--    client's (`wait_hours`); a maker that stayed silent is paused (`peer_paused_at`); how often a held price lapsed
--    (`held_lapses`); when the client was last told of a price near its own (`peer_told_at`, `peer_told_rate_micro`); a
--    request whose client was the other side of a meeting closes MATCHED; a waiting client may move its own bound to meet
--    a price it was shown (`target_rate_micro`, by its own command, audited).
-- 3. `trader_profile.status = 'PERSONAL'`: the maker of a meeting is a client acting as the route of one deal — never part
--    of the trader programme, never approved, paused or reviewed.
-- 4. `quote.accepted_via = 'STANDING'`: a taker's yes, given before its maker started, accepts the quote made for it.
--    A peer deal's network is half the taker's line and half the maker's side (IX144 amended).
-- 5. `peer_match`: one meeting of two waiting requests — its price, its size, both yeses, and how it ended (IX148).
-- 6. `peer_strike`: a maker that stayed silent, a peer deal undone for its client's missed step.
-- 7. `push_subscription`, `push_delivery`: Web Push, the client's instant channel beside Telegram.
-- 8. The inbox says: a meeting to start, a meeting waiting for the other side, a meeting ended, a price near yours, a
--    held price that lapsed while the search goes on, a deal started for its maker.
--
-- Error code IX148 belongs to this migration. 0001–0055 are not edited.


-- 1. Whether clients meet ---------------------------------------------------------------------------------------------

CREATE TABLE peer_policy (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  enabled              boolean NOT NULL,
  fee_bps              integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 100),
  min_deal_usdt_minor  bigint NOT NULL CHECK (min_deal_usdt_minor BETWEEN 1000000 AND 100000000000),
  set_by               text NOT NULL,
  set_at               timestamptz NOT NULL DEFAULT inrp2p_now()
);
CREATE INDEX peer_policy_set_idx ON peer_policy (set_at DESC, id DESC);
CREATE TRIGGER peer_policy_no_update BEFORE UPDATE OR DELETE OR TRUNCATE ON peer_policy
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();
INSERT INTO peer_policy (enabled, fee_bps, min_deal_usdt_minor, set_by) VALUES (false, 25, 50000000, 'MIGRATION:0056');


-- 2. The request ------------------------------------------------------------------------------------------------------

ALTER TABLE trade_request
  ADD COLUMN wait_hours smallint CHECK (wait_hours IN (1, 24, 72, 168)),
  ADD COLUMN peer_paused_at timestamptz,
  ADD COLUMN held_lapses smallint NOT NULL DEFAULT 0 CHECK (held_lapses BETWEEN 0 AND 100),
  ADD COLUMN peer_told_at timestamptz,
  ADD COLUMN peer_told_rate_micro bigint CHECK (peer_told_rate_micro > 0),
  ADD CONSTRAINT trade_request_peer_told CHECK ((peer_told_at IS NULL) = (peer_told_rate_micro IS NULL));

ALTER TABLE trade_request DROP CONSTRAINT trade_request_status_check;
ALTER TABLE trade_request ADD CONSTRAINT trade_request_status_check CHECK (status IN ('OPEN', 'QUOTED', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED', 'MATCHED'));
-- A closed request has its closing time — MATCHED is closed too (0013's unnamed check, found by what it says).
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'trade_request'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) LIKE '%closed_at IS NOT NULL%' AND pg_get_constraintdef(oid) LIKE '%ACCEPTED%' LOOP
    EXECUTE format('ALTER TABLE trade_request DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;
ALTER TABLE trade_request ADD CONSTRAINT trade_request_closed_at CHECK ((status IN ('ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED', 'MATCHED')) = (closed_at IS NOT NULL));
DROP TRIGGER trade_request_status ON trade_request;
CREATE TRIGGER trade_request_status BEFORE UPDATE ON trade_request
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status',
    'OPEN>QUOTED,QUOTED>OPEN,QUOTED>ACCEPTED,OPEN>DECLINED,QUOTED>DECLINED,OPEN>WITHDRAWN,QUOTED>WITHDRAWN,OPEN>EXPIRED,OPEN>MATCHED');

ALTER TABLE trade_request DROP CONSTRAINT trade_request_no_price_reason_check;
ALTER TABLE trade_request ADD CONSTRAINT trade_request_no_price_reason_check CHECK (
  no_price_reason IN ('NO_MARKET', 'NETWORK_UNKNOWN', 'NO_OFFER', 'NOT_COMPETITIVE', 'NO_BID', 'OUTSIDE_LIMIT'));

DROP TRIGGER trade_request_immutable ON trade_request;
CREATE TRIGGER trade_request_immutable BEFORE UPDATE ON trade_request
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns(
    'status', 'status_reason', 'assigned_dealer_id', 'last_activity_at', 'closed_at', 'version', 'no_price_reason', 'waiting_since', 'waiting_until',
    'wait_hours', 'peer_paused_at', 'held_lapses', 'peer_told_at', 'peer_told_rate_micro', 'target_rate_micro');


-- 3. A client as the route of one deal --------------------------------------------------------------------------------

ALTER TABLE trader_profile DROP CONSTRAINT trader_profile_status_check;
ALTER TABLE trader_profile ADD CONSTRAINT trader_profile_status_check CHECK (status IN ('UNDER_REVIEW', 'APPROVED', 'REJECTED', 'PAUSED', 'PERSONAL'));
-- A personal profile is written as one and stays one: it is never reviewed, approved or paused, never available to the
-- programme, never holds a reserve, and nothing becomes one (the status transition guard lists no move into it).
ALTER TABLE trader_profile ADD CONSTRAINT trader_profile_personal_shape CHECK (
  status <> 'PERSONAL' OR (NOT available AND required_reserve_minor IS NULL AND reviewed_at IS NULL AND approved_at IS NULL));
-- The one way out of PERSONAL: its client applies to the programme (and is reviewed as anyone is).
DROP TRIGGER trader_profile_status ON trader_profile;
CREATE TRIGGER trader_profile_status BEFORE UPDATE ON trader_profile
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'UNDER_REVIEW>APPROVED,UNDER_REVIEW>REJECTED,REJECTED>UNDER_REVIEW,APPROVED>PAUSED,PAUSED>APPROVED,PERSONAL>UNDER_REVIEW');

-- A personal side's wallet is never a reserve sender: only a trader of the programme keeps a Security Reserve.
CREATE OR REPLACE FUNCTION inrp2p_reserve_sender_trader(p_from text, p_at timestamptz) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN count(*) = 1 THEN min(t.id::text)::uuid END
  FROM trader_profile t
  JOIN crypto_wallet w ON w.id = t.wallet_id
  WHERE t.status <> 'PERSONAL'
    AND w.network = 'TRON'
    AND w.address = p_from
    AND w.status IN ('ACTIVE', 'PENDING_REVIEW')
    AND w.created_at <= p_at
$$;


-- 4. The taker's standing yes, and a peer deal's network -------------------------------------------------------------

ALTER TABLE quote DROP CONSTRAINT quote_accepted_via_check;
ALTER TABLE quote ADD CONSTRAINT quote_accepted_via_check CHECK (accepted_via IN ('APP', 'LINK', 'STANDING'));

ALTER TABLE quote DROP CONSTRAINT quote_client_network_shape;
ALTER TABLE quote ADD CONSTRAINT quote_client_network_shape CHECK (client_network_base_minor IS NULL OR client_network_base_minor <= network_fee_base_minor);
ALTER TABLE trade_economics DROP CONSTRAINT trade_economics_client_network_shape;
ALTER TABLE trade_economics ADD CONSTRAINT trade_economics_client_network_shape CHECK (client_network_base_minor IS NULL OR client_network_base_minor <= network_fee_base_minor);

-- IX144 (FI-100, amended by ADR 0033): INRP2P's own deal priced in USDT carries its network as the client's line, the whole
-- of it — except a meeting of two clients, where the taker pays half (rounded down) and the maker's side carries the rest;
-- a desk's deal never does.
CREATE OR REPLACE FUNCTION inrp2p_guard_quote_client_network() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  req_desk uuid;
  personal boolean;
BEGIN
  SELECT desk_id INTO req_desk FROM trade_request WHERE id = NEW.trade_request_id;
  IF req_desk IS NOT NULL AND NEW.client_network_base_minor IS NOT NULL THEN
    RAISE EXCEPTION 'quote % is a desk''s deal: the desk''s side carries its network, the client pays none', NEW.ref USING ERRCODE = 'IX144';
  END IF;
  SELECT t.status = 'PERSONAL' INTO personal FROM liquidity_route r JOIN trader_profile t ON t.id = r.trader_id WHERE r.id = NEW.route_id;
  IF req_desk IS NULL AND coalesce(personal, false) THEN
    IF NEW.network_fee_base_minor IS NULL OR NEW.client_network_base_minor IS DISTINCT FROM NEW.network_fee_base_minor / 2 THEN
      RAISE EXCEPTION 'quote % is a meeting of two clients: its taker pays half the network it carries', NEW.ref USING ERRCODE = 'IX144';
    END IF;
  ELSIF req_desk IS NULL AND NEW.client_network_base_minor IS DISTINCT FROM NEW.network_fee_base_minor THEN
    RAISE EXCEPTION 'quote % is INRP2P''s own deal: its client pays the network it carries, the whole of it', NEW.ref USING ERRCODE = 'IX144';
  END IF;
  RETURN NEW;
END
$$;


-- 5. A meeting --------------------------------------------------------------------------------------------------------

CREATE SEQUENCE peer_match_ref_seq;
CREATE TABLE peer_match (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  ref                     text NOT NULL UNIQUE DEFAULT ('PM-' || inrp2p_ref_number(nextval('peer_match_ref_seq'), 6)),
  policy_id               uuid NOT NULL REFERENCES peer_policy (id),
  taker_request_id        uuid NOT NULL REFERENCES trade_request (id),
  maker_request_id        uuid NOT NULL REFERENCES trade_request (id),
  taker_client_id         uuid NOT NULL REFERENCES client (id),
  maker_client_id         uuid NOT NULL REFERENCES client (id),
  maker_trader_id         uuid NOT NULL REFERENCES trader_profile (id),
  -- The taker's direction; the maker's request is the other one.
  direction               text NOT NULL CHECK (direction IN ('SELL_USDT', 'BUY_USDT')),
  fixed_side              text NOT NULL CHECK (fixed_side IN ('BASE', 'QUOTE')),
  amount_minor            bigint NOT NULL CHECK (amount_minor > 0),
  taker_rate_micro        bigint NOT NULL CHECK (taker_rate_micro > 0),
  maker_rate_micro        bigint NOT NULL CHECK (maker_rate_micro > 0),
  reference_mid_micro     bigint CHECK (reference_mid_micro > 0),
  fee_bps                 integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 100),
  -- What the economics came to when the taker said yes: its USDT, the rupees, the maker's USDT, the allowance.
  base_minor              bigint NOT NULL CHECK (base_minor > 0),
  inr_minor               bigint NOT NULL CHECK (inr_minor > 0),
  route_base_minor        bigint NOT NULL CHECK (route_base_minor > 0),
  network_allowance_minor bigint NOT NULL CHECK (network_allowance_minor >= 0),
  status                  text NOT NULL DEFAULT 'WAITING_MAKER' CHECK (status IN ('WAITING_MAKER', 'STARTED', 'ENDED')),
  taker_yes_by            uuid NOT NULL REFERENCES auth_user (id),
  taker_yes_at            timestamptz NOT NULL DEFAULT inrp2p_now(),
  taker_yes_until         timestamptz NOT NULL,
  maker_yes_by            uuid REFERENCES auth_user (id),
  maker_yes_at            timestamptz,
  order_id                uuid REFERENCES trader_order (id),
  quote_id                uuid REFERENCES quote (id),
  trade_id                uuid REFERENCES trade (id),
  end_reason              text CHECK (end_reason IN ('MAKER_DECLINED', 'MAKER_SILENT', 'TAKER_WITHDREW', 'MAKER_WITHDREW', 'BETTER_PRICE', 'TERMS_CHANGED', 'TAKER_SILENT', 'CLOSED')),
  ended_at                timestamptz,
  created_at              timestamptz NOT NULL DEFAULT inrp2p_now(),
  CHECK (taker_request_id <> maker_request_id AND taker_client_id <> maker_client_id),
  CHECK (taker_yes_until > taker_yes_at),
  -- The margin is never negative: a taker buying pays at least what its maker sells at, a taker selling gets at most what its maker buys at.
  CHECK (CASE WHEN direction = 'BUY_USDT' THEN taker_rate_micro >= maker_rate_micro ELSE taker_rate_micro <= maker_rate_micro END),
  CHECK ((status = 'WAITING_MAKER') = (ended_at IS NULL AND trade_id IS NULL)),
  CHECK ((status = 'STARTED') = (trade_id IS NOT NULL AND quote_id IS NOT NULL AND maker_yes_at IS NOT NULL AND maker_yes_by IS NOT NULL)),
  CHECK ((status = 'ENDED') = (end_reason IS NOT NULL AND ended_at IS NOT NULL)),
  CHECK ((maker_yes_at IS NULL) = (maker_yes_by IS NULL))
);
CREATE UNIQUE INDEX peer_match_live_taker ON peer_match (taker_request_id) WHERE status = 'WAITING_MAKER';
CREATE UNIQUE INDEX peer_match_live_maker ON peer_match (maker_request_id) WHERE status = 'WAITING_MAKER';
CREATE UNIQUE INDEX peer_match_order ON peer_match (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX peer_match_clients ON peer_match (maker_client_id, created_at DESC);
CREATE INDEX peer_match_taker_clients ON peer_match (taker_client_id, created_at DESC);
CREATE INDEX peer_match_due ON peer_match (taker_yes_until) WHERE status = 'WAITING_MAKER';
CREATE TRIGGER peer_match_no_delete BEFORE DELETE OR TRUNCATE ON peer_match
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();
CREATE TRIGGER peer_match_status BEFORE UPDATE ON peer_match
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'WAITING_MAKER>STARTED,WAITING_MAKER>ENDED');
CREATE TRIGGER peer_match_immutable BEFORE UPDATE ON peer_match
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'maker_yes_by', 'maker_yes_at', 'order_id', 'quote_id', 'trade_id', 'end_reason', 'ended_at');

-- IX148 (FI-116): a meeting joins two open requests of the INRP2P exchange from opposite sides and two clients; its rates
-- keep inside both clients' bounds; the gap between them is INRP2P's fee and no more (a paisa each side of rounding);
-- its maker is that client's own personal profile; when it starts, its order, quote and trade are this meeting's.
CREATE FUNCTION inrp2p_guard_peer_match() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t trade_request%ROWTYPE;
  m trade_request%ROWTYPE;
  gap bigint;
  allowed bigint;
  o trader_order%ROWTYPE;
  q quote%ROWTYPE;
BEGIN
  SELECT * INTO t FROM trade_request WHERE id = NEW.taker_request_id;
  SELECT * INTO m FROM trade_request WHERE id = NEW.maker_request_id;
  IF TG_OP = 'INSERT' THEN
    IF t.status <> 'OPEN' OR m.status <> 'OPEN' OR t.desk_id IS NOT NULL OR m.desk_id IS NOT NULL OR m.waiting_until IS NULL
       OR t.client_id <> NEW.taker_client_id OR m.client_id <> NEW.maker_client_id
       OR t.direction <> NEW.direction OR m.direction = NEW.direction OR t.fixed_side <> NEW.fixed_side THEN
      RAISE EXCEPTION 'meeting % joins two open INRP2P requests of two clients, from opposite sides', NEW.ref USING ERRCODE = 'IX148';
    END IF;
    IF (SELECT client_id FROM trader_profile WHERE id = NEW.maker_trader_id AND status = 'PERSONAL') IS DISTINCT FROM NEW.maker_client_id THEN
      RAISE EXCEPTION 'meeting % has its maker''s own personal side as its route', NEW.ref USING ERRCODE = 'IX148';
    END IF;
    -- The bounds: a taker buying pays no more than its own, a maker selling gets no less than its own; and the other way round.
    IF NEW.direction = 'BUY_USDT' THEN
      IF (t.target_rate_micro IS NOT NULL AND NEW.taker_rate_micro > t.target_rate_micro) OR (m.target_rate_micro IS NOT NULL AND NEW.maker_rate_micro < m.target_rate_micro) THEN
        RAISE EXCEPTION 'meeting % prices outside a client''s own bound', NEW.ref USING ERRCODE = 'IX148';
      END IF;
      gap := NEW.taker_rate_micro - NEW.maker_rate_micro;
    ELSE
      IF (t.target_rate_micro IS NOT NULL AND NEW.taker_rate_micro < t.target_rate_micro) OR (m.target_rate_micro IS NOT NULL AND NEW.maker_rate_micro > m.target_rate_micro) THEN
        RAISE EXCEPTION 'meeting % prices outside a client''s own bound', NEW.ref USING ERRCODE = 'IX148';
      END IF;
      gap := NEW.maker_rate_micro - NEW.taker_rate_micro;
    END IF;
    allowed := (greatest(NEW.taker_rate_micro, NEW.maker_rate_micro) * NEW.fee_bps + 9999) / 10000 + 20000;
    IF gap > allowed OR NEW.fee_bps <> (SELECT fee_bps FROM peer_policy WHERE id = NEW.policy_id) THEN
      RAISE EXCEPTION 'meeting % keeps more than INRP2P''s fee between its two rates', NEW.ref USING ERRCODE = 'IX148';
    END IF;
  ELSIF NEW.status = 'STARTED' AND OLD.status = 'WAITING_MAKER' THEN
    SELECT * INTO o FROM trader_order WHERE id = NEW.order_id;
    SELECT * INTO q FROM quote WHERE id = NEW.quote_id;
    IF o.trader_id <> NEW.maker_trader_id OR o.trade_request_id <> NEW.taker_request_id OR o.trade_id IS DISTINCT FROM NEW.trade_id
       OR q.trade_request_id <> NEW.taker_request_id OR q.status <> 'ACCEPTED' OR q.client_rate_micro <> NEW.taker_rate_micro OR o.rate_micro <> NEW.maker_rate_micro
       OR (SELECT quote_id FROM trade WHERE id = NEW.trade_id) <> NEW.quote_id THEN
      RAISE EXCEPTION 'meeting % starts only as its own order, quote and trade', NEW.ref USING ERRCODE = 'IX148';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER peer_match_guard BEFORE INSERT OR UPDATE ON peer_match
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_peer_match();

-- IX148: a quote accepted on a standing yes is a meeting's, accepted by the user who said that yes, inside its hour.
CREATE FUNCTION inrp2p_guard_quote_standing() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.accepted_via = 'STANDING' AND OLD.status IS DISTINCT FROM 'ACCEPTED' THEN
    IF NOT EXISTS (
      SELECT 1 FROM peer_match pm
       WHERE pm.taker_request_id = NEW.trade_request_id AND pm.status = 'WAITING_MAKER'
         AND pm.taker_yes_by = NEW.accepted_by_user_id AND pm.taker_rate_micro = NEW.client_rate_micro
         AND pm.taker_yes_until > NEW.accepted_at) THEN
      RAISE EXCEPTION 'quote % is accepted on a standing yes only by the meeting it was given for', NEW.ref USING ERRCODE = 'IX148';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER quote_standing BEFORE UPDATE OF status ON quote
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_quote_standing();


-- 6. Strikes ----------------------------------------------------------------------------------------------------------

CREATE TABLE peer_strike (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  client_id      uuid NOT NULL REFERENCES client (id),
  kind           text NOT NULL CHECK (kind IN ('MAKER_SILENT', 'DEAL_FAILED')),
  peer_match_id  uuid NOT NULL REFERENCES peer_match (id),
  trade_id       uuid REFERENCES trade (id),
  created_at     timestamptz NOT NULL DEFAULT inrp2p_now(),
  UNIQUE (peer_match_id, client_id, kind)
);
CREATE INDEX peer_strike_client_idx ON peer_strike (client_id, created_at DESC);
CREATE TRIGGER peer_strike_no_change BEFORE UPDATE OR DELETE OR TRUNCATE ON peer_strike
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();


-- 7. Web Push ---------------------------------------------------------------------------------------------------------

CREATE TABLE push_subscription (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  client_user_id   uuid NOT NULL REFERENCES client_user (id),
  endpoint         text NOT NULL UNIQUE CHECK (endpoint ~ '^https://' AND length(endpoint) <= 1000),
  p256dh           text NOT NULL CHECK (length(p256dh) BETWEEN 80 AND 100),
  auth             text NOT NULL CHECK (length(auth) BETWEEN 16 AND 30),
  user_agent       text CHECK (length(user_agent) <= 200),
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  failures         integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  last_sent_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT inrp2p_now(),
  revoked_at       timestamptz,
  revoke_reason    text CHECK (length(revoke_reason) <= 200),
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);
CREATE INDEX push_subscription_user_idx ON push_subscription (client_user_id) WHERE status = 'ACTIVE';

CREATE TABLE push_delivery (
  id                    uuid PRIMARY KEY,
  push_subscription_id  uuid NOT NULL REFERENCES push_subscription (id),
  dedupe_key            text NOT NULL CHECK (length(dedupe_key) <= 200),
  title                 text NOT NULL CHECK (length(title) <= 120),
  body                  text NOT NULL CHECK (length(body) <= 400),
  url                   text CHECK (length(url) <= 500),
  status                text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  attempts              integer NOT NULL DEFAULT 0,
  last_error            text CHECK (length(last_error) <= 300),
  created_at            timestamptz NOT NULL DEFAULT inrp2p_now(),
  sent_at               timestamptz,
  UNIQUE (push_subscription_id, dedupe_key)
);


-- 8. What the inbox says ---------------------------------------------------------------------------------------------

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
  'PEER_MATCH_OFFERED', 'PEER_MATCH_WAITING', 'PEER_MATCH_ENDED', 'PEER_NEARBY', 'WAITING_RESUMED', 'PEER_DEAL_STARTED'));


-- Grants -------------------------------------------------------------------------------------------------------------

GRANT SELECT, INSERT ON peer_policy, peer_match, peer_strike, push_subscription, push_delivery TO inrp2p_app;
GRANT UPDATE (status, maker_yes_by, maker_yes_at, order_id, quote_id, trade_id, end_reason, ended_at) ON peer_match TO inrp2p_app;
GRANT UPDATE (client_user_id, p256dh, auth, user_agent, status, failures, last_sent_at, revoked_at, revoke_reason) ON push_subscription TO inrp2p_app;
GRANT UPDATE (status, attempts, last_error, sent_at) ON push_delivery TO inrp2p_app;
GRANT UPDATE (wait_hours, peer_paused_at, held_lapses, peer_told_at, peer_told_rate_micro, target_rate_micro) ON trade_request TO inrp2p_app;
GRANT USAGE ON SEQUENCE peer_match_ref_seq TO inrp2p_app;
GRANT SELECT ON peer_policy, peer_match, peer_strike TO inrp2p_readonly;
GRANT SELECT (id, client_user_id, status, failures, last_sent_at, created_at, revoked_at) ON push_subscription TO inrp2p_readonly;
GRANT SELECT (wait_hours, peer_paused_at, held_lapses, peer_told_at, peer_told_rate_micro) ON trade_request TO inrp2p_readonly;
