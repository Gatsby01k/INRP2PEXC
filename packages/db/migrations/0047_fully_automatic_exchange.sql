-- 0047 The fully automatic INRP2P exchange (docs/adr/0028-fully-automatic-exchange.md).
--
-- With automatic prices on, nobody at INRP2P prices or routes a deal of its own exchange: a trader's firm offer prices it,
-- or its traders' bids do, or the client is told plainly that there is no price for it now. Three things made a person
-- necessary before, and this migration is what takes them away.
--
-- 1. A trader's rate could only be a fixed number, so a firm offer had to run out (at most seven days) before the market
--    left it behind. `trader_block.rate_basis = 'MARKET'` is a rate the trader sets against the market instead — the
--    confirmed reference of the deals its side fills, moved by its own `market_offset_bps`, held at its own
--    `rate_limit_micro` — and such a side may be firm until the trader turns it off (`instant_open_ended`).
-- 2. An order at a market rate records the reference and the terms its rate was derived from (`rate_reference_snapshot_id`,
--    `rate_offset_bps`, `rate_limit_micro`); the database derives the rate again and refuses one it does not get (IX143).
--    It is the only way a route rate is ever derived from a reference (FI-01).
-- 3. INRP2P's own deal carried its network out of its margin, so a small deal could not be priced at the market at all.
--    The client now pays it, as a line of its own (`quote.client_network_base_minor`, copied to the trade): the deal's
--    network is still the escrow's, inside the margin until it is settled at cost (FI-101); INRP2P's margin is the spread
--    alone (IX144). A desk's deal is unchanged: the desk's side carries its network.
-- 4. A request nothing prices honestly closes with why (`trade_request.no_price_reason`): it never waits for a person.
-- Error codes IX143–IX144 belong to this migration. 0001–0046 are not edited.

-- 1. A trader's market rate ------------------------------------------------------------------------------------------

-- The market rate of a side: the reference moved by the offset, on the rupee-paisa grid in the trader's favour (up for a
-- side selling USDT, down for one buying it), held at the trader's own bound. Exactly `marketRateMicro` in the kernel.
CREATE FUNCTION inrp2p_market_rate_micro(p_side text, p_reference bigint, p_offset_bps integer, p_limit bigint) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_side = 'SELL_USDT'
    THEN greatest(ceil(p_reference::numeric * (10000 + p_offset_bps) / 100000000)::bigint * 10000, coalesce(p_limit, 0))
    ELSE least(floor(p_reference::numeric * (10000 + p_offset_bps) / 100000000)::bigint * 10000, coalesce(p_limit, 9223372036854775807))
  END
$$;

ALTER TABLE trader_block
  ADD COLUMN rate_basis         text NOT NULL DEFAULT 'FIXED' CHECK (rate_basis IN ('FIXED', 'MARKET')),
  ADD COLUMN market_offset_bps  integer CHECK (market_offset_bps BETWEEN -1000 AND 1000),
  -- A side selling USDT never sells below it; a side buying USDT never buys above it.
  ADD COLUMN rate_limit_micro   bigint CHECK (rate_limit_micro > 0),
  -- ADR 0028: firm until the trader turns it off — a market rate never goes stale, so it needs no end of its own.
  ADD COLUMN instant_open_ended boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT trader_block_rate_basis_shape CHECK (
    (rate_basis = 'FIXED' AND market_offset_bps IS NULL AND rate_limit_micro IS NULL)
    OR (rate_basis = 'MARKET' AND market_offset_bps IS NOT NULL AND rate_micro IS NULL)),
  ADD CONSTRAINT trader_block_instant_open_ended CHECK (NOT instant_open_ended OR (rate_basis = 'MARKET' AND instant_until IS NULL));

-- A firm offer is someone's commitment, open-ended or not.
ALTER TABLE trader_block DROP CONSTRAINT trader_block_instant_owner;
ALTER TABLE trader_block ADD CONSTRAINT trader_block_instant_owner CHECK ((instant_until IS NULL AND NOT instant_open_ended) = (instant_set_by IS NULL));

-- An active side has a rate — its own number, or the market's moved by its offset — and an order size.
DO $$
DECLARE
  c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'trader_block'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%rate_micro IS NOT NULL%min_order_minor IS NOT NULL%';
  IF c IS NULL THEN RAISE EXCEPTION 'the active-side constraint of trader_block was not found'; END IF;
  EXECUTE format('ALTER TABLE trader_block DROP CONSTRAINT %I', c);
END
$$;
ALTER TABLE trader_block ADD CONSTRAINT trader_block_active_terms CHECK (status = 'PAUSED'
  OR ((rate_micro IS NOT NULL OR rate_basis = 'MARKET') AND min_order_minor IS NOT NULL AND max_order_minor IS NOT NULL));

DROP TRIGGER trader_block_immutable ON trader_block;
CREATE TRIGGER trader_block_immutable BEFORE UPDATE ON trader_block
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns(
    'capacity_minor', 'reserved_minor', 'rate_micro', 'min_order_minor', 'max_order_minor', 'status', 'updated_at', 'version', 'instant_until', 'instant_set_by', 'rails',
    'rate_basis', 'market_offset_bps', 'rate_limit_micro', 'instant_open_ended');

