-- 0034 audit seals leave the database; restores are proven and remembered (production task E4, TD-16, TD-17).
--
-- 1. `audit_seal_export`: each export writes a contiguous range of seals to write-once storage under Object Lock
--    (outside this database and outside the reach of its credentials) and is recorded here — which seals, which
--    object, the hash of the bytes written. Ranges never overlap and never skip (IX099): a gap is a range nobody can
--    prove, so the database refuses to record one.
-- 2. `audit_archive_verification`: each comparison of the archive with the database — the archive's own chain, the
--    seals here, and the audit events re-hashed against the archived seals — and what it found.
-- 3. `backup_verification`: each restore drill (a dump restored, or a point-in-time recovery) with what it proved and
--    how long it took, so "when was a restore last shown to work" is a fact, not a memory.
-- 4. The restore fence: a restore must not cause a second payout. A database recovered to an earlier moment, failed
--    over to a replica that was behind, or moved to another cluster has forgotten what happened after that moment — a
--    payout marked sent, a reserve application approved — and the desk would show it as still to pay. So the database
--    can say which cluster and timeline it is on, the worker records that with each heartbeat, and when it changes the
--    steps that authorise money to leave the exchange are refused (IX100) until two people have reconciled the records
--    with the bank and the chain and lifted the fence (IX101). Recording what already happened is never refused.
--
-- Error codes IX099–IX101 belong to this migration. 0001–0033 are not edited.

CREATE TABLE audit_seal_export (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  first_seal_id  bigint NOT NULL UNIQUE,
  last_seal_id   bigint NOT NULL UNIQUE,
  from_seq       bigint NOT NULL,
  to_seq         bigint NOT NULL,
  seal_count     integer NOT NULL CHECK (seal_count > 0),
  last_seal_hash text NOT NULL CHECK (last_seal_hash ~ '^[0-9a-f]{64}$'),
  bucket         text NOT NULL,
  object_key     text NOT NULL UNIQUE CHECK (object_key ~ '^audit-seals/v1/[0-9]{12}-[0-9]{12}\.json$'),
  version_id     text,
  sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  retain_until   timestamptz NOT NULL,
  exported_at    timestamptz NOT NULL DEFAULT inrp2p_now(),
  CHECK (last_seal_id >= first_seal_id AND seal_count = last_seal_id - first_seal_id + 1)
);

CREATE FUNCTION inrp2p_guard_audit_seal_export() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  previous bigint;
  first_seal audit_seal%ROWTYPE;
  last_seal audit_seal%ROWTYPE;
BEGIN
  SELECT max(last_seal_id) INTO previous FROM audit_seal_export;
  IF NEW.first_seal_id <> coalesce(previous, 0) + 1 THEN
    RAISE EXCEPTION 'audit seal export must continue at seal %, not %', coalesce(previous, 0) + 1, NEW.first_seal_id USING ERRCODE = 'IX099';
  END IF;
  SELECT * INTO first_seal FROM audit_seal WHERE id = NEW.first_seal_id;
  SELECT * INTO last_seal FROM audit_seal WHERE id = NEW.last_seal_id;
  IF first_seal.id IS NULL OR last_seal.id IS NULL OR NEW.from_seq <> first_seal.from_seq OR NEW.to_seq <> last_seal.to_seq OR NEW.last_seal_hash <> last_seal.seal_hash THEN
    RAISE EXCEPTION 'audit seal export % does not describe seals % to %', NEW.object_key, NEW.first_seal_id, NEW.last_seal_id USING ERRCODE = 'IX099';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER audit_seal_export_guard BEFORE INSERT ON audit_seal_export FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_audit_seal_export();
CREATE TRIGGER audit_seal_export_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_seal_export
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

CREATE TABLE audit_archive_verification (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  ran_at          timestamptz NOT NULL DEFAULT inrp2p_now(),
  ok              boolean NOT NULL,
  archived_seals  integer NOT NULL CHECK (archived_seals >= 0),
  -- Machine-readable findings (`GAP`, `CHAIN_BROKEN`, `SEAL_DIFFERS`, `EVENTS_DIFFER`, `NOT_ARCHIVED`…), never content.
  findings        jsonb NOT NULL DEFAULT '[]'::jsonb,
  CHECK (ok = (findings = '[]'::jsonb))
);
CREATE INDEX audit_archive_verification_ran_idx ON audit_archive_verification (ran_at DESC);
CREATE TRIGGER audit_archive_verification_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_archive_verification
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

