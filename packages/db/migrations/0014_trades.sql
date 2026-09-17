-- 0014 trades opened by acceptance, frozen economics, route obligations, treasury reservations
-- (DOMAIN_MODEL §2.4, §2.6, §2.8; STATE_MACHINES §3 T1, §9; FI-05, FI-10, FI-33, FI-60).
-- Only acceptance (T1) exists in Phase 3; later transitions are added with their commands in Phase 4.

CREATE SEQUENCE trade_ref_seq;
CREATE SEQUENCE route_obligation_ref_seq;

CREATE TABLE trade (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  ref              text NOT NULL UNIQUE DEFAULT ('IX-' || to_char((inrp2p_now() AT TIME ZONE 'Asia/Kolkata'), 'YYMMDD') || '-' || lpad(nextval('trade_ref_seq')::text, 4, '0')),
  quote_id         uuid NOT NULL UNIQUE REFERENCES quote (id),
  trade_request_id uuid NOT NULL UNIQUE REFERENCES trade_request (id),
  client_id        uuid NOT NULL REFERENCES client (id),
  direction        text NOT NULL CHECK (direction IN ('SELL_USDT', 'BUY_USDT')),
  lifecycle_state  text NOT NULL CHECK (lifecycle_state IN ('AWAITING_FIRST_LEG', 'FIRST_LEG_DETECTED', 'FIRST_LEG_CONFIRMED', 'SETTLING', 'PARTIALLY_SETTLED', 'COMPLETED', 'CANCELLED')),
  hold             boolean NOT NULL DEFAULT false,
  opened_at        timestamptz NOT NULL DEFAULT inrp2p_now(),
  completed_at     timestamptz,
  cancelled_at     timestamptz,
  created_by       text NOT NULL,
  version          integer NOT NULL DEFAULT 1
);
CREATE INDEX trade_client_idx ON trade (client_id, opened_at DESC);
CREATE INDEX trade_active_idx ON trade (lifecycle_state) WHERE lifecycle_state NOT IN ('COMPLETED', 'CANCELLED');
-- D-13: acceptance creates the trade directly in AWAITING_FIRST_LEG.
CREATE FUNCTION inrp2p_guard_trade_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lifecycle_state <> 'AWAITING_FIRST_LEG' OR NEW.hold OR NEW.completed_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'a trade starts in AWAITING_FIRST_LEG without hold' USING ERRCODE = 'IX040';
  END IF;
  IF (SELECT status FROM quote WHERE id = NEW.quote_id) <> 'ACCEPTED' THEN
    RAISE EXCEPTION 'a trade can only be opened from an ACCEPTED quote' USING ERRCODE = 'IX045';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trade_insert_guard BEFORE INSERT ON trade
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_trade_insert();
-- Phase 3 whitelist is empty: no lifecycle transition exists until Phase 4 replaces this trigger.
CREATE TRIGGER trade_status BEFORE UPDATE ON trade
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('lifecycle_state', '');
CREATE TRIGGER trade_immutable BEFORE UPDATE ON trade
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('lifecycle_state', 'hold', 'completed_at', 'cancelled_at', 'version');
CREATE TRIGGER trade_no_delete BEFORE DELETE OR TRUNCATE ON trade
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

