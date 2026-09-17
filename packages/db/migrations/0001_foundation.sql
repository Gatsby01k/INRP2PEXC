-- 0001 foundation: roles, schema privileges, currency precision, append-only guard.
-- Roles are NOLOGIN group roles; deployments grant them to login users.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inrp2p_app') THEN
    CREATE ROLE inrp2p_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inrp2p_worker') THEN
    CREATE ROLE inrp2p_worker NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inrp2p_readonly') THEN
    CREATE ROLE inrp2p_readonly NOLOGIN;
  END IF;
END
$$;

-- The worker performs everything the app does, plus queue processing.
GRANT inrp2p_app TO inrp2p_worker;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO inrp2p_app, inrp2p_worker, inrp2p_readonly;

-- Central currency precision (FINANCIAL_INVARIANTS §1.1); must match packages/kernel/src/currency.ts.
CREATE TABLE currency (
  code                text PRIMARY KEY CHECK (code ~ '^[A-Z]{3,5}$'),
  minor_unit_exponent smallint NOT NULL CHECK (minor_unit_exponent BETWEEN 0 AND 18)
);
INSERT INTO currency (code, minor_unit_exponent) VALUES ('INR', 2), ('USDT', 6);
GRANT SELECT ON currency TO inrp2p_app, inrp2p_readonly;

-- Append-only guard used by ledger, audit and other immutable tables (FI-41, FI-51).
CREATE FUNCTION inrp2p_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table "%": % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'IX001';
END
$$;

CREATE FUNCTION inrp2p_guard_currency() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'currency precision is immutable (%)', TG_OP USING ERRCODE = 'IX001';
END
$$;
CREATE TRIGGER currency_immutable BEFORE UPDATE OR DELETE ON currency
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_currency();
CREATE TRIGGER currency_no_truncate BEFORE TRUNCATE ON currency
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_guard_currency();