CREATE TABLE backup_verification (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  kind               text NOT NULL CHECK (kind IN ('DUMP_RESTORE', 'POINT_IN_TIME')),
  ran_at             timestamptz NOT NULL DEFAULT inrp2p_now(),
  ok                 boolean NOT NULL,
  -- For a point-in-time recovery: the moment recovered to.
  recovered_to       timestamptz,
  restore_seconds    integer CHECK (restore_seconds >= 0),
  environment        text NOT NULL CHECK (length(environment) BETWEEN 1 AND 100),
  findings           jsonb NOT NULL DEFAULT '[]'::jsonb,
  recorded_by        text NOT NULL CHECK (length(recorded_by) BETWEEN 1 AND 200)
);
CREATE INDEX backup_verification_ran_idx ON backup_verification (ran_at DESC);
CREATE TRIGGER backup_verification_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON backup_verification
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

GRANT SELECT, INSERT ON audit_seal_export, audit_archive_verification TO inrp2p_worker;
GRANT SELECT ON audit_seal_export, audit_archive_verification, backup_verification TO inrp2p_app, inrp2p_readonly;

-- ── 4. The restore fence ─────────────────────────────────────────────────────────────────────────────────────────

-- Which cluster and timeline this database is on. A recovery to an earlier moment and a failover each start a new
-- timeline; a dump restored elsewhere, a major upgrade or a move is another cluster. NULL where the platform does not let
-- the application read either — there the restore procedure raises the fence by hand (RUNBOOKS `restore-fence`).
CREATE FUNCTION inrp2p_database_identity() RETURNS jsonb
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  RETURN jsonb_build_object(
    'cluster', (SELECT system_identifier::text FROM pg_control_system()),
    -- The first eight hex digits of a WAL file name are its timeline, and the current file is on the current one.
    'timeline', ('x' || substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8))::bit(32)::integer);
EXCEPTION WHEN insufficient_privilege OR object_not_in_prerequisite_state OR undefined_function THEN
  RETURN NULL;
END
$$;

ALTER TABLE worker_heartbeat ADD COLUMN db_identity jsonb;

CREATE SEQUENCE restore_fence_ref_seq;
CREATE TABLE restore_fence (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  ref             text NOT NULL UNIQUE DEFAULT ('RF-' || inrp2p_ref_number(nextval('restore_fence_ref_seq'), 4)),
  status          text NOT NULL DEFAULT 'RAISED' CHECK (status IN ('RAISED', 'LIFTED')),
  reason          text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  -- The operator's id, or `SYSTEM:worker_heartbeat` when the worker saw the database change.
  raised_by       text NOT NULL CHECK (length(raised_by) BETWEEN 1 AND 100),
  raised_at       timestamptz NOT NULL DEFAULT inrp2p_now(),
  -- What changed, by name only: the cluster identifier and timeline before and after.
  identity_before jsonb,
  identity_after  jsonb,
  -- The last moment the records are known to be whole (the last heartbeat before the change, or the recovery target):
  -- every payment out since then is what people compare with the bank and the chain before lifting the fence.
  known_until     timestamptz,
  lift_id         uuid,
  lifted_by       uuid REFERENCES auth_user (id),
  lifted_at       timestamptz,
  CHECK ((status = 'LIFTED') = (lift_id IS NOT NULL AND lifted_by IS NOT NULL AND lifted_at IS NOT NULL))
);
-- One fence at a time: a second change while one is raised is already covered by it.
CREATE UNIQUE INDEX restore_fence_one_raised ON restore_fence ((true)) WHERE status = 'RAISED';
CREATE TRIGGER restore_fence_status BEFORE UPDATE ON restore_fence
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'RAISED>LIFTED');
CREATE TRIGGER restore_fence_immutable BEFORE UPDATE ON restore_fence
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'lift_id', 'lifted_by', 'lifted_at');
CREATE TRIGGER restore_fence_no_delete BEFORE DELETE OR TRUNCATE ON restore_fence
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

