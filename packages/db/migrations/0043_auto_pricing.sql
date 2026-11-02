-- 0043 Automatic pricing of the INRP2P exchange (docs/adr/0025-automatic-pricing.md).
--
-- A client of the INRP2P exchange types an amount and sees a firm price at once; accepting it starts the deal with the
-- trader the system chose. Nobody at INRP2P sets the rate. The deal runs P2P exactly as before (ADR 0019): rupees straight
-- between the client and the trader, USDT through the deal's own escrow, INRP2P's margin the USDT left there.
--
-- 1. `pricing_policy`: whether prices are automatic, and the guard-rails of the choice — how fresh the market reference
--    must be, how far past it a client's price may go, and the price requests (RFQ) for amounts no firm offer covers.
--    Append-only: the latest row is the policy. The first row leaves everything off.
-- 2. `trader_block.instant_until`, `instant_set_by`, `rails`: a trader's firm offer — until when INRP2P may fill orders at
--    its rate, within its limits, without asking it each time; whose commitment that is; the INR rails it is paid or pays
--    by. An offer whose time has passed is not firm any more.
-- 3. `auto_quote`: the decision behind each automatic quote — the market reference it was bounded by, where the price sat
--    against it, the offers it chose among, what it expected and what it leaves. Written once with the quote, never
--    changed; it is also what later prices learn from (IX137).
-- 4. `rfq`, `rfq_invite`, `rfq_bid`: a price request to several traders for one client's request, a bid per trader, the
--    best one awarded. The client never sees who was asked (IX138, IX139).
-- 5. `trader_block` firm window (IX140): a firm offer starts in the future and lasts at most seven days, and only a trader's
--    member commits it.
-- 6. Inbox kind `TRADER_PRICE_REQUEST`.
-- Error codes IX137–IX140 belong to this migration.

-- 1. The pricing policy ------------------------------------------------------------------------------------------------

CREATE TABLE pricing_policy (
  id                        uuid PRIMARY KEY DEFAULT uuidv7(),
  -- Clients of the INRP2P exchange get a firm price at once; off, every request waits for a person, as before.
  auto_quote                boolean NOT NULL,
  -- An amount no firm offer covers is put to several traders as a price request; off, it waits for a person.
  rfq                       boolean NOT NULL,
  -- The market reference a price is bounded by must be at most this old; older, nothing is priced automatically.
  reference_max_age_seconds integer NOT NULL CHECK (reference_max_age_seconds BETWEEN 60 AND 3600),
  -- How far past the market reference a client's price may go, in basis points of the reference: 0 is never worse.
  max_premium_bps           integer NOT NULL CHECK (max_premium_bps BETWEEN 0 AND 500),
  -- The width of the price bands acceptance is counted in, and how far back it is counted.
  bin_bps                   integer NOT NULL CHECK (bin_bps BETWEEN 1 AND 100),
  learning_days             integer NOT NULL CHECK (learning_days BETWEEN 1 AND 365),
  rfq_window_seconds        integer NOT NULL CHECK (rfq_window_seconds BETWEEN 30 AND 900),
  rfq_max_traders           integer NOT NULL CHECK (rfq_max_traders BETWEEN 1 AND 20),
  reason                    text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  set_by                    text NOT NULL,
  set_at                    timestamptz NOT NULL DEFAULT inrp2p_now()
);
CREATE INDEX pricing_policy_current_idx ON pricing_policy (set_at DESC, id DESC);
CREATE TRIGGER pricing_policy_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON pricing_policy
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();
INSERT INTO pricing_policy (auto_quote, rfq, reference_max_age_seconds, max_premium_bps, bin_bps, learning_days, rfq_window_seconds, rfq_max_traders, reason, set_by)
VALUES (false, false, 900, 0, 10, 30, 120, 5, 'automatic pricing stays off until a person switches it on', 'migration 0043');

-- 2. A trader's firm offer -------------------------------------------------------------------------------------------

