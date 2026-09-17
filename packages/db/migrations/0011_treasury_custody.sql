-- 0011 treasury wallets, custody provider capability, unique per-trade deposit addresses
-- (DOMAIN_MODEL §2.8, D-02, FI-26, STATE_MACHINES §11). No key material is stored anywhere.

CREATE TABLE treasury_wallet (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  network                text NOT NULL CHECK (network IN ('TRON')),
  address                inrp2p_tron_address NOT NULL,
  label                  text NOT NULL UNIQUE CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  role                   text NOT NULL CHECK (role IN ('HOT', 'COLD', 'DEPOSIT_POOL')),
  status                 text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'RETIRED')),
  custody                text NOT NULL DEFAULT 'EXTERNAL' CHECK (custody IN ('EXTERNAL')),
  observed_balance_minor bigint NOT NULL DEFAULT 0 CHECK (observed_balance_minor >= 0),
  observed_at            timestamptz,
  reserved_minor         bigint NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),
  created_by             text NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at             timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (network, address)
);
CREATE TRIGGER treasury_wallet_status BEFORE UPDATE ON treasury_wallet
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'ACTIVE>PAUSED,PAUSED>ACTIVE,ACTIVE>RETIRED,PAUSED>RETIRED');
CREATE TRIGGER treasury_wallet_immutable BEFORE UPDATE ON treasury_wallet
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'observed_balance_minor', 'observed_at', 'reserved_minor', 'updated_at');

-- Recorded result of the D-02 gate. Append-only history; the current capability per network is the latest row.
CREATE TABLE custody_provider_config (
  id                         uuid PRIMARY KEY DEFAULT uuidv7(),
  provider                   text NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9_-]{1,40}$'),
  network                    text NOT NULL CHECK (network IN ('TRON')),
  deposit_address_capability text NOT NULL CHECK (deposit_address_capability IN ('DERIVED', 'POOL', 'UNSUPPORTED')),
  consolidation_notes        text CHECK (length(consolidation_notes) <= 4000),
  verified_by                text NOT NULL,
  verified_at                timestamptz NOT NULL DEFAULT statement_timestamp(),
  notes                      text CHECK (length(notes) <= 4000),
  CHECK (deposit_address_capability = 'UNSUPPORTED' OR consolidation_notes IS NOT NULL)
);
CREATE INDEX custody_provider_config_current_idx ON custody_provider_config (network, verified_at DESC, id DESC);
CREATE TRIGGER custody_provider_config_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON custody_provider_config
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

