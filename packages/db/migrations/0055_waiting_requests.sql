-- 0055 No client turned away (2026-11-23, ADR 0032).
--
-- Until now a request nothing priced honestly closed at once (ADR 0028): the client — who had just added a bank account
-- and a wallet — read one line and left, and no trader ever heard that someone was waiting. Now it waits.
--
-- 1. `trade_request.waiting_since/waiting_until`: a request nothing prices stays OPEN and the exchange keeps looking for
--    it until `waiting_until`; its `no_price_reason` says why nothing priced it last. Only an open request of the INRP2P
--    exchange waits; a request stops waiting the moment it is priced, closed or put to a person. When the time is up
--    with no price, it closes DECLINED as before (ADR 0028), and the client is told.
-- 2. `auto_quote.held`: the price found for a waiting client is held for ten minutes, not sixty seconds — the client is
--    not on the screen, it is told by message and comes back to it. Such a price says nothing about how a client on the
--    screen answers a price, so it is not learnt from (IX139 amended, IX147).
-- 3. The inbox says: a waiting client's price is ready, a wait ended without one, clients are waiting for a trader.
--
-- Error code IX147 belongs to this migration. 0001–0054 are not edited.


-- 1. A request that waits --------------------------------------------------------------------------------------------

ALTER TABLE trade_request
  ADD COLUMN waiting_since timestamptz,
  ADD COLUMN waiting_until timestamptz,
  ADD CONSTRAINT trade_request_waiting CHECK (
    waiting_until IS NULL OR (status = 'OPEN' AND desk_id IS NULL AND waiting_since IS NOT NULL AND waiting_until > waiting_since)),
  ADD CONSTRAINT trade_request_waiting_since CHECK (waiting_since IS NULL OR desk_id IS NULL);
-- Why nothing priced it: on a request that was declined unpriced, as before, or on one that waited.
ALTER TABLE trade_request DROP CONSTRAINT trade_request_no_price_declined;
ALTER TABLE trade_request ADD CONSTRAINT trade_request_no_price_declined CHECK (
  no_price_reason IS NULL OR (desk_id IS NULL AND (status = 'DECLINED' OR waiting_since IS NOT NULL)));
CREATE INDEX trade_request_waiting_idx ON trade_request (waiting_since, id) WHERE waiting_until IS NOT NULL;
DROP TRIGGER trade_request_immutable ON trade_request;
CREATE TRIGGER trade_request_immutable BEFORE UPDATE ON trade_request
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns(
    'status', 'status_reason', 'assigned_dealer_id', 'last_activity_at', 'closed_at', 'version', 'no_price_reason', 'waiting_since', 'waiting_until');


-- 2. The price found for a waiting client ----------------------------------------------------------------------------

ALTER TABLE auto_quote ADD COLUMN held boolean NOT NULL DEFAULT false;