-- IX142: a firm offer is committed by the trader's own member; one with an end starts in the future and lasts at most
-- seven days, and only a market rate may be firm without one.
CREATE OR REPLACE FUNCTION inrp2p_guard_trader_block_instant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.instant_until IS NOT NULL OR NEW.instant_open_ended)
     AND (NEW.instant_until IS DISTINCT FROM OLD.instant_until OR NEW.instant_set_by IS DISTINCT FROM OLD.instant_set_by OR NEW.instant_open_ended IS DISTINCT FROM OLD.instant_open_ended) THEN
    IF NEW.instant_until IS NOT NULL AND (NEW.instant_until <= inrp2p_now() OR NEW.instant_until > inrp2p_now() + interval '7 days') THEN
      RAISE EXCEPTION 'a firm offer lasts from now to at most seven days ahead' USING ERRCODE = 'IX142';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM trader_profile t JOIN client_user cu ON cu.client_id = t.client_id
      WHERE t.id = NEW.trader_id AND cu.user_id = NEW.instant_set_by AND cu.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'a firm offer is committed by a member of the trader' USING ERRCODE = 'IX142';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER trader_block_instant ON trader_block;
CREATE TRIGGER trader_block_instant BEFORE UPDATE OF instant_until, instant_set_by, instant_open_ended ON trader_block
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_trader_block_instant();

-- 2. An order at a market rate ---------------------------------------------------------------------------------------

ALTER TABLE trader_order
  ADD COLUMN rate_reference_snapshot_id uuid REFERENCES rate_snapshot (id),
  ADD COLUMN rate_offset_bps            integer,
  ADD COLUMN rate_limit_micro           bigint,
  ADD CONSTRAINT trader_order_market_rate_shape CHECK ((rate_reference_snapshot_id IS NULL) = (rate_offset_bps IS NULL)
    AND (rate_reference_snapshot_id IS NOT NULL OR rate_limit_micro IS NULL));

-- IX143 (FI-01, FI-113): an order at a market rate is at exactly the rate its side's standing terms give on a confirmed
-- market reference of the deals it fills, fresh enough for the pricing policy — derived again here, never trusted.
CREATE FUNCTION inrp2p_guard_trader_order_market_rate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  b trader_block%ROWTYPE;
  s rate_snapshot%ROWTYPE;
  max_age integer;
BEGIN
  IF NEW.rate_reference_snapshot_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO b FROM trader_block WHERE id = NEW.block_id;
  IF b.rate_basis <> 'MARKET' OR b.market_offset_bps IS DISTINCT FROM NEW.rate_offset_bps OR b.rate_limit_micro IS DISTINCT FROM NEW.rate_limit_micro THEN
    RAISE EXCEPTION 'order % is at a market rate its side does not stand behind', NEW.ref USING ERRCODE = 'IX143';
  END IF;
  SELECT * INTO s FROM rate_snapshot WHERE id = NEW.rate_reference_snapshot_id;
  IF s.kind <> 'REFERENCE' OR s.direction <> (CASE WHEN NEW.side = 'BUY_USDT' THEN 'SELL_USDT' ELSE 'BUY_USDT' END) THEN
    RAISE EXCEPTION 'order % names a reference that is not the market of the deals its side fills', NEW.ref USING ERRCODE = 'IX143';
  END IF;
  SELECT reference_max_age_seconds INTO max_age FROM pricing_policy ORDER BY set_at DESC, id DESC LIMIT 1;
  IF s.effective_at > inrp2p_now() OR inrp2p_now() - s.effective_at > make_interval(secs => coalesce(max_age, 0)) THEN
    RAISE EXCEPTION 'order % is priced on a market reference older than the pricing policy allows', NEW.ref USING ERRCODE = 'IX143';
  END IF;
  IF NEW.rate_micro <> inrp2p_market_rate_micro(NEW.side, s.rate_micro, NEW.rate_offset_bps, NEW.rate_limit_micro) THEN
    RAISE EXCEPTION 'order % is at % but its market terms give %', NEW.ref, NEW.rate_micro,
      inrp2p_market_rate_micro(NEW.side, s.rate_micro, NEW.rate_offset_bps, NEW.rate_limit_micro) USING ERRCODE = 'IX143';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trader_order_market_rate BEFORE INSERT ON trader_order
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_trader_order_market_rate();

-- 3. The network the client pays -------------------------------------------------------------------------------------

ALTER TABLE quote
  ADD COLUMN client_network_base_minor bigint CHECK (client_network_base_minor >= 0),
  ADD CONSTRAINT quote_client_network_shape CHECK (client_network_base_minor IS NULL OR client_network_base_minor = network_fee_base_minor);
ALTER TABLE trade_economics
  ADD COLUMN client_network_base_minor bigint CHECK (client_network_base_minor >= 0),
  ADD CONSTRAINT trade_economics_client_network_shape CHECK (client_network_base_minor IS NULL OR client_network_base_minor = network_fee_base_minor);