CREATE TABLE deposit_address (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  treasury_wallet_id uuid NOT NULL REFERENCES treasury_wallet (id),
  network            text NOT NULL CHECK (network IN ('TRON')),
  address            inrp2p_tron_address NOT NULL,
  source             text NOT NULL CHECK (source IN ('DERIVED', 'POOL')),
  provider           text NOT NULL,
  -- Provider id or derivation index. Never key material.
  custody_reference  text NOT NULL CHECK (length(custody_reference) BETWEEN 1 AND 200),
  status             text NOT NULL CHECK (status IN ('AVAILABLE', 'ASSIGNED', 'COOLDOWN', 'RETIRED')),
  cooldown_until     timestamptz,
  created_by         text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at         timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (network, address),
  UNIQUE (provider, custody_reference),
  CHECK ((status = 'COOLDOWN') = (cooldown_until IS NOT NULL)),
  -- Derived addresses are born assigned and never return to the pool.
  CHECK (source = 'POOL' OR status <> 'AVAILABLE')
);
CREATE INDEX deposit_address_available_idx ON deposit_address (network, created_at, id) WHERE status = 'AVAILABLE';
CREATE INDEX deposit_address_cooldown_idx ON deposit_address (cooldown_until) WHERE status = 'COOLDOWN';
CREATE TRIGGER deposit_address_status BEFORE UPDATE ON deposit_address
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'AVAILABLE>ASSIGNED,ASSIGNED>COOLDOWN,COOLDOWN>AVAILABLE,COOLDOWN>RETIRED,AVAILABLE>RETIRED');
CREATE TRIGGER deposit_address_immutable BEFORE UPDATE ON deposit_address
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'cooldown_until', 'updated_at');
CREATE FUNCTION inrp2p_guard_deposit_address_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.source = 'POOL' AND NEW.status <> 'AVAILABLE') OR (NEW.source = 'DERIVED' AND NEW.status <> 'ASSIGNED') THEN
    RAISE EXCEPTION 'new % deposit address must start %', NEW.source, CASE NEW.source WHEN 'POOL' THEN 'AVAILABLE' ELSE 'ASSIGNED' END
      USING ERRCODE = 'IX040';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER deposit_address_insert BEFORE INSERT ON deposit_address
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_deposit_address_insert();
CREATE TRIGGER deposit_address_no_delete BEFORE DELETE OR TRUNCATE ON deposit_address
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- The only mechanism attributing client USDT to a trade (D-02, FI-26). trade_id FK is added with the trade table (Phase 3).
CREATE TABLE deposit_assignment (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  deposit_address_id    uuid NOT NULL REFERENCES deposit_address (id),
  trade_id              uuid NOT NULL UNIQUE,
  expected_amount_minor bigint NOT NULL CHECK (expected_amount_minor > 0),
  assigned_at           timestamptz NOT NULL DEFAULT statement_timestamp(),
  released_at           timestamptz,
  release_reason        text CHECK (release_reason IN ('TRADE_COMPLETED', 'TRADE_CANCELLED')),
  created_by            text NOT NULL,
  CHECK ((released_at IS NULL) = (release_reason IS NULL))
);
CREATE UNIQUE INDEX deposit_assignment_one_open_per_address ON deposit_assignment (deposit_address_id) WHERE released_at IS NULL;
CREATE TRIGGER deposit_assignment_immutable BEFORE UPDATE ON deposit_assignment
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('released_at', 'release_reason');
CREATE FUNCTION inrp2p_guard_deposit_assignment_release() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'deposit assignment % is already released', OLD.id USING ERRCODE = 'IX040';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER deposit_assignment_release_once BEFORE UPDATE ON deposit_assignment
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_deposit_assignment_release();
CREATE TRIGGER deposit_assignment_no_delete BEFORE DELETE OR TRUNCATE ON deposit_assignment
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- Address status and its open assignment must agree at commit: ASSIGNED ⇔ exactly one open assignment.
CREATE FUNCTION inrp2p_check_deposit_address_assignment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  addr_id uuid;
  a_status text;
  open_count bigint;
BEGIN
  IF TG_TABLE_NAME = 'deposit_address' THEN
    addr_id := NEW.id;
  ELSE
    addr_id := NEW.deposit_address_id;
  END IF;
  SELECT status INTO a_status FROM deposit_address WHERE id = addr_id;
  SELECT count(*) INTO open_count FROM deposit_assignment WHERE deposit_address_id = addr_id AND released_at IS NULL;
  IF (a_status = 'ASSIGNED') <> (open_count = 1) THEN
    RAISE EXCEPTION 'deposit address % is % with % open assignment(s)', addr_id, a_status, open_count USING ERRCODE = 'IX043';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER deposit_address_assignment_consistent
  AFTER INSERT OR UPDATE ON deposit_address DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION inrp2p_check_deposit_address_assignment();
CREATE CONSTRAINT TRIGGER deposit_assignment_address_consistent
  AFTER INSERT OR UPDATE ON deposit_assignment DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION inrp2p_check_deposit_address_assignment();

GRANT SELECT, INSERT ON treasury_wallet, custody_provider_config, deposit_address, deposit_assignment TO inrp2p_app;
GRANT UPDATE (status, observed_balance_minor, observed_at, reserved_minor, updated_at) ON treasury_wallet TO inrp2p_app;
GRANT UPDATE (status, cooldown_until, updated_at) ON deposit_address TO inrp2p_app;
GRANT UPDATE (released_at, release_reason) ON deposit_assignment TO inrp2p_app;
GRANT SELECT ON treasury_wallet, custody_provider_config, deposit_address, deposit_assignment TO inrp2p_readonly;
