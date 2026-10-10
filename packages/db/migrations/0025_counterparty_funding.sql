-- 0025 counterparty-funded execution (DECISIONS.md D-16, docs/adr/0016-counterparty-funded-execution.md).
--
-- Every trade is executed with the funds of the parties of that trade. The platform's own USDT/INR is never
-- advanced. Concretely:
--   * `trade_funding` freezes, per trade, whose money the trade runs on. Every trade that exists when this migration
--     runs keeps the model it was accepted under (LEGACY_EXCHANGE_FUNDED); every trade created afterwards is
--     COUNTERPARTY_FUNDED, whichever application version created it, and nothing can create a legacy one again.
--   * A counterparty-funded trade never reserves treasury funds (IX083).
--   * `funding_source` is the money a trade has actually received: its completed client legs (client funds) and its
--     confirmed route-to-exchange settlements (counterparty funds), each at the physical place it arrived.
--   * `funding_allocation` earmarks part of one source for one outgoing use of the same trade, asset and place:
--     an exchange-paid client payout draws on counterparty funds; a payment to the counterparty (TO_ROUTE) and a
--     refund draw on client funds. A source is never earmarked beyond its amount (IX085) and every live outgoing use
--     of a counterparty-funded trade is earmarked in full, at commit, whatever code wrote it (IX086).
--   * The exchange pays the counterparty from client funds only after the counterparty delivered (IX087).
--   * A deposit address that still holds a counterparty-funded trade's earmarked money does not return to the pool
--     (IX088).
-- Allocations post nothing: they are earmarks over money the ledger already recorded (FI-27, FI-42 unchanged).
-- Error codes IX082–IX088 belong to this migration. 0001–0024 are applied and are not edited.

-- ---------------------------------------------------------------------------------------------------------------
-- The funding model of each trade (FI-70).
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE trade_funding (
  trade_id   uuid PRIMARY KEY REFERENCES trade (id),
  model      text NOT NULL CHECK (model IN ('COUNTERPARTY_FUNDED', 'LEGACY_EXCHANGE_FUNDED')),
  created_at timestamptz NOT NULL DEFAULT inrp2p_now()
);
-- Trades accepted before this migration keep the model they were accepted under. No economics are rewritten.
INSERT INTO trade_funding (trade_id, model, created_at) SELECT id, 'LEGACY_EXCHANGE_FUNDED', opened_at FROM trade;

CREATE FUNCTION inrp2p_guard_trade_funding_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.model <> 'COUNTERPARTY_FUNDED' THEN
    RAISE EXCEPTION 'a new trade is counterparty-funded; % exists only for trades accepted before migration 0025', NEW.model USING ERRCODE = 'IX082';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trade_funding_insert BEFORE INSERT ON trade_funding
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_trade_funding_insert();
CREATE TRIGGER trade_funding_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON trade_funding
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- The database, not the application version, decides the model of a new trade: an old instance that does not know
-- about funding still creates a counterparty-funded trade, and then cannot pay it out of its own money (IX083/IX086).
CREATE FUNCTION inrp2p_trade_funding_for_new_trade() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO trade_funding (trade_id, model) VALUES (NEW.id, 'COUNTERPARTY_FUNDED');
  RETURN NULL;
END
$$;
CREATE TRIGGER trade_funding_new_trade AFTER INSERT ON trade
  FOR EACH ROW EXECUTE FUNCTION inrp2p_trade_funding_for_new_trade();

CREATE FUNCTION inrp2p_trade_is_counterparty_funded(p_trade uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT model = 'COUNTERPARTY_FUNDED' FROM trade_funding WHERE trade_id = p_trade), false)
$$;

-- FI-71: a counterparty-funded trade never holds a treasury reservation.
CREATE FUNCTION inrp2p_guard_treasury_reservation_funding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF inrp2p_trade_is_counterparty_funded(NEW.trade_id) THEN
    RAISE EXCEPTION 'trade % is counterparty-funded: the exchange reserves none of its own USDT for it', NEW.trade_id USING ERRCODE = 'IX083';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER treasury_reservation_funding BEFORE INSERT ON treasury_reservation
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_treasury_reservation_funding();