ALTER TABLE trader_block
  ADD COLUMN instant_until  timestamptz,
  ADD COLUMN instant_set_by uuid REFERENCES auth_user (id),
  ADD COLUMN rails          text[] NOT NULL DEFAULT ARRAY['UPI', 'IMPS', 'NEFT', 'RTGS'],
  ADD CONSTRAINT trader_block_instant_owner CHECK ((instant_until IS NULL) = (instant_set_by IS NULL)),
  ADD CONSTRAINT trader_block_rails CHECK (cardinality(rails) BETWEEN 1 AND 4 AND rails <@ ARRAY['UPI', 'IMPS', 'NEFT', 'RTGS']);
DROP TRIGGER trader_block_immutable ON trader_block;
CREATE TRIGGER trader_block_immutable BEFORE UPDATE ON trader_block
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns(
    'capacity_minor', 'reserved_minor', 'rate_micro', 'min_order_minor', 'max_order_minor', 'status', 'updated_at', 'version', 'instant_until', 'instant_set_by', 'rails');

-- IX140: a firm offer is committed by the trader's own member, starts in the future and lasts at most seven days.
CREATE FUNCTION inrp2p_guard_trader_block_instant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.instant_until IS NOT NULL AND (NEW.instant_until IS DISTINCT FROM OLD.instant_until OR NEW.instant_set_by IS DISTINCT FROM OLD.instant_set_by) THEN
    IF NEW.instant_until <= inrp2p_now() OR NEW.instant_until > inrp2p_now() + interval '7 days' THEN
      RAISE EXCEPTION 'a firm offer lasts from now to at most seven days ahead' USING ERRCODE = 'IX140';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM trader_profile t JOIN client_user cu ON cu.client_id = t.client_id
      WHERE t.id = NEW.trader_id AND cu.user_id = NEW.instant_set_by AND cu.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'a firm offer is committed by a member of the trader' USING ERRCODE = 'IX140';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trader_block_instant BEFORE UPDATE OF instant_until, instant_set_by ON trader_block
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_trader_block_instant();

-- 4. Price requests to several traders (before `auto_quote`, which names the one that priced it) ----------------------

CREATE SEQUENCE rfq_ref_seq;
CREATE TABLE rfq (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  ref              text NOT NULL UNIQUE DEFAULT ('RFQ-' || inrp2p_ref_number(nextval('rfq_ref_seq'), 6)),
  trade_request_id uuid NOT NULL REFERENCES trade_request (id),
  policy_id        uuid NOT NULL REFERENCES pricing_policy (id),
  direction        text NOT NULL CHECK (direction IN ('SELL_USDT', 'BUY_USDT')),
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'AWARDED', 'NO_PRICE', 'CANCELLED')),
  opened_at        timestamptz NOT NULL DEFAULT inrp2p_now(),
  closes_at        timestamptz NOT NULL,
  closed_at        timestamptz,
  close_note       text CHECK (length(close_note) <= 300),
  CHECK (closes_at > opened_at),
  CHECK ((status = 'OPEN') = (closed_at IS NULL))
);
CREATE UNIQUE INDEX rfq_one_open ON rfq (trade_request_id) WHERE status = 'OPEN';
CREATE INDEX rfq_due_idx ON rfq (closes_at) WHERE status = 'OPEN';
CREATE TRIGGER rfq_status BEFORE UPDATE ON rfq
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'OPEN>AWARDED,OPEN>NO_PRICE,OPEN>CANCELLED');
CREATE TRIGGER rfq_immutable BEFORE UPDATE ON rfq
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'closed_at', 'close_note');
CREATE TRIGGER rfq_no_delete BEFORE DELETE OR TRUNCATE ON rfq
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- IX138: a price request is the INRP2P exchange's (never a desk's), for an open request of the same direction.
CREATE FUNCTION inrp2p_guard_rfq() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r trade_request%ROWTYPE;
BEGIN
  SELECT * INTO r FROM trade_request WHERE id = NEW.trade_request_id;
  IF r.desk_id IS NOT NULL OR r.status <> 'OPEN' OR r.direction <> NEW.direction THEN
    RAISE EXCEPTION 'a price request is for an open request of the INRP2P exchange, in its direction' USING ERRCODE = 'IX138';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER rfq_insert BEFORE INSERT ON rfq FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_rfq();

