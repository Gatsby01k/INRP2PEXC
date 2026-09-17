-- 0009 INR settlement entities, exchange INR accounts, per-IST-day capacity and capacity reservations
-- (DOMAIN_MODEL §2.3, FI-30..FI-32, STATE_MACHINES §6).

CREATE TABLE settlement_entity (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  legal_name  text NOT NULL CHECK (length(btrim(legal_name)) BETWEEN 1 AND 200),
  short_name  text NOT NULL UNIQUE CHECK (length(btrim(short_name)) BETWEEN 1 AND 60),
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at  timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE TRIGGER settlement_entity_status BEFORE UPDATE ON settlement_entity
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'ACTIVE>INACTIVE,INACTIVE>ACTIVE');
CREATE TRIGGER settlement_entity_immutable BEFORE UPDATE ON settlement_entity
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'updated_at');

CREATE TABLE inr_settlement_account (
  id                           uuid PRIMARY KEY DEFAULT uuidv7(),
  entity_id                    uuid NOT NULL REFERENCES settlement_entity (id),
  label                        text NOT NULL UNIQUE CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  bank_name                    text NOT NULL CHECK (length(btrim(bank_name)) BETWEEN 1 AND 140),
  ifsc                         text NOT NULL CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  account_number_enc           inrp2p_sealed NOT NULL,
  account_last4                text NOT NULL CHECK (account_last4 ~ '^[0-9]{4}$'),
  account_hmac                 inrp2p_hmac NOT NULL UNIQUE,
  rails                        text[] NOT NULL CHECK (cardinality(rails) >= 1 AND rails <@ ARRAY['IMPS', 'NEFT', 'RTGS', 'UPI']::text[]),
  direction                    text NOT NULL CHECK (direction IN ('PAYOUT', 'COLLECTION', 'BOTH')),
  status                       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'UNAVAILABLE')),
  default_daily_capacity_minor bigint NOT NULL CHECK (default_daily_capacity_minor >= 0),
  notes                        text CHECK (length(notes) <= 2000),
  created_by                   text NOT NULL,
  created_at                   timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at                   timestamptz NOT NULL DEFAULT statement_timestamp(),
  version                      integer NOT NULL DEFAULT 1
);
CREATE INDEX inr_settlement_account_entity_idx ON inr_settlement_account (entity_id);
CREATE TRIGGER inr_settlement_account_status BEFORE UPDATE ON inr_settlement_account
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'ACTIVE>PAUSED,PAUSED>ACTIVE,ACTIVE>UNAVAILABLE,PAUSED>UNAVAILABLE,UNAVAILABLE>ACTIVE,UNAVAILABLE>PAUSED');
CREATE TRIGGER inr_settlement_account_immutable BEFORE UPDATE ON inr_settlement_account
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'default_daily_capacity_minor', 'notes', 'updated_at', 'version');

-- FI-30 concurrency anchor. One row per account per IST calendar day, created lazily from the default.
CREATE TABLE inr_account_day (
  account_id           uuid NOT NULL REFERENCES inr_settlement_account (id),
  day                  date NOT NULL,
  capacity_minor       bigint NOT NULL CHECK (capacity_minor >= 0),
  used_minor           bigint NOT NULL DEFAULT 0 CHECK (used_minor >= 0),
  reserved_minor       bigint NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),
  pending_payout_minor bigint NOT NULL DEFAULT 0 CHECK (pending_payout_minor >= 0),
  created_at           timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at           timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (account_id, day)
);