-- ---------------------------------------------------------------------------------------------------------------
-- A USDT outflow names the address it leaves from. A pass-through payout leaves the deposit address where the
-- funding arrived; its ledger account is that address's treasury wallet.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE settlement_leg ADD COLUMN source_deposit_address_id uuid REFERENCES deposit_address (id);
ALTER TABLE settlement_leg ADD CONSTRAINT settlement_leg_source_address_shape
  CHECK (source_deposit_address_id IS NULL OR (payer = 'EXCHANGE_ACCOUNT' AND asset = 'USDT' AND treasury_wallet_id IS NOT NULL));
CREATE FUNCTION inrp2p_guard_leg_source_address() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_deposit_address_id IS NOT NULL
     AND (SELECT treasury_wallet_id FROM deposit_address WHERE id = NEW.source_deposit_address_id) IS DISTINCT FROM NEW.treasury_wallet_id THEN
    RAISE EXCEPTION 'leg % sends from a deposit address of another treasury wallet', NEW.id USING ERRCODE = 'IX084';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER settlement_leg_source_address BEFORE INSERT ON settlement_leg
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_leg_source_address();

-- ---------------------------------------------------------------------------------------------------------------
-- Funding sources: what the trade has actually received, and where it is (FI-72…FI-76). A view, so a source exists
-- exactly when its movement is confirmed, whichever application version confirmed it.
-- ---------------------------------------------------------------------------------------------------------------
CREATE VIEW funding_source AS
  SELECT 'CLIENT_FUNDS'::text AS kind,
         l.id AS source_id,
         l.trade_id,
         l.asset,
         l.amount_minor,
         CASE WHEN a.transfer_kind = 'FIAT' THEN 'INR:' || f.payee_id::text ELSE 'TRON:' || c.to_address::text END AS location,
         l.confirmed_at
    FROM settlement_leg l
    JOIN transfer_allocation a ON a.settlement_leg_id = l.id AND a.dimension = 'CLIENT' AND a.voided_at IS NULL
    LEFT JOIN fiat_transfer f ON f.id = a.fiat_transfer_id
    LEFT JOIN crypto_transfer c ON c.id = a.crypto_transfer_id
   WHERE l.side = 'CLIENT_TO_EXCHANGE' AND l.status = 'COMPLETED'
  UNION ALL
  SELECT 'COUNTERPARTY_FUNDS'::text,
         s.id,
         o.trade_id,
         s.asset,
         s.amount_minor,
         CASE WHEN s.transfer_kind = 'FIAT' THEN 'INR:' || f.payee_id::text ELSE 'TRON:' || c.to_address::text END,
         s.confirmed_at
    FROM route_settlement s
    JOIN route_obligation o ON o.id = s.route_obligation_id
    LEFT JOIN fiat_transfer f ON f.id = s.fiat_transfer_id
    LEFT JOIN crypto_transfer c ON c.id = s.crypto_transfer_id
   WHERE s.flow = 'FROM_ROUTE_TO_EXCHANGE' AND s.status = 'CONFIRMED' AND o.trade_id IS NOT NULL;

