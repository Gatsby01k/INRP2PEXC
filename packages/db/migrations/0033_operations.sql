-- 0033 operations: pausing new business, the worker's heartbeat, and the schema version readiness reads
-- (production task E3).
--
-- 1. New business can be paused and resumed on the record (OWNER or FINANCE, with step-up and a reason): while paused,
--    no request is opened, no quote is sent, no quote becomes a trade and no trader is offered an order — whatever code
--    tries (IX098). Everything already started goes on: payouts, deliveries, refunds and confirmations are not touched,
--    so no confirmed money is ever left without a visible obligation. The latest row is in force; no row is OPEN.
-- 2. The worker records a heartbeat each minute (and a summary of what it runs — provider names and states, never a
--    secret), so readiness can tell a stopped worker from a quiet one.
-- 3. The application may learn which migration the database is at — the number only, through a function; the
--    migration table itself stays out of its reach — so a process refuses to serve a schema it was not built for.
--
-- Error code IX098 belongs to this migration. 0001–0032 are not edited.

CREATE TABLE trading_control (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  new_business  text NOT NULL CHECK (new_business IN ('OPEN', 'PAUSED')),
  reason        text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  -- The operator's id, or `SYSTEM:<what>` when the system itself paused it.
  set_by        text NOT NULL CHECK (length(set_by) BETWEEN 1 AND 100),
  set_at        timestamptz NOT NULL DEFAULT inrp2p_now()
);
CREATE INDEX trading_control_latest_idx ON trading_control (set_at DESC, id DESC);
CREATE TRIGGER trading_control_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON trading_control
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

CREATE FUNCTION inrp2p_new_business_paused() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT c.new_business = 'PAUSED' FROM trading_control c ORDER BY c.set_at DESC, c.id DESC LIMIT 1), false)
$$;

CREATE FUNCTION inrp2p_guard_new_business() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- A quote's only gate is being sent; every other table here is guarded on insert (where OLD does not exist).
  IF TG_TABLE_NAME = 'quote' THEN
    IF NOT (OLD.status = 'DRAFT' AND NEW.status = 'SENT') THEN
      RETURN NEW;
    END IF;
  END IF;
  IF inrp2p_new_business_paused() THEN
    RAISE EXCEPTION 'new business is paused: % refused', TG_TABLE_NAME USING ERRCODE = 'IX098';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trade_request_new_business BEFORE INSERT ON trade_request FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_new_business();
CREATE TRIGGER quote_new_business BEFORE UPDATE ON quote FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_new_business();
CREATE TRIGGER trade_new_business BEFORE INSERT ON trade FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_new_business();
CREATE TRIGGER trader_order_new_business BEFORE INSERT ON trader_order FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_new_business();

GRANT SELECT, INSERT ON trading_control TO inrp2p_app;
GRANT SELECT ON trading_control TO inrp2p_readonly;
GRANT EXECUTE ON FUNCTION inrp2p_new_business_paused() TO inrp2p_app, inrp2p_readonly;

CREATE TABLE worker_heartbeat (
  worker_id   text PRIMARY KEY CHECK (length(worker_id) BETWEEN 1 AND 100),
  started_at  timestamptz NOT NULL,
  beat_at     timestamptz NOT NULL,
  release     text CHECK (length(release) <= 100),
  -- What the worker runs, by name and state only: never a credential, an address or a key.
  config      jsonb NOT NULL DEFAULT '{}'::jsonb
);
GRANT SELECT, INSERT, UPDATE ON worker_heartbeat TO inrp2p_app;
GRANT SELECT ON worker_heartbeat TO inrp2p_readonly;

CREATE FUNCTION inrp2p_schema_version() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT max(version) FROM schema_migration
$$;
REVOKE ALL ON FUNCTION inrp2p_schema_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inrp2p_schema_version() TO inrp2p_app, inrp2p_readonly;