-- IX144 (FI-100): INRP2P's own deal priced in USDT carries its network as the client's line, the whole of it; a desk's
-- deal never does — its side carries it. Judged when the quote is made: quotes made before this migration keep what they
-- were made with.
CREATE FUNCTION inrp2p_guard_quote_client_network() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  req_desk uuid;
BEGIN
  SELECT desk_id INTO req_desk FROM trade_request WHERE id = NEW.trade_request_id;
  IF req_desk IS NOT NULL AND NEW.client_network_base_minor IS NOT NULL THEN
    RAISE EXCEPTION 'quote % is a desk''s deal: the desk''s side carries its network, the client pays none', NEW.ref USING ERRCODE = 'IX144';
  END IF;
  IF req_desk IS NULL AND NEW.client_network_base_minor IS DISTINCT FROM NEW.network_fee_base_minor THEN
    RAISE EXCEPTION 'quote % is INRP2P''s own deal: its client pays the network it carries, the whole of it', NEW.ref USING ERRCODE = 'IX144';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER quote_client_network BEFORE INSERT ON quote FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_quote_client_network();

-- IX045: copied values equal the accepted quote exactly — the client's network included.
CREATE OR REPLACE FUNCTION inrp2p_guard_trade_economics_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  q quote%ROWTYPE;
BEGIN
  SELECT quote.* INTO q FROM quote JOIN trade ON trade.quote_id = quote.id WHERE trade.id = NEW.trade_id;
  IF q.direction <> NEW.direction OR q.fixed_side <> NEW.fixed_side OR q.base_minor <> NEW.base_minor OR q.quote_inr_minor <> NEW.quote_inr_minor
     OR q.client_rate_micro <> NEW.client_rate_micro OR q.route_rate_micro <> NEW.route_rate_micro OR q.route_value_inr_minor <> NEW.route_value_inr_minor
     OR q.gross_margin_inr_minor <> NEW.gross_margin_inr_minor OR q.route_id <> NEW.route_id OR q.route_rate_snapshot_id <> NEW.route_rate_snapshot_id
     OR q.network <> NEW.network OR q.bank_account_id IS DISTINCT FROM NEW.bank_account_id OR q.crypto_wallet_id IS DISTINCT FROM NEW.crypto_wallet_id
     OR q.route_base_minor IS DISTINCT FROM NEW.route_base_minor OR q.gross_margin_base_minor IS DISTINCT FROM NEW.gross_margin_base_minor
     OR q.platform_fee_bps IS DISTINCT FROM NEW.platform_fee_bps OR q.platform_fee_base_minor IS DISTINCT FROM NEW.platform_fee_base_minor
     OR q.network_fee_base_minor IS DISTINCT FROM NEW.network_fee_base_minor OR q.client_network_base_minor IS DISTINCT FROM NEW.client_network_base_minor THEN
    RAISE EXCEPTION 'trade economics for % do not equal the accepted quote', NEW.trade_id USING ERRCODE = 'IX045';
  END IF;
  RETURN NEW;
END
$$;

-- 4. A request nothing priced ---------------------------------------------------------------------------------------

-- ADR 0028: with automatic prices on, a request nothing prices honestly closes, declined by the system rather than by a
-- person, with why: no market reference, unknown network fees, no firm offer for the amount, none at the market, or no bid.
-- The client is told in plain words (`status_reason`); this says which, for the client's screen and for the record.
ALTER TABLE trade_request
  ADD COLUMN no_price_reason text CHECK (no_price_reason IN ('NO_MARKET', 'NETWORK_UNKNOWN', 'NO_OFFER', 'NOT_COMPETITIVE', 'NO_BID')),
  ADD CONSTRAINT trade_request_no_price_declined CHECK (no_price_reason IS NULL OR (status = 'DECLINED' AND desk_id IS NULL));
DROP TRIGGER trade_request_immutable ON trade_request;
CREATE TRIGGER trade_request_immutable BEFORE UPDATE ON trade_request
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'status_reason', 'assigned_dealer_id', 'last_activity_at', 'closed_at', 'version', 'no_price_reason');

-- Grants -------------------------------------------------------------------------------------------------------------

GRANT UPDATE (rate_basis, market_offset_bps, rate_limit_micro, instant_open_ended) ON trader_block TO inrp2p_app;
GRANT EXECUTE ON FUNCTION inrp2p_market_rate_micro(text, bigint, integer, bigint) TO inrp2p_app, inrp2p_readonly;
GRANT SELECT (client_network_base_minor) ON quote, trade_economics TO inrp2p_readonly;
GRANT SELECT (rate_basis, market_offset_bps, rate_limit_micro, instant_open_ended) ON trader_block TO inrp2p_readonly;
GRANT SELECT (rate_reference_snapshot_id, rate_offset_bps, rate_limit_micro) ON trader_order TO inrp2p_readonly;
GRANT UPDATE (no_price_reason) ON trade_request TO inrp2p_app;
GRANT SELECT (no_price_reason) ON trade_request TO inrp2p_readonly;