-- IX139 as in 0045, but an automatic quote held for a waiting client is held for 600 seconds, every other for 60.
-- IX147: only a request that waited is given a held price.
CREATE OR REPLACE FUNCTION inrp2p_guard_auto_quote() RETURNS trigger
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
  IF q.status <> 'DRAFT' OR q.trade_request_id <> NEW.trade_request_id OR q.direction <> NEW.direction
     OR q.valid_for_seconds <> (CASE WHEN NEW.held THEN 600 ELSE 60 END) THEN
    RAISE EXCEPTION 'an automatic quote is recorded with its own unsent quote, of 60 seconds — or 600 held for a waiting client' USING ERRCODE = 'IX139';
  END IF;
  IF (SELECT desk_id FROM trade_request WHERE id = q.trade_request_id) IS NOT NULL THEN
    RAISE EXCEPTION 'a desk prices its own deals: quote % is not the INRP2P exchange''s', q.ref USING ERRCODE = 'IX139';
  END IF;
  IF NEW.held AND (SELECT waiting_since FROM trade_request WHERE id = q.trade_request_id) IS NULL THEN
    RAISE EXCEPTION 'quote % is held for a client who never waited', q.ref USING ERRCODE = 'IX147';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM liquidity_route WHERE id = q.route_id AND trader_id IS NOT NULL AND execution_mode = 'P2P') THEN
    RAISE EXCEPTION 'an automatic quote runs on a trader''s P2P route' USING ERRCODE = 'IX139';
  END IF;
  SELECT * INTO o FROM trader_order WHERE id = NEW.trader_order_id;
  IF o.status <> 'ACCEPTED' OR o.trade_request_id <> q.trade_request_id OR o.route_id <> q.route_id
     OR o.rate_micro <> q.route_rate_micro OR o.route_rate_snapshot_id <> q.route_rate_snapshot_id OR o.planned_client_rate_micro <> q.client_rate_micro THEN
    RAISE EXCEPTION 'automatic quote % is not priced on its trader''s accepted order', q.ref USING ERRCODE = 'IX139';
  END IF;
  SELECT * INTO nf FROM quote_network_fee WHERE quote_id = q.id;
  IF NOT FOUND OR nf.net_margin_usdt_minor IS DISTINCT FROM NEW.net_margin_usdt_minor OR nf.min_net_margin_usdt_minor IS DISTINCT FROM NEW.min_net_margin_usdt_minor
     OR nf.funder_trader_id IS NOT NULL AND nf.unit = 'USDT' THEN
    RAISE EXCEPTION 'automatic quote % leaves what its frozen network terms say, carried by INRP2P', q.ref USING ERRCODE = 'IX139';
  END IF;
  SELECT rate_micro INTO ref_rate FROM rate_snapshot WHERE id = NEW.reference_snapshot_id AND kind = 'REFERENCE' AND direction = q.direction;
  IF ref_rate IS NULL OR ref_rate <> NEW.reference_rate_micro THEN
    RAISE EXCEPTION 'automatic quote % names a market reference of its direction', q.ref USING ERRCODE = 'IX139';
  END IF;
  SELECT * INTO p FROM pricing_policy WHERE id = NEW.policy_id;
  IF q.direction = 'BUY_USDT' THEN
    bound := (ref_rate * (10000 + p.max_premium_bps)) / 10000;
    pos := floor(((q.client_rate_micro - ref_rate) * 10000)::numeric / ref_rate);
    IF NEW.cap_rate_micro > bound OR q.client_rate_micro > NEW.cap_rate_micro THEN
      RAISE EXCEPTION 'automatic quote % asks more than the market reference allows', q.ref USING ERRCODE = 'IX139';
    END IF;
  ELSE
    bound := (ref_rate * (10000 - p.max_premium_bps) + 9999) / 10000;
    pos := floor(((ref_rate - q.client_rate_micro) * 10000)::numeric / ref_rate);
    IF NEW.cap_rate_micro < bound OR q.client_rate_micro < NEW.cap_rate_micro THEN
      RAISE EXCEPTION 'automatic quote % pays less than the market reference allows', q.ref USING ERRCODE = 'IX139';
    END IF;
  END IF;
  IF pos <> NEW.position_bps THEN
    RAISE EXCEPTION 'automatic quote % sits at % bps from the reference, not %', q.ref, pos, NEW.position_bps USING ERRCODE = 'IX139';
  END IF;
  IF NEW.rfq_id IS NOT NULL AND (SELECT trade_request_id FROM rfq WHERE id = NEW.rfq_id) <> q.trade_request_id THEN
    RAISE EXCEPTION 'automatic quote % names another request''s price request', q.ref USING ERRCODE = 'IX139';
  END IF;
  RETURN NEW;
END
$$;


-- 3. What the inbox says ---------------------------------------------------------------------------------------------

ALTER TABLE client_notification DROP CONSTRAINT client_notification_kind_check;
ALTER TABLE client_notification ADD CONSTRAINT client_notification_kind_check CHECK (kind IN (
  'QUOTE_SENT', 'QUOTE_EXPIRED', 'REQUEST_DECLINED', 'TRADE_OPENED', 'PAYOUT_CONFIRMED', 'TRADE_COMPLETED', 'TRADE_CANCELLED',
  'DESTINATION_ADDED', 'DESTINATION_ARCHIVED', 'TRADE_DESTINATION_CHANGED',
  'TRADER_APPROVED', 'TRADER_REJECTED', 'TRADER_PAUSED', 'TRADER_RESUMED', 'TRADER_ORDER_NEW', 'TRADER_ORDER_ACCEPTED',
  'TRADER_ACTION_REQUIRED', 'TRADER_PAYMENT_CONFIRMED', 'TRADER_ORDER_COMPLETED', 'TRADER_ORDER_CLOSED', 'TRADER_RESERVE_ISSUE',
  'PAYMENT_RETURNED', 'TEAM_CHANGED', 'P2P_DISPUTE_OPENED', 'P2P_DISPUTE_DECIDED', 'P2P_REFUND', 'DESK_NOTICE',
  'DEAL_MESSAGE', 'P2P_PAY_FINAL', 'P2P_RECEIPT_LATE', 'TRADER_SETTLEMENT_CHANGE', 'TRADER_PRICE_REQUEST',
  'P2P_PAY_NOW', 'P2P_PAYMENT_SENT', 'TRADER_SIDE_EMPTY', 'DESTINATION_REJECTED', 'DESTINATION_PAUSED',
  'WAITING_PRICE_READY', 'WAITING_ENDED', 'TRADER_CLIENTS_WAITING'));


-- Grants -------------------------------------------------------------------------------------------------------------

GRANT UPDATE (waiting_since, waiting_until) ON trade_request TO inrp2p_app;
GRANT SELECT (waiting_since, waiting_until) ON trade_request TO inrp2p_readonly;
GRANT SELECT (held) ON auto_quote TO inrp2p_readonly;
