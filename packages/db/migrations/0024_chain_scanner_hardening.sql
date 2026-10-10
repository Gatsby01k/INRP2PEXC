-- 0024 chain scanner hardening (production task A2/A3, TECH_DEBT TD-06).
--
-- * The cursor records what its last run could prove: the window it read, whether that window was complete, why not
--   and which provider served it. A run that could not read its whole window leaves the cursor at the last block it
--   proved and says so here, instead of the desk inferring it from a growing lag.
-- * `chain_provider_status` is each configured provider's last answer: when it last worked, when it last failed and
--   why, and the heads it reported. Degradation is a fact on the desk's screen, not a line in a worker log.
-- * `chain_backfill` is the audited, step-up way to read a historical range behind the cursor (TD-06): its own
--   progress, the same detection and idempotency as the scanner, and it never rewinds the main cursor.
-- Error codes IX081–IX082 belong to this migration. 0001–0023 are applied and are not edited.

ALTER TABLE chain_cursor ADD COLUMN last_window_from bigint CHECK (last_window_from >= 0);
ALTER TABLE chain_cursor ADD COLUMN last_window_to bigint CHECK (last_window_to >= 0);
ALTER TABLE chain_cursor ADD COLUMN last_complete boolean;
ALTER TABLE chain_cursor ADD COLUMN last_incomplete_reason text CHECK (length(last_incomplete_reason) <= 500);
ALTER TABLE chain_cursor ADD COLUMN last_served_by text CHECK (length(last_served_by) <= 200);
DROP TRIGGER chain_cursor_immutable ON chain_cursor;
CREATE TRIGGER chain_cursor_immutable BEFORE UPDATE ON chain_cursor
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns(
    'last_scanned_block', 'last_solidified_block', 'last_run_at', 'updated_at',
    'last_window_from', 'last_window_to', 'last_complete', 'last_incomplete_reason', 'last_served_by');
GRANT UPDATE (last_window_from, last_window_to, last_complete, last_incomplete_reason, last_served_by) ON chain_cursor TO inrp2p_app;

-- ---------------------------------------------------------------------------------------------------------------
-- Provider status: one row per configured provider, updated after every call the scanner and the balance observer
-- make. Not financial; never a source of facts about money.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE chain_provider_status (
  network              text NOT NULL CHECK (network IN ('TRON')),
  provider             text NOT NULL CHECK (provider ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,60}$'),
  independence_group   text NOT NULL CHECK (independence_group ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,60}$'),
  last_ok_at           timestamptz,
  last_error_at        timestamptz,
  last_error           text CHECK (length(last_error) <= 500),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_head            bigint CHECK (last_head >= 0),
  last_solidified      bigint CHECK (last_solidified >= 0),
  updated_at           timestamptz NOT NULL DEFAULT inrp2p_now(),
  PRIMARY KEY (network, provider)
);
CREATE TRIGGER chain_provider_status_no_delete BEFORE DELETE OR TRUNCATE ON chain_provider_status
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();
GRANT SELECT, INSERT, UPDATE ON chain_provider_status TO inrp2p_app;
GRANT SELECT ON chain_provider_status TO inrp2p_readonly;

-- ---------------------------------------------------------------------------------------------------------------
-- Historical backfill (TD-06). RUNNING ─range read─▶ COMPLETED;  RUNNING ─operator─▶ CANCELLED;  RUNNING ─▶ FAILED.
-- `next_block` is the first block not yet proved read for every listed address, and only moves forward.
-- ---------------------------------------------------------------------------------------------------------------
CREATE SEQUENCE chain_backfill_ref_seq;
CREATE TABLE chain_backfill (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  ref           text NOT NULL UNIQUE DEFAULT ('BF-' || inrp2p_ref_number(nextval('chain_backfill_ref_seq'), 6)),
  network       text NOT NULL CHECK (network IN ('TRON')),
  from_block    bigint NOT NULL CHECK (from_block >= 0),
  to_block      bigint NOT NULL,
  -- Exchange addresses only (deposit addresses and treasury wallets), checked by the command; at most 200.
  addresses     text[] NOT NULL CHECK (cardinality(addresses) BETWEEN 1 AND 200),
  reason        text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  status        text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETED', 'CANCELLED', 'FAILED')),
  next_block    bigint NOT NULL,
  runs          integer NOT NULL DEFAULT 0 CHECK (runs >= 0),
  detected      integer NOT NULL DEFAULT 0 CHECK (detected >= 0),
  already_known integer NOT NULL DEFAULT 0 CHECK (already_known >= 0),
  last_error    text CHECK (length(last_error) <= 500),
  last_run_at   timestamptz,
  requested_by  text NOT NULL,
  requested_at  timestamptz NOT NULL DEFAULT inrp2p_now(),
  closed_by     text,
  closed_at     timestamptz,
  close_reason  text CHECK (length(close_reason) <= 500),
  CHECK (to_block >= from_block),
  -- About 70 days of TRON blocks: a bounded read, not a resync of the chain.
  CHECK (to_block - from_block <= 2000000),
  CHECK (next_block BETWEEN from_block AND to_block + 1),
  CHECK ((status = 'RUNNING') = (closed_at IS NULL)),
  CHECK (status <> 'COMPLETED' OR next_block = to_block + 1),
  CHECK (status NOT IN ('CANCELLED', 'FAILED') OR (closed_by IS NOT NULL AND close_reason IS NOT NULL))
);
-- One backfill per network at a time: it shares the providers' rate limits with the live scanner.
CREATE UNIQUE INDEX chain_backfill_one_running ON chain_backfill (network) WHERE status = 'RUNNING';
CREATE TRIGGER chain_backfill_status BEFORE UPDATE ON chain_backfill
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'RUNNING>COMPLETED,RUNNING>CANCELLED,RUNNING>FAILED');
CREATE TRIGGER chain_backfill_immutable BEFORE UPDATE ON chain_backfill
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns(
    'status', 'next_block', 'runs', 'detected', 'already_known', 'last_error', 'last_run_at', 'closed_by', 'closed_at', 'close_reason');
CREATE FUNCTION inrp2p_guard_chain_backfill() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.next_block <> NEW.from_block OR NEW.status <> 'RUNNING' THEN
      RAISE EXCEPTION 'a backfill starts RUNNING at its first block' USING ERRCODE = 'IX081';
    END IF;
  ELSIF NEW.next_block < OLD.next_block THEN
    RAISE EXCEPTION 'backfill % progress cannot move backwards (% -> %)', OLD.ref, OLD.next_block, NEW.next_block USING ERRCODE = 'IX081';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER chain_backfill_guard BEFORE INSERT OR UPDATE ON chain_backfill
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_chain_backfill();
CREATE TRIGGER chain_backfill_no_delete BEFORE DELETE OR TRUNCATE ON chain_backfill
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

GRANT USAGE ON SEQUENCE chain_backfill_ref_seq TO inrp2p_app;
GRANT SELECT, INSERT ON chain_backfill TO inrp2p_app;
GRANT UPDATE (status, next_block, runs, detected, already_known, last_error, last_run_at, closed_by, closed_at, close_reason) ON chain_backfill TO inrp2p_app;
GRANT SELECT ON chain_backfill TO inrp2p_readonly;