-- FI-30 at the database: commitments may never *grow* past working capacity. Lowering capacity below
-- existing commitments is allowed (audited command); it only blocks further growth (remaining < 0).
CREATE FUNCTION inrp2p_guard_inr_account_day() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_id <> OLD.account_id OR NEW.day <> OLD.day OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'inr_account_day identity is immutable' USING ERRCODE = 'IX041';
  END IF;
  IF NEW.used_minor + NEW.reserved_minor > NEW.capacity_minor
     AND NEW.used_minor + NEW.reserved_minor > OLD.used_minor + OLD.reserved_minor THEN
    RAISE EXCEPTION 'capacity exceeded for account % on %: used % + reserved % > capacity %',
      NEW.account_id, NEW.day, NEW.used_minor, NEW.reserved_minor, NEW.capacity_minor USING ERRCODE = 'IX030';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER inr_account_day_guard BEFORE UPDATE ON inr_account_day
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_inr_account_day();
CREATE FUNCTION inrp2p_guard_inr_account_day_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.used_minor <> 0 OR NEW.reserved_minor <> 0 OR NEW.pending_payout_minor <> 0 THEN
    RAISE EXCEPTION 'inr_account_day starts with zero commitments' USING ERRCODE = 'IX030';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER inr_account_day_insert BEFORE INSERT ON inr_account_day
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_inr_account_day_insert();
CREATE TRIGGER inr_account_day_no_delete BEFORE DELETE OR TRUNCATE ON inr_account_day
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- Partially consumable reservation (STATE_MACHINES §6). trade_id / route_settlement_id reference tables
-- introduced in Phases 3–4; their foreign keys are added by those migrations.
CREATE TABLE capacity_reservation (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  purpose             text NOT NULL CHECK (purpose IN ('CLIENT_PAYOUT', 'ROUTE_SETTLEMENT')),
  trade_id            uuid,
  route_settlement_id uuid,
  account_id          uuid NOT NULL,
  day                 date NOT NULL,
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  consumed_minor      bigint NOT NULL DEFAULT 0 CHECK (consumed_minor >= 0),
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CONSUMED', 'RELEASED')),
  released_minor      bigint NOT NULL DEFAULT 0 CHECK (released_minor >= 0),
  released_reason     text CHECK (released_reason IN ('TRADE_CANCELLED', 'LEG_CANCELLED', 'LEG_FAILED', 'TRADE_COMPLETED', 'ROUTE_SETTLEMENT_FAILED', 'DAY_ROLLOVER', 'OPERATOR')),
  created_by          text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT statement_timestamp(),
  closed_at           timestamptz,
  FOREIGN KEY (account_id, day) REFERENCES inr_account_day (account_id, day),
  CHECK ((purpose = 'CLIENT_PAYOUT' AND trade_id IS NOT NULL AND route_settlement_id IS NULL)
      OR (purpose = 'ROUTE_SETTLEMENT' AND route_settlement_id IS NOT NULL AND trade_id IS NULL)),
  CHECK (consumed_minor + released_minor <= amount_minor),
  CHECK (status <> 'CONSUMED' OR (consumed_minor = amount_minor AND released_minor = 0 AND closed_at IS NOT NULL)),
  CHECK (status <> 'RELEASED' OR (consumed_minor + released_minor = amount_minor AND released_reason IS NOT NULL AND closed_at IS NOT NULL)),
  CHECK (status <> 'ACTIVE' OR (released_minor = 0 AND released_reason IS NULL AND closed_at IS NULL AND consumed_minor < amount_minor))
);
CREATE INDEX capacity_reservation_day_idx ON capacity_reservation (account_id, day) WHERE status = 'ACTIVE';
CREATE INDEX capacity_reservation_trade_idx ON capacity_reservation (trade_id);
CREATE TRIGGER capacity_reservation_status BEFORE UPDATE ON capacity_reservation
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'ACTIVE>CONSUMED,ACTIVE>RELEASED');
CREATE TRIGGER capacity_reservation_immutable BEFORE UPDATE ON capacity_reservation
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('consumed_minor', 'status', 'released_minor', 'released_reason', 'closed_at');
CREATE FUNCTION inrp2p_guard_reservation_monotonic() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'capacity reservation % is % and final', OLD.id, OLD.status USING ERRCODE = 'IX040';
  END IF;
  IF NEW.consumed_minor < OLD.consumed_minor THEN
    RAISE EXCEPTION 'consumed capacity cannot decrease' USING ERRCODE = 'IX041';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER capacity_reservation_monotonic BEFORE UPDATE ON capacity_reservation
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_reservation_monotonic();
CREATE TRIGGER capacity_reservation_no_delete BEFORE DELETE OR TRUNCATE ON capacity_reservation
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- Day totals must equal their reservations at commit: reserved = Σ open remainder of ACTIVE reservations.
CREATE FUNCTION inrp2p_check_day_reserved() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d_reserved bigint;
  r_open bigint;
BEGIN
  SELECT reserved_minor INTO d_reserved FROM inr_account_day WHERE account_id = NEW.account_id AND day = NEW.day;
  SELECT coalesce(sum(amount_minor - consumed_minor), 0) INTO r_open
    FROM capacity_reservation WHERE account_id = NEW.account_id AND day = NEW.day AND status = 'ACTIVE';
  IF d_reserved IS DISTINCT FROM r_open THEN
    RAISE EXCEPTION 'inr_account_day % % reserved % does not equal open reservations %', NEW.account_id, NEW.day, d_reserved, r_open
      USING ERRCODE = 'IX031';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER capacity_reservation_day_consistent
  AFTER INSERT OR UPDATE ON capacity_reservation DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION inrp2p_check_day_reserved();
CREATE CONSTRAINT TRIGGER inr_account_day_consistent
  AFTER INSERT OR UPDATE ON inr_account_day DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION inrp2p_check_day_reserved();

GRANT SELECT, INSERT ON settlement_entity, inr_settlement_account, inr_account_day, capacity_reservation TO inrp2p_app;
GRANT UPDATE (status, updated_at) ON settlement_entity TO inrp2p_app;
GRANT UPDATE (status, default_daily_capacity_minor, notes, updated_at, version) ON inr_settlement_account TO inrp2p_app;
GRANT UPDATE (capacity_minor, used_minor, reserved_minor, pending_payout_minor, updated_at) ON inr_account_day TO inrp2p_app;
GRANT UPDATE (consumed_minor, status, released_minor, released_reason, closed_at) ON capacity_reservation TO inrp2p_app;
GRANT SELECT ON settlement_entity, inr_account_day, capacity_reservation TO inrp2p_readonly;
GRANT SELECT (id, entity_id, label, bank_name, ifsc, account_last4, rails, direction, status, default_daily_capacity_minor, notes, created_at, updated_at) ON inr_settlement_account TO inrp2p_readonly;