CREATE TABLE trade_transition (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trade_id       uuid NOT NULL REFERENCES trade (id),
  from_state     text,
  to_state       text NOT NULL,
  command        text NOT NULL,
  actor          text NOT NULL,
  correlation_id text NOT NULL,
  at             timestamptz NOT NULL DEFAULT inrp2p_now()
);
CREATE INDEX trade_transition_trade_idx ON trade_transition (trade_id, id);
CREATE TRIGGER trade_transition_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON trade_transition
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- FI-10: insert-once frozen terms, copied from the accepted quote in the acceptance transaction.
CREATE TABLE trade_economics (
  trade_id               uuid PRIMARY KEY REFERENCES trade (id),
  direction              text NOT NULL CHECK (direction IN ('SELL_USDT', 'BUY_USDT')),
  fixed_side             text NOT NULL CHECK (fixed_side IN ('BASE', 'QUOTE')),
  base_minor             bigint NOT NULL CHECK (base_minor > 0),
  quote_inr_minor        bigint NOT NULL CHECK (quote_inr_minor > 0),
  client_rate_micro      bigint NOT NULL CHECK (client_rate_micro > 0),
  route_rate_micro       bigint NOT NULL CHECK (route_rate_micro > 0),
  route_value_inr_minor  bigint NOT NULL CHECK (route_value_inr_minor > 0),
  gross_margin_inr_minor bigint NOT NULL,
  route_id               uuid NOT NULL REFERENCES liquidity_route (id),
  route_rate_snapshot_id uuid NOT NULL REFERENCES rate_snapshot (id),
  route_execution_mode   text NOT NULL CHECK (route_execution_mode IN ('DIRECT_TO_CLIENT', 'TO_EXCHANGE')),
  fees_json              jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(fees_json) = 'array'),
  network                text NOT NULL CHECK (network IN ('TRON')),
  bank_account_id        uuid REFERENCES bank_account (id),
  crypto_wallet_id       uuid REFERENCES crypto_wallet (id),
  frozen_at              timestamptz NOT NULL DEFAULT inrp2p_now(),
  CONSTRAINT trade_economics_margin_derived CHECK (
    (direction = 'SELL_USDT' AND gross_margin_inr_minor = route_value_inr_minor - quote_inr_minor)
    OR (direction = 'BUY_USDT' AND gross_margin_inr_minor = quote_inr_minor - route_value_inr_minor))
);
-- Copied values must equal the accepted quote exactly.
CREATE FUNCTION inrp2p_guard_trade_economics_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  q quote%ROWTYPE;
BEGIN
  SELECT quote.* INTO q FROM quote JOIN trade ON trade.quote_id = quote.id WHERE trade.id = NEW.trade_id;
  IF q.direction <> NEW.direction OR q.fixed_side <> NEW.fixed_side OR q.base_minor <> NEW.base_minor OR q.quote_inr_minor <> NEW.quote_inr_minor
     OR q.client_rate_micro <> NEW.client_rate_micro OR q.route_rate_micro <> NEW.route_rate_micro OR q.route_value_inr_minor <> NEW.route_value_inr_minor
     OR q.gross_margin_inr_minor <> NEW.gross_margin_inr_minor OR q.route_id <> NEW.route_id OR q.route_rate_snapshot_id <> NEW.route_rate_snapshot_id
     OR q.network <> NEW.network OR q.bank_account_id IS DISTINCT FROM NEW.bank_account_id OR q.crypto_wallet_id IS DISTINCT FROM NEW.crypto_wallet_id THEN
    RAISE EXCEPTION 'trade economics for % do not equal the accepted quote', NEW.trade_id USING ERRCODE = 'IX045';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trade_economics_insert BEFORE INSERT ON trade_economics
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_trade_economics_insert();
CREATE TRIGGER trade_economics_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON trade_economics
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- D-03 PER_TRADE obligation: frozen at acceptance, recognized by trade:{t}:accept (FI-60).
CREATE TABLE route_obligation (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  ref                     text NOT NULL UNIQUE DEFAULT ('RO-' || lpad(nextval('route_obligation_ref_seq')::text, 6, '0')),
  route_id                uuid NOT NULL REFERENCES liquidity_route (id),
  trade_id                uuid UNIQUE REFERENCES trade (id),
  direction               text NOT NULL CHECK (direction IN ('SELL_USDT', 'BUY_USDT')),
  exchange_delivers_asset text NOT NULL CHECK (exchange_delivers_asset IN ('USDT', 'INR')),
  exchange_delivers_minor bigint NOT NULL CHECK (exchange_delivers_minor > 0),
  route_delivers_asset    text NOT NULL CHECK (route_delivers_asset IN ('USDT', 'INR')),
  route_delivers_minor    bigint NOT NULL CHECK (route_delivers_minor > 0),
  settlement_model        text NOT NULL CHECK (settlement_model = 'PER_TRADE'),
  execution_mode          text NOT NULL CHECK (execution_mode IN ('DIRECT_TO_CLIENT', 'TO_EXCHANGE')),
  status                  text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'PARTIALLY_SETTLED', 'SETTLED', 'CANCELLED')),
  opened_at               timestamptz NOT NULL DEFAULT inrp2p_now(),
  settled_at              timestamptz,
  cancelled_at            timestamptz,
  created_by              text NOT NULL,
  CHECK ((direction = 'SELL_USDT' AND exchange_delivers_asset = 'USDT' AND route_delivers_asset = 'INR')
      OR (direction = 'BUY_USDT' AND exchange_delivers_asset = 'INR' AND route_delivers_asset = 'USDT')),
  CHECK (settlement_model <> 'PER_TRADE' OR trade_id IS NOT NULL)
);
CREATE INDEX route_obligation_route_idx ON route_obligation (route_id, status);
CREATE FUNCTION inrp2p_guard_route_obligation_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  e trade_economics%ROWTYPE;
BEGIN
  IF NEW.status <> 'OPEN' THEN
    RAISE EXCEPTION 'a route obligation starts OPEN' USING ERRCODE = 'IX040';
  END IF;
  SELECT * INTO e FROM trade_economics WHERE trade_id = NEW.trade_id;
  IF e.trade_id IS NULL OR e.route_id <> NEW.route_id OR e.direction <> NEW.direction OR e.route_execution_mode <> NEW.execution_mode
     OR (NEW.direction = 'SELL_USDT' AND (NEW.exchange_delivers_minor <> e.base_minor OR NEW.route_delivers_minor <> e.route_value_inr_minor))
     OR (NEW.direction = 'BUY_USDT' AND (NEW.exchange_delivers_minor <> e.route_value_inr_minor OR NEW.route_delivers_minor <> e.base_minor)) THEN
    RAISE EXCEPTION 'route obligation does not equal the frozen trade economics' USING ERRCODE = 'IX045';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER route_obligation_insert BEFORE INSERT ON route_obligation
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_route_obligation_insert();
-- Phase 3: no transitions yet (allocation and cancellation arrive in Phase 4).
CREATE TRIGGER route_obligation_status BEFORE UPDATE ON route_obligation
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', '');
CREATE TRIGGER route_obligation_immutable BEFORE UPDATE ON route_obligation
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'settled_at', 'cancelled_at');
CREATE TRIGGER route_obligation_no_delete BEFORE DELETE OR TRUNCATE ON route_obligation
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- FI-33: BUY trades in TO_EXCHANGE mode reserve treasury USDT at acceptance; released exactly once later.
CREATE TABLE treasury_reservation (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  treasury_wallet_id uuid NOT NULL REFERENCES treasury_wallet (id),
  trade_id           uuid NOT NULL UNIQUE REFERENCES trade (id),
  amount_minor       bigint NOT NULL CHECK (amount_minor > 0),
  consumed_minor     bigint NOT NULL DEFAULT 0 CHECK (consumed_minor >= 0),
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CONSUMED', 'RELEASED')),
  released_reason    text CHECK (released_reason IN ('TRADE_CANCELLED', 'TRADE_COMPLETED', 'OPERATOR')),
  created_by         text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT inrp2p_now(),
  closed_at          timestamptz,
  CHECK (consumed_minor <= amount_minor),
  CHECK ((status = 'ACTIVE') = (closed_at IS NULL)),
  CHECK ((status = 'RELEASED') = (released_reason IS NOT NULL))
);
CREATE TRIGGER treasury_reservation_status BEFORE UPDATE ON treasury_reservation
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'ACTIVE>CONSUMED,ACTIVE>RELEASED');
CREATE TRIGGER treasury_reservation_immutable BEFORE UPDATE ON treasury_reservation
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('consumed_minor', 'status', 'released_reason', 'closed_at');
CREATE TRIGGER treasury_reservation_no_delete BEFORE DELETE OR TRUNCATE ON treasury_reservation
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();
-- FI-33 at the database: a wallet's reserved total may not grow beyond its observed balance.
CREATE FUNCTION inrp2p_guard_treasury_reserved() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reserved_minor > NEW.observed_balance_minor AND NEW.reserved_minor > OLD.reserved_minor THEN
    RAISE EXCEPTION 'treasury wallet % reserved % exceeds observed %', NEW.id, NEW.reserved_minor, NEW.observed_balance_minor USING ERRCODE = 'IX032';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER treasury_wallet_reserved_guard BEFORE UPDATE ON treasury_wallet
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_treasury_reserved();
CREATE FUNCTION inrp2p_check_treasury_reserved() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  w_id uuid;
  w_reserved bigint;
  open_total bigint;