CREATE TABLE rfq_invite (
  rfq_id     uuid NOT NULL REFERENCES rfq (id),
  trader_id  uuid NOT NULL REFERENCES trader_profile (id),
  block_id   uuid NOT NULL REFERENCES trader_block (id),
  invited_at timestamptz NOT NULL DEFAULT inrp2p_now(),
  PRIMARY KEY (rfq_id, trader_id)
);
CREATE INDEX rfq_invite_trader_idx ON rfq_invite (trader_id, rfq_id);
CREATE TRIGGER rfq_invite_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON rfq_invite
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

CREATE TABLE rfq_bid (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  rfq_id     uuid NOT NULL,
  trader_id  uuid NOT NULL,
  -- The trader's rate for the whole amount (INR per USDT), firm until the request is awarded.
  rate_micro bigint NOT NULL CHECK (rate_micro > 0),
  placed_by  uuid NOT NULL REFERENCES auth_user (id),
  placed_at  timestamptz NOT NULL DEFAULT inrp2p_now(),
  status     text NOT NULL DEFAULT 'LIVE' CHECK (status IN ('LIVE', 'REPLACED', 'WON', 'LOST')),
  FOREIGN KEY (rfq_id, trader_id) REFERENCES rfq_invite (rfq_id, trader_id)
);
CREATE UNIQUE INDEX rfq_bid_one_live ON rfq_bid (rfq_id, trader_id) WHERE status = 'LIVE';
CREATE TRIGGER rfq_bid_status BEFORE UPDATE ON rfq_bid
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'LIVE>REPLACED,LIVE>WON,LIVE>LOST');
CREATE TRIGGER rfq_bid_immutable BEFORE UPDATE ON rfq_bid
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status');
CREATE TRIGGER rfq_bid_no_delete BEFORE DELETE OR TRUNCATE ON rfq_bid
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- IX139: a bid is placed by a member of the invited trader, while the request is open and before it closes (database
-- time) — never after, so a late price can never win.
CREATE FUNCTION inrp2p_guard_rfq_bid() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  q rfq%ROWTYPE;
BEGIN
  SELECT * INTO q FROM rfq WHERE id = NEW.rfq_id;
  IF q.status <> 'OPEN' OR inrp2p_now() >= q.closes_at THEN
    RAISE EXCEPTION 'price request % is closed', q.ref USING ERRCODE = 'IX139';
  END IF;
  IF NEW.status <> 'LIVE' THEN
    RAISE EXCEPTION 'a bid is placed live' USING ERRCODE = 'IX139';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM trader_profile t JOIN client_user cu ON cu.client_id = t.client_id
    WHERE t.id = NEW.trader_id AND cu.user_id = NEW.placed_by AND cu.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'a bid is placed by a member of the trader' USING ERRCODE = 'IX139';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER rfq_bid_insert BEFORE INSERT ON rfq_bid FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_rfq_bid();

-- 3. The decision behind an automatic quote --------------------------------------------------------------------------

