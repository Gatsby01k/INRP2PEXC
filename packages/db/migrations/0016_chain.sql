-- 0016 chain scanning progress (Phase 5; ARCHITECTURE §6 `TronAdapter`, STATE_MACHINES §5).
-- The scanner's only persistent state. Everything it discovers is recorded in `crypto_transfer` (FI-23), so a
-- lost cursor costs a rescan, never a lost or duplicated deposit.

CREATE TABLE chain_cursor (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  network               text NOT NULL CHECK (network IN ('TRON')),
  -- Logical scanner name, e.g. `tron_deposits`. One cursor per (network, scanner).
  scanner               text NOT NULL CHECK (scanner ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- Highest block this scanner has read. Runs rescan a configured overlap below it (reorg tolerance).
  last_scanned_block    bigint NOT NULL CHECK (last_scanned_block >= 0),
  -- Highest solidified (irreversible) block the providers reported at the last run — the finality line (FI-24).
  last_solidified_block bigint NOT NULL DEFAULT 0 CHECK (last_solidified_block >= 0),
  last_run_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT inrp2p_now(),
  updated_at            timestamptz NOT NULL DEFAULT inrp2p_now(),
  UNIQUE (network, scanner)
);

CREATE TRIGGER chain_cursor_immutable BEFORE UPDATE ON chain_cursor
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('last_scanned_block', 'last_solidified_block', 'last_run_at', 'updated_at');

-- A cursor only moves forward. A provider that suddenly reports a lower head is lagging or wrong; rewinding on
-- its word would make the scanner re-emit work and hide a real regression. Backfills widen the rescan overlap
-- instead of rewinding the cursor (TECH_DEBT TD-06).
CREATE FUNCTION inrp2p_guard_chain_cursor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.last_scanned_block < OLD.last_scanned_block THEN
    RAISE EXCEPTION 'chain cursor %/% cannot move backwards (% -> %)', OLD.network, OLD.scanner, OLD.last_scanned_block, NEW.last_scanned_block
      USING ERRCODE = 'IX066';
  END IF;
  NEW.updated_at := inrp2p_now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER chain_cursor_forward BEFORE UPDATE ON chain_cursor
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_chain_cursor();

CREATE TRIGGER chain_cursor_no_delete BEFORE DELETE OR TRUNCATE ON chain_cursor
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

GRANT SELECT, INSERT ON chain_cursor TO inrp2p_app;
GRANT UPDATE (last_scanned_block, last_solidified_block, last_run_at, updated_at) ON chain_cursor TO inrp2p_app;
GRANT SELECT ON chain_cursor TO inrp2p_readonly;