BEGIN
  IF TG_TABLE_NAME = 'treasury_wallet' THEN
    w_id := NEW.id;
  ELSE
    w_id := NEW.treasury_wallet_id;
  END IF;
  SELECT reserved_minor INTO w_reserved FROM treasury_wallet WHERE id = w_id;
  SELECT coalesce(sum(amount_minor - consumed_minor), 0) INTO open_total FROM treasury_reservation WHERE treasury_wallet_id = w_id AND status = 'ACTIVE';
  IF w_reserved <> open_total THEN
    RAISE EXCEPTION 'treasury wallet % reserved % does not equal open reservations %', w_id, w_reserved, open_total USING ERRCODE = 'IX033';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER treasury_reservation_wallet_consistent AFTER INSERT OR UPDATE ON treasury_reservation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inrp2p_check_treasury_reserved();
CREATE CONSTRAINT TRIGGER treasury_wallet_reserved_consistent AFTER UPDATE OF reserved_minor ON treasury_wallet
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inrp2p_check_treasury_reserved();

-- Foreign keys deferred in Phase 2 now that the trade table exists.
ALTER TABLE deposit_assignment ADD CONSTRAINT deposit_assignment_trade_fk FOREIGN KEY (trade_id) REFERENCES trade (id);
ALTER TABLE capacity_reservation ADD CONSTRAINT capacity_reservation_trade_fk FOREIGN KEY (trade_id) REFERENCES trade (id);

GRANT USAGE ON SEQUENCE trade_ref_seq, route_obligation_ref_seq TO inrp2p_app;
GRANT SELECT, INSERT ON trade, trade_transition, trade_economics, route_obligation, treasury_reservation TO inrp2p_app;
GRANT UPDATE (lifecycle_state, hold, completed_at, cancelled_at, version) ON trade TO inrp2p_app;
GRANT UPDATE (status, settled_at, cancelled_at) ON route_obligation TO inrp2p_app;
GRANT UPDATE (consumed_minor, status, released_reason, closed_at) ON treasury_reservation TO inrp2p_app;
GRANT SELECT ON trade, trade_transition, trade_economics, route_obligation, treasury_reservation TO inrp2p_readonly;