CREATE TABLE auto_quote (
  quote_id                  uuid PRIMARY KEY REFERENCES quote (id),
  trade_request_id          uuid NOT NULL REFERENCES trade_request (id),
  trader_order_id           uuid NOT NULL UNIQUE REFERENCES trader_order (id),
  policy_id                 uuid NOT NULL REFERENCES pricing_policy (id),
  source                    text NOT NULL CHECK (source IN ('INSTANT', 'RFQ')),
  rfq_id                    uuid REFERENCES rfq (id),
  direction                 text NOT NULL CHECK (direction IN ('SELL_USDT', 'BUY_USDT')),
  -- The client's USDT by order of magnitude: under 1,000 · 10,000 · 100,000 · above. Acceptance is learned per band.
  size_band                 smallint NOT NULL CHECK (size_band BETWEEN 0 AND 3),
  reference_snapshot_id     uuid NOT NULL REFERENCES rate_snapshot (id),
  reference_rate_micro      bigint NOT NULL CHECK (reference_rate_micro > 0),
  -- Where the client's price sat against the reference, in basis points: positive is worse for the client.
  position_bps              integer NOT NULL,
  -- The worst price the client could have been given: the reference moved by at most the policy's premium.
  cap_rate_micro            bigint NOT NULL CHECK (cap_rate_micro > 0),
  offers                    integer NOT NULL CHECK (offers >= 1),
  -- The estimates the choice weighed, in parts per million: that the chosen trader completes, that the client accepts.
  completion_ppm            integer NOT NULL CHECK (completion_ppm BETWEEN 0 AND 1000000),
  acceptance_ppm            integer NOT NULL CHECK (acceptance_ppm BETWEEN 0 AND 1000000),
  net_margin_usdt_minor     bigint NOT NULL,
  min_net_margin_usdt_minor bigint NOT NULL CHECK (min_net_margin_usdt_minor >= 0),
  created_at                timestamptz NOT NULL DEFAULT inrp2p_now(),
  CHECK ((source = 'RFQ') = (rfq_id IS NOT NULL)),
  CHECK (net_margin_usdt_minor >= min_net_margin_usdt_minor)
);
CREATE INDEX auto_quote_learning_idx ON auto_quote (direction, created_at);
CREATE TRIGGER auto_quote_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON auto_quote
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- IX137: an automatic quote is a quote of the INRP2P exchange on a trader's P2P route, priced against the trader's accepted
-- order at its own rate and snapshot; what it leaves is its frozen network terms' net margin, at least the minimum and
-- never negative; its price is no worse for the client than the market reference moved by the policy's premium, and its
-- position against that reference is what the record says. It is written before the quote is sent, and only then.
CREATE FUNCTION inrp2p_guard_auto_quote() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  q  quote%ROWTYPE;
  o  trader_order%ROWTYPE;
  nf quote_network_fee%ROWTYPE;
  p  pricing_policy%ROWTYPE;
  ref_rate bigint;
  bound bigint;
  pos bigint;
BEGIN
  SELECT * INTO q FROM quote WHERE id = NEW.quote_id;
  IF q.status <> 'DRAFT' OR q.trade_request_id <> NEW.trade_request_id OR q.direction <> NEW.direction OR q.valid_for_seconds <> 60 THEN
    RAISE EXCEPTION 'an automatic quote is recorded with its own unsent 60-second quote' USING ERRCODE = 'IX137';
  END IF;
  IF (SELECT desk_id FROM trade_request WHERE id = q.trade_request_id) IS NOT NULL THEN
    RAISE EXCEPTION 'a desk prices its own deals: quote % is not the INRP2P exchange''s', q.ref USING ERRCODE = 'IX137';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM liquidity_route WHERE id = q.route_id AND trader_id IS NOT NULL AND execution_mode = 'P2P') THEN
    RAISE EXCEPTION 'an automatic quote runs on a trader''s P2P route' USING ERRCODE = 'IX137';
  END IF;
  SELECT * INTO o FROM trader_order WHERE id = NEW.trader_order_id;
  IF o.status <> 'ACCEPTED' OR o.trade_request_id <> q.trade_request_id OR o.route_id <> q.route_id
     OR o.rate_micro <> q.route_rate_micro OR o.route_rate_snapshot_id <> q.route_rate_snapshot_id OR o.planned_client_rate_micro <> q.client_rate_micro THEN
    RAISE EXCEPTION 'automatic quote % is not priced on its trader''s accepted order', q.ref USING ERRCODE = 'IX137';
  END IF;
  SELECT * INTO nf FROM quote_network_fee WHERE quote_id = q.id;
  IF NOT FOUND OR nf.net_margin_usdt_minor IS DISTINCT FROM NEW.net_margin_usdt_minor OR nf.min_net_margin_usdt_minor IS DISTINCT FROM NEW.min_net_margin_usdt_minor
     OR nf.funder_trader_id IS NOT NULL AND nf.unit = 'USDT' THEN
    RAISE EXCEPTION 'automatic quote % leaves what its frozen network terms say, carried by INRP2P', q.ref USING ERRCODE = 'IX137';
  END IF;
  SELECT rate_micro INTO ref_rate FROM rate_snapshot WHERE id = NEW.reference_snapshot_id AND kind = 'REFERENCE' AND direction = q.direction;
  IF ref_rate IS NULL OR ref_rate <> NEW.reference_rate_micro THEN
    RAISE EXCEPTION 'automatic quote % names a market reference of its direction', q.ref USING ERRCODE = 'IX137';
  END IF;
  SELECT * INTO p FROM pricing_policy WHERE id = NEW.policy_id;
  IF q.direction = 'BUY_USDT' THEN
    bound := (ref_rate * (10000 + p.max_premium_bps)) / 10000;
    pos := floor(((q.client_rate_micro - ref_rate) * 10000)::numeric / ref_rate);
    IF NEW.cap_rate_micro > bound OR q.client_rate_micro > NEW.cap_rate_micro THEN
      RAISE EXCEPTION 'automatic quote % asks more than the market reference allows', q.ref USING ERRCODE = 'IX137';
    END IF;
  ELSE
    bound := (ref_rate * (10000 - p.max_premium_bps) + 9999) / 10000;
    pos := floor(((ref_rate - q.client_rate_micro) * 10000)::numeric / ref_rate);
    IF NEW.cap_rate_micro < bound OR q.client_rate_micro < NEW.cap_rate_micro THEN
      RAISE EXCEPTION 'automatic quote % pays less than the market reference allows', q.ref USING ERRCODE = 'IX137';
    END IF;
  END IF;
  IF pos <> NEW.position_bps THEN
    RAISE EXCEPTION 'automatic quote % sits at % bps from the reference, not %', q.ref, pos, NEW.position_bps USING ERRCODE = 'IX137';
  END IF;
  IF NEW.rfq_id IS NOT NULL AND (SELECT trade_request_id FROM rfq WHERE id = NEW.rfq_id) <> q.trade_request_id THEN
    RAISE EXCEPTION 'automatic quote % names another request''s price request', q.ref USING ERRCODE = 'IX137';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER auto_quote_insert BEFORE INSERT ON auto_quote FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_auto_quote();