-- Where an outgoing use sends from: a leg's INR account, its source deposit address or its treasury wallet; a route
-- payment's movement (the paying INR account, or the sending address).
CREATE FUNCTION inrp2p_funding_use_location(p_leg uuid, p_route_settlement uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_leg IS NOT NULL THEN (
      SELECT CASE WHEN l.asset = 'INR' THEN 'INR:' || l.inr_account_id::text
                  ELSE 'TRON:' || coalesce((SELECT d.address::text FROM deposit_address d WHERE d.id = l.source_deposit_address_id),
                                           (SELECT w.address::text FROM treasury_wallet w WHERE w.id = l.treasury_wallet_id)) END
        FROM settlement_leg l WHERE l.id = p_leg)
    ELSE (
      SELECT CASE WHEN s.transfer_kind = 'FIAT' THEN 'INR:' || f.payer_id::text ELSE 'TRON:' || c.from_address::text END
        FROM route_settlement s
        LEFT JOIN fiat_transfer f ON f.id = s.fiat_transfer_id
        LEFT JOIN crypto_transfer c ON c.id = s.crypto_transfer_id
       WHERE s.id = p_route_settlement)
  END
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Funding allocations. ACTIVE (earmarked, use planned or in flight) ─▶ CONSUMED (use confirmed) | RELEASED (use
-- cancelled or failed and the money provably did not leave).
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE funding_allocation (
  id                         uuid PRIMARY KEY DEFAULT uuidv7(),
  trade_id                   uuid NOT NULL REFERENCES trade (id),
  source_kind                text NOT NULL CHECK (source_kind IN ('CLIENT_FUNDS', 'COUNTERPARTY_FUNDS')),
  source_leg_id              uuid REFERENCES settlement_leg (id),
  source_route_settlement_id uuid REFERENCES route_settlement (id),
  use_kind                   text NOT NULL CHECK (use_kind IN ('CLIENT_PAYOUT', 'REFUND', 'ROUTE_PAYMENT')),
  use_leg_id                 uuid REFERENCES settlement_leg (id),
  use_route_settlement_id    uuid REFERENCES route_settlement (id),
  asset                      text NOT NULL CHECK (asset IN ('INR', 'USDT')),
  amount_minor               bigint NOT NULL CHECK (amount_minor > 0),
  location                   text NOT NULL CHECK (location ~ '^(INR:[0-9a-f-]{36}|TRON:T[1-9A-HJ-NP-Za-km-z]{33})$'),
  status                     text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CONSUMED', 'RELEASED')),
  created_by                 text NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT inrp2p_now(),
  closed_by                  text,
  closed_at                  timestamptz,
  close_reason               text CHECK (length(close_reason) <= 500),
  CHECK ((source_kind = 'CLIENT_FUNDS') = (source_leg_id IS NOT NULL AND source_route_settlement_id IS NULL)),
  CHECK ((source_kind = 'COUNTERPARTY_FUNDS') = (source_route_settlement_id IS NOT NULL AND source_leg_id IS NULL)),
  CHECK ((use_kind IN ('CLIENT_PAYOUT', 'REFUND')) = (use_leg_id IS NOT NULL AND use_route_settlement_id IS NULL)),
  CHECK ((use_kind = 'ROUTE_PAYMENT') = (use_route_settlement_id IS NOT NULL AND use_leg_id IS NULL)),
  -- The client is paid with the counterparty's money; the counterparty and a refund with the client's (FI-72…74).
  CHECK (use_kind <> 'CLIENT_PAYOUT' OR source_kind = 'COUNTERPARTY_FUNDS'),
  CHECK (use_kind NOT IN ('REFUND', 'ROUTE_PAYMENT') OR source_kind = 'CLIENT_FUNDS'),
  CHECK ((status = 'ACTIVE') = (closed_at IS NULL AND closed_by IS NULL))
);
CREATE INDEX funding_allocation_trade_idx ON funding_allocation (trade_id);
CREATE INDEX funding_allocation_source_leg_idx ON funding_allocation (source_leg_id) WHERE source_leg_id IS NOT NULL;
CREATE INDEX funding_allocation_source_rs_idx ON funding_allocation (source_route_settlement_id) WHERE source_route_settlement_id IS NOT NULL;
CREATE INDEX funding_allocation_use_leg_idx ON funding_allocation (use_leg_id) WHERE use_leg_id IS NOT NULL;
CREATE INDEX funding_allocation_use_rs_idx ON funding_allocation (use_route_settlement_id) WHERE use_route_settlement_id IS NOT NULL;
CREATE INDEX funding_allocation_location_idx ON funding_allocation (location) WHERE status = 'ACTIVE';
CREATE TRIGGER funding_allocation_status BEFORE UPDATE ON funding_allocation
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'ACTIVE>CONSUMED,ACTIVE>RELEASED');
CREATE TRIGGER funding_allocation_immutable BEFORE UPDATE ON funding_allocation
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'closed_by', 'closed_at', 'close_reason');
CREATE TRIGGER funding_allocation_no_delete BEFORE DELETE OR TRUNCATE ON funding_allocation
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- FI-76: an allocation joins one confirmed source and one outgoing use of the same counterparty-funded trade, in
-- the same asset, at the same place.
CREATE FUNCTION inrp2p_guard_funding_allocation_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  src record;
  use_trade uuid;
  use_asset text;
  use_ok boolean;
  use_location text;