CREATE TABLE restore_fence_lift (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  fence_id        uuid NOT NULL REFERENCES restore_fence (id),
  status          text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'APPROVED', 'DECLINED')),
  -- What was compared and what was found: every payment out since `known_until`, against the bank and the chain.
  reconciliation  text NOT NULL CHECK (length(btrim(reconciliation)) BETWEEN 20 AND 4000),
  requested_by    uuid NOT NULL REFERENCES auth_user (id),
  requested_at    timestamptz NOT NULL DEFAULT inrp2p_now(),
  decided_by      uuid REFERENCES auth_user (id),
  decided_at      timestamptz,
  decision_note   text CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  CHECK ((status = 'REQUESTED') = (decided_by IS NULL AND decided_at IS NULL))
);
CREATE UNIQUE INDEX restore_fence_lift_one_open ON restore_fence_lift (fence_id) WHERE status = 'REQUESTED';
CREATE TRIGGER restore_fence_lift_status BEFORE UPDATE ON restore_fence_lift
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'REQUESTED>APPROVED,REQUESTED>DECLINED');
CREATE TRIGGER restore_fence_lift_immutable BEFORE UPDATE ON restore_fence_lift
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'decided_by', 'decided_at', 'decision_note');
CREATE TRIGGER restore_fence_lift_no_delete BEFORE DELETE OR TRUNCATE ON restore_fence_lift
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- A lift is approved by someone other than the person who reconciled, and only an approved lift opens the fence.
CREATE FUNCTION inrp2p_guard_restore_fence_lift() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lift restore_fence_lift%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'restore_fence_lift' THEN
    IF NEW.status = 'APPROVED' AND NEW.decided_by = NEW.requested_by THEN
      RAISE EXCEPTION 'restore fence lift %: approved by the person who asked for it', NEW.id USING ERRCODE = 'IX101';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'LIFTED' AND OLD.status = 'RAISED' THEN
    SELECT * INTO lift FROM restore_fence_lift WHERE id = NEW.lift_id;
    IF lift.id IS NULL OR lift.fence_id <> NEW.id OR lift.status <> 'APPROVED' OR lift.decided_by <> NEW.lifted_by OR lift.requested_by = NEW.lifted_by THEN
      RAISE EXCEPTION 'restore fence %: lifted only by a second person approving a recorded reconciliation', NEW.ref USING ERRCODE = 'IX101';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER restore_fence_lift_people BEFORE UPDATE ON restore_fence_lift FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_restore_fence_lift();
CREATE TRIGGER restore_fence_lifted_by_approval BEFORE UPDATE ON restore_fence FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_restore_fence_lift();

-- Held while a fence is raised — and from the moment the database changed, before any worker has noticed: the latest
-- heartbeat names one cluster and timeline, the database is on another, and no fence has named the new one yet (a fence
-- names the identity it was raised on, so a change that was fenced and reconciled is not held again).
CREATE FUNCTION inrp2p_payouts_held() RETURNS boolean
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  recorded jsonb;
  current  jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM restore_fence WHERE status = 'RAISED') THEN
    RETURN true;
  END IF;
  SELECT h.db_identity INTO recorded FROM worker_heartbeat h WHERE h.db_identity IS NOT NULL ORDER BY h.beat_at DESC LIMIT 1;
  IF recorded IS NULL THEN
    RETURN false;
  END IF;
  current := inrp2p_database_identity();
  RETURN current IS NOT NULL AND current <> recorded AND NOT EXISTS (SELECT 1 FROM restore_fence f WHERE f.identity_after = current);
END
$$;

-- The two steps that authorise money to leave the exchange: marking an exchange-paid payout or refund leg sent, and
-- approving a reserve application that delivers the trader's reserve. Evidence of what already happened — a UTR, a
-- transaction, a confirmation, a route's own payment — is never held: it is what closes an obligation, and every
-- external reference is unique, so a payment made is never counted twice.
CREATE FUNCTION inrp2p_guard_outgoing_payment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'settlement_leg' THEN
    IF NOT (OLD.status = 'PENDING' AND NEW.status = 'PROCESSING' AND NEW.payer = 'EXCHANGE_ACCOUNT') THEN
      RETURN NEW;
    END IF;
  ELSIF NOT (OLD.status = 'REQUESTED' AND NEW.status = 'APPROVED' AND NEW.kind = 'APPLY') THEN
    RETURN NEW;
  END IF;
  IF inrp2p_payouts_held() THEN
    RAISE EXCEPTION 'outgoing payments are held until the restore fence is lifted: % refused', TG_TABLE_NAME USING ERRCODE = 'IX100';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER settlement_leg_restore_fence BEFORE UPDATE OF status ON settlement_leg
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_outgoing_payment();
CREATE TRIGGER trader_reserve_application_restore_fence BEFORE UPDATE OF status ON trader_reserve_application
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_outgoing_payment();

GRANT SELECT, INSERT ON restore_fence, restore_fence_lift TO inrp2p_app;
GRANT UPDATE (status, lift_id, lifted_by, lifted_at) ON restore_fence TO inrp2p_app;
GRANT UPDATE (status, decided_by, decided_at, decision_note) ON restore_fence_lift TO inrp2p_app;
GRANT USAGE ON SEQUENCE restore_fence_ref_seq TO inrp2p_app;
GRANT SELECT ON restore_fence, restore_fence_lift TO inrp2p_readonly;
GRANT EXECUTE ON FUNCTION inrp2p_database_identity(), inrp2p_payouts_held() TO inrp2p_app, inrp2p_readonly;