-- 6. What the inbox says ---------------------------------------------------------------------------------------------

ALTER TABLE client_notification DROP CONSTRAINT client_notification_kind_check;
ALTER TABLE client_notification ADD CONSTRAINT client_notification_kind_check CHECK (kind IN (
  'QUOTE_SENT', 'QUOTE_EXPIRED', 'REQUEST_DECLINED', 'TRADE_OPENED', 'PAYOUT_CONFIRMED', 'TRADE_COMPLETED', 'TRADE_CANCELLED',
  'DESTINATION_ADDED', 'DESTINATION_ARCHIVED', 'TRADE_DESTINATION_CHANGED',
  'TRADER_APPROVED', 'TRADER_REJECTED', 'TRADER_PAUSED', 'TRADER_RESUMED', 'TRADER_ORDER_NEW', 'TRADER_ORDER_ACCEPTED',
  'TRADER_ACTION_REQUIRED', 'TRADER_PAYMENT_CONFIRMED', 'TRADER_ORDER_COMPLETED', 'TRADER_ORDER_CLOSED', 'TRADER_RESERVE_ISSUE',
  'PAYMENT_RETURNED', 'TEAM_CHANGED', 'P2P_DISPUTE_OPENED', 'P2P_DISPUTE_DECIDED', 'P2P_REFUND', 'DESK_NOTICE',
  'DEAL_MESSAGE', 'P2P_PAY_FINAL', 'P2P_RECEIPT_LATE', 'TRADER_PRICE_REQUEST'));


-- Grants -------------------------------------------------------------------------------------------------------------

GRANT SELECT, INSERT ON pricing_policy, auto_quote, rfq, rfq_invite, rfq_bid TO inrp2p_app;
GRANT UPDATE (status, closed_at, close_note) ON rfq TO inrp2p_app;
GRANT UPDATE (status) ON rfq_bid TO inrp2p_app;
GRANT UPDATE (instant_until, instant_set_by, rails) ON trader_block TO inrp2p_app;
GRANT USAGE ON SEQUENCE rfq_ref_seq TO inrp2p_app;
GRANT SELECT ON pricing_policy, auto_quote, rfq, rfq_invite, rfq_bid TO inrp2p_readonly;