BEGIN
  IF NEW.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'a funding allocation starts ACTIVE' USING ERRCODE = 'IX084';
  END IF;
  IF NOT inrp2p_trade_is_counterparty_funded(NEW.trade_id) THEN
    RAISE EXCEPTION 'trade % is not counterparty-funded', NEW.trade_id USING ERRCODE = 'IX084';
  END IF;
  SELECT * INTO src FROM funding_source
   WHERE kind = NEW.source_kind AND source_id = coalesce(NEW.source_leg_id, NEW.source_route_settlement_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'funding source % is not a confirmed incoming movement', coalesce(NEW.source_leg_id, NEW.source_route_settlement_id) USING ERRCODE = 'IX084';
  END IF;
  IF src.trade_id <> NEW.trade_id OR src.asset <> NEW.asset OR src.location <> NEW.location THEN
    RAISE EXCEPTION 'funding source belongs to trade % in % at %; the allocation is for % in % at %', src.trade_id, src.asset, src.location, NEW.trade_id, NEW.asset, NEW.location
      USING ERRCODE = 'IX084';
  END IF;
  IF NEW.use_leg_id IS NOT NULL THEN
    SELECT l.trade_id, l.asset,
           CASE NEW.use_kind
             WHEN 'CLIENT_PAYOUT' THEN l.side = 'EXCHANGE_TO_CLIENT' AND l.payer = 'EXCHANGE_ACCOUNT'
             ELSE l.side = 'REFUND_TO_CLIENT' END
      INTO use_trade, use_asset, use_ok
      FROM settlement_leg l WHERE l.id = NEW.use_leg_id;
  ELSE
    SELECT o.trade_id, s.asset, s.flow = 'TO_ROUTE'
      INTO use_trade, use_asset, use_ok
      FROM route_settlement s JOIN route_obligation o ON o.id = s.route_obligation_id WHERE s.id = NEW.use_route_settlement_id;
  END IF;
  use_location := inrp2p_funding_use_location(NEW.use_leg_id, NEW.use_route_settlement_id);
  IF use_trade IS DISTINCT FROM NEW.trade_id OR use_asset IS DISTINCT FROM NEW.asset OR NOT coalesce(use_ok, false) OR use_location IS DISTINCT FROM NEW.location THEN
    RAISE EXCEPTION 'funding use does not match: trade %, asset %, place % (allocation % at %)', use_trade, use_asset, use_location, NEW.asset, NEW.location
      USING ERRCODE = 'IX084';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER funding_allocation_insert BEFORE INSERT ON funding_allocation
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_funding_allocation_insert();

-- FI-75: a source is never earmarked beyond what arrived. Checked at commit under the source row's lock, so two
-- transactions drawing on one source are checked one after the other.
CREATE FUNCTION inrp2p_check_funding_source_total() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  available bigint;
  taken bigint;
BEGIN
  IF NEW.source_leg_id IS NOT NULL THEN
    PERFORM 1 FROM settlement_leg WHERE id = NEW.source_leg_id FOR UPDATE;
    SELECT amount_minor INTO available FROM settlement_leg WHERE id = NEW.source_leg_id;
    SELECT coalesce(sum(amount_minor), 0) INTO taken FROM funding_allocation
     WHERE source_leg_id = NEW.source_leg_id AND status IN ('ACTIVE', 'CONSUMED');
  ELSE
    PERFORM 1 FROM route_settlement WHERE id = NEW.source_route_settlement_id FOR UPDATE;
    SELECT amount_minor INTO available FROM route_settlement WHERE id = NEW.source_route_settlement_id;
    SELECT coalesce(sum(amount_minor), 0) INTO taken FROM funding_allocation
     WHERE source_route_settlement_id = NEW.source_route_settlement_id AND status IN ('ACTIVE', 'CONSUMED');
  END IF;
  IF taken > available THEN
    RAISE EXCEPTION 'funding source % earmarked % over the % that arrived', coalesce(NEW.source_leg_id, NEW.source_route_settlement_id), taken, available
      USING ERRCODE = 'IX085';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER funding_allocation_source_total AFTER INSERT OR UPDATE ON funding_allocation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inrp2p_check_funding_source_total();

-- FI-72…74: every outgoing use of a counterparty-funded trade is earmarked in full while it is live, consumed when it
-- is done, and released when it died — at commit, whichever code path wrote the leg or the settlement.
CREATE FUNCTION inrp2p_check_funding_coverage() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  u_leg uuid;
  u_rs uuid;
  u_trade uuid;
  u_amount bigint;
  u_state text;
  needs boolean;
  active_total bigint;
  consumed_total bigint;
  released_live integer;
BEGIN
  IF TG_TABLE_NAME = 'funding_allocation' THEN
    u_leg := NEW.use_leg_id;
    u_rs := NEW.use_route_settlement_id;
  ELSIF TG_TABLE_NAME = 'settlement_leg' THEN
    u_leg := NEW.id;
  ELSE
    u_rs := NEW.id;
  END IF;

  IF u_leg IS NOT NULL THEN
    SELECT l.trade_id, l.amount_minor,
           CASE WHEN l.status IN ('PENDING', 'PROCESSING') THEN 'LIVE' WHEN l.status = 'COMPLETED' THEN 'DONE' ELSE 'DEAD' END,
           (l.side = 'EXCHANGE_TO_CLIENT' AND l.payer = 'EXCHANGE_ACCOUNT') OR l.side = 'REFUND_TO_CLIENT'
      INTO u_trade, u_amount, u_state, needs
      FROM settlement_leg l WHERE l.id = u_leg;
  ELSE
    SELECT o.trade_id, s.amount_minor,
           CASE WHEN s.status = 'RECORDED' THEN 'LIVE' WHEN s.status = 'CONFIRMED' THEN 'DONE' ELSE 'DEAD' END,
           s.flow = 'TO_ROUTE'
      INTO u_trade, u_amount, u_state, needs
      FROM route_settlement s JOIN route_obligation o ON o.id = s.route_obligation_id WHERE s.id = u_rs;
  END IF;
  IF NOT coalesce(needs, false) OR u_trade IS NULL OR NOT inrp2p_trade_is_counterparty_funded(u_trade) THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(sum(amount_minor) FILTER (WHERE status = 'ACTIVE'), 0),
         coalesce(sum(amount_minor) FILTER (WHERE status = 'CONSUMED'), 0)
    INTO active_total, consumed_total
    FROM funding_allocation
   WHERE (u_leg IS NOT NULL AND use_leg_id = u_leg) OR (u_rs IS NOT NULL AND use_route_settlement_id = u_rs);

  IF u_state = 'LIVE' AND (active_total <> u_amount OR consumed_total <> 0) THEN
    RAISE EXCEPTION 'outgoing % of trade % is not funded: % earmarked of %', coalesce(u_leg, u_rs), u_trade, active_total, u_amount USING ERRCODE = 'IX086';
  END IF;
  IF u_state = 'DONE' AND (consumed_total <> u_amount OR active_total <> 0) THEN
    RAISE EXCEPTION 'confirmed outgoing % of trade % consumed % of %', coalesce(u_leg, u_rs), u_trade, consumed_total, u_amount USING ERRCODE = 'IX086';
  END IF;
  IF u_state = 'DEAD' AND (active_total <> 0 OR consumed_total <> 0) THEN
    RAISE EXCEPTION 'cancelled or failed outgoing % of trade % still holds its earmark', coalesce(u_leg, u_rs), u_trade USING ERRCODE = 'IX086';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER settlement_leg_funding_coverage AFTER INSERT OR UPDATE ON settlement_leg
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inrp2p_check_funding_coverage();
CREATE CONSTRAINT TRIGGER route_settlement_funding_coverage AFTER INSERT OR UPDATE ON route_settlement
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inrp2p_check_funding_coverage();
CREATE CONSTRAINT TRIGGER funding_allocation_coverage AFTER INSERT OR UPDATE ON funding_allocation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inrp2p_check_funding_coverage();

-- FI-77, delivery versus payment: the exchange hands a counterparty-funded trade's client funds to the counterparty
-- only once the counterparty delivered — the whole route side of a TO_EXCHANGE obligation, or the client's payout
-- on a DIRECT_TO_CLIENT one (whose margin residual stays receivable, D-14).
CREATE FUNCTION inrp2p_counterparty_delivered(p_obligation uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN o.execution_mode = 'TO_EXCHANGE'
              THEN inrp2p_route_obligation_side(o.id, 'ROUTE_DELIVERS')
                   <= (SELECT coalesce(sum(a.amount_minor), 0) FROM route_settlement_allocation a WHERE a.route_obligation_id = o.id AND a.side = 'ROUTE_DELIVERS')
              ELSE inrp2p_trade_payout_obligation(o.trade_id)
                   <= (SELECT coalesce(sum(l.amount_minor), 0) FROM settlement_leg l WHERE l.trade_id = o.trade_id AND l.side = 'EXCHANGE_TO_CLIENT' AND l.status = 'COMPLETED')
         END
    FROM route_obligation o WHERE o.id = p_obligation
$$;
CREATE FUNCTION inrp2p_guard_route_payment_delivery() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t uuid;
BEGIN
  IF NEW.flow <> 'TO_ROUTE' THEN
    RETURN NEW;
  END IF;
  SELECT trade_id INTO t FROM route_obligation WHERE id = NEW.route_obligation_id;
  IF t IS NOT NULL AND inrp2p_trade_is_counterparty_funded(t) AND NOT inrp2p_counterparty_delivered(NEW.route_obligation_id) THEN
    RAISE EXCEPTION 'the counterparty of trade % has not delivered yet: the exchange does not pay it first', t USING ERRCODE = 'IX087';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER route_settlement_delivery_first BEFORE INSERT ON route_settlement
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_route_payment_delivery();

-- A deposit address holding a counterparty-funded trade's money that is not yet paid on stays out of the pool.
CREATE FUNCTION inrp2p_address_earmarked(p_address text) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(s.amount_minor - coalesce((SELECT sum(f.amount_minor) FROM funding_allocation f
                                                  WHERE (f.source_leg_id = s.source_id OR f.source_route_settlement_id = s.source_id)
                                                    AND f.status IN ('ACTIVE', 'CONSUMED')), 0)), 0)
    FROM funding_source s
   WHERE s.location = 'TRON:' || p_address AND inrp2p_trade_is_counterparty_funded(s.trade_id)
$$;
CREATE FUNCTION inrp2p_guard_address_reuse() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'COOLDOWN' AND NEW.status = 'AVAILABLE' AND inrp2p_address_earmarked(NEW.address) > 0 THEN
    RAISE EXCEPTION 'deposit address % still holds earmarked funds; it does not return to the pool', NEW.address USING ERRCODE = 'IX088';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER deposit_address_reuse_guard BEFORE UPDATE OF status ON deposit_address
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_address_reuse();

GRANT SELECT, INSERT ON trade_funding TO inrp2p_app;
GRANT SELECT ON trade_funding TO inrp2p_readonly;
GRANT SELECT ON funding_source TO inrp2p_app, inrp2p_readonly;
GRANT SELECT, INSERT ON funding_allocation TO inrp2p_app;
GRANT UPDATE (status, closed_by, closed_at, close_reason) ON funding_allocation TO inrp2p_app;
GRANT SELECT ON funding_allocation TO inrp2p_readonly;
GRANT EXECUTE ON FUNCTION inrp2p_trade_is_counterparty_funded(uuid), inrp2p_funding_use_location(uuid, uuid),
  inrp2p_counterparty_delivered(uuid), inrp2p_address_earmarked(text) TO inrp2p_app, inrp2p_readonly;
