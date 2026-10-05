-- 0027 approvals (production task C1, C2 / TD-20).
--
-- C1. SECURITY §4: above a threshold (default ₹2,500,000 per leg) the person who marked a payout sent does not confirm
--     it. Until now nothing recorded who sent a leg, so nothing could enforce it. The sender and the confirmer are
--     recorded from the command's verified actor, and the database refuses a confirmation that breaks the rule. The
--     threshold is a protected, audited setting (append-only history; the latest row is in force).
-- C2. Granting OWNER while two or more OWNERs are active is requested by one OWNER and approved by another, each in
--     their own session — never by naming an approver in a payload. The application can neither create the first
--     OWNER (that is the protected bootstrap procedure, run with infrastructure credentials) nor remove one.
--
-- Error codes IX090–IX091 belong to this migration. 0001–0026 are not edited.

-- ── C1: who sent a payout, who confirmed it ─────────────────────────────────────────────────────────────────────
ALTER TABLE settlement_leg
  ADD COLUMN sent_by text CHECK (sent_by IS NULL OR length(sent_by) BETWEEN 1 AND 100),
  ADD COLUMN confirmed_by text CHECK (confirmed_by IS NULL OR length(confirmed_by) BETWEEN 1 AND 100);
-- Legs sent before this migration keep sent_by NULL: their sender was never recorded and none is invented. For such a
-- leg the second-person rule below falls back to the person who created it — the only person the record names.

DROP TRIGGER settlement_leg_immutable ON settlement_leg;
CREATE TRIGGER settlement_leg_immutable BEFORE UPDATE ON settlement_leg
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns(
    'status', 'capacity_reservation_id', 'notes', 'sent_at', 'confirmed_at', 'failed_at', 'cancelled_at', 'failure_reason', 'sent_by', 'confirmed_by');
GRANT UPDATE (sent_by, confirmed_by) ON settlement_leg TO inrp2p_app;

CREATE TABLE payout_approval_policy (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  enabled             boolean NOT NULL,
  -- INR paise. A leg whose INR value is strictly above it needs a second person.
  threshold_inr_minor bigint NOT NULL CHECK (threshold_inr_minor >= 0),
  reason              text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  set_by              text NOT NULL CHECK (length(set_by) BETWEEN 1 AND 100),
  set_at              timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE TRIGGER payout_approval_policy_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON payout_approval_policy
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();
INSERT INTO payout_approval_policy (enabled, threshold_inr_minor, reason, set_by)
VALUES (true, 250000000, 'SECURITY §4 default: above ₹2,500,000 per leg the sender does not confirm', 'MIGRATION:0027');

-- A leg's value in INR paise: an INR leg's own amount; a USDT leg at the trade's frozen client rate (exact, unrounded).
CREATE FUNCTION inrp2p_leg_inr_value(p_trade uuid, p_asset text, p_amount_minor bigint) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_asset = 'INR' THEN p_amount_minor::numeric
              ELSE p_amount_minor::numeric * e.client_rate_micro::numeric / 10000000000 END
    FROM trade_economics e WHERE e.trade_id = p_trade
$$;

CREATE FUNCTION inrp2p_payout_needs_second_person(p_trade uuid, p_asset text, p_amount_minor bigint) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT p.enabled AND inrp2p_leg_inr_value(p_trade, p_asset, p_amount_minor) > p.threshold_inr_minor
                     FROM payout_approval_policy p ORDER BY p.set_at DESC, p.id DESC LIMIT 1), true)
$$;

CREATE FUNCTION inrp2p_guard_payout_people() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.side <> 'EXCHANGE_TO_CLIENT' THEN
    RETURN NEW;
  END IF;
  IF OLD.sent_by IS NOT NULL AND NEW.sent_by IS DISTINCT FROM OLD.sent_by THEN
    RAISE EXCEPTION 'payout % was sent by %; that does not change', NEW.ref, OLD.sent_by USING ERRCODE = 'IX090';
  END IF;
  IF OLD.confirmed_by IS NOT NULL AND NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by THEN
    RAISE EXCEPTION 'payout % was confirmed by %; that does not change', NEW.ref, OLD.confirmed_by USING ERRCODE = 'IX090';
  END IF;
  IF OLD.status = 'PENDING' AND NEW.status = 'PROCESSING' AND NEW.sent_by IS NULL THEN
    RAISE EXCEPTION 'payout % is sent by someone, and the record says who', NEW.ref USING ERRCODE = 'IX090';
  END IF;
  IF NEW.status = 'COMPLETED' AND OLD.status <> 'COMPLETED' THEN
    IF NEW.confirmed_by IS NULL THEN
      RAISE EXCEPTION 'payout % is confirmed by someone, and the record says who', NEW.ref USING ERRCODE = 'IX090';
    END IF;
    IF inrp2p_payout_needs_second_person(NEW.trade_id, NEW.asset, NEW.amount_minor) THEN
      IF NEW.confirmed_by LIKE 'SYSTEM%' THEN
        RAISE EXCEPTION 'payout % is above the approval threshold: a person confirms it, not the system', NEW.ref USING ERRCODE = 'IX090';
      END IF;
      IF NEW.confirmed_by = coalesce(NEW.sent_by, NEW.created_by) THEN
        RAISE EXCEPTION 'payout % is above the approval threshold: the person who sent it does not confirm it', NEW.ref USING ERRCODE = 'IX090';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER settlement_leg_payout_people BEFORE UPDATE ON settlement_leg
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_payout_people();

GRANT SELECT, INSERT ON payout_approval_policy TO inrp2p_app;
GRANT SELECT ON payout_approval_policy TO inrp2p_readonly;
GRANT EXECUTE ON FUNCTION inrp2p_leg_inr_value(uuid, text, bigint), inrp2p_payout_needs_second_person(uuid, text, bigint) TO inrp2p_app, inrp2p_readonly;

-- ── C2: OWNER grants ─────────────────────────────────────────────────────────────────────────────────────────────
-- True for a connection of the application or the worker; false for the infrastructure role that runs migrations and
-- the protected operator procedures (and for a superuser).
CREATE FUNCTION inrp2p_is_application_session() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT NOT coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = session_user), false)
         AND pg_has_role(session_user, 'inrp2p_app', 'MEMBER')
$$;

CREATE SEQUENCE operator_role_request_ref_seq;
CREATE TABLE operator_role_request (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  ref                  text NOT NULL UNIQUE DEFAULT ('RR-' || inrp2p_ref_number(nextval('operator_role_request_ref_seq'), 4)),
  target_user_id       uuid NOT NULL REFERENCES auth_user (id),
  role_code            text NOT NULL CHECK (role_code = 'OWNER'),
  reason               text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  status               text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED')),
  requested_by         uuid NOT NULL REFERENCES auth_user (id),
  requested_session_id uuid NOT NULL,
  requested_at         timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at           timestamptz NOT NULL,
  decided_by           uuid REFERENCES auth_user (id),
  decided_session_id   uuid,
  decided_at           timestamptz,
  decision_note        text CHECK (length(decision_note) <= 500),
  -- The transaction that approved it: the grant must happen in that same transaction (IX091).
  approved_xact        xid8,
  CHECK (target_user_id <> requested_by),
  CHECK (expires_at > requested_at),
  CHECK ((status = 'PENDING') = (decided_at IS NULL)),
  CHECK (status IN ('PENDING', 'EXPIRED') OR (decided_by IS NOT NULL AND decided_session_id IS NOT NULL)),
  CHECK (status NOT IN ('APPROVED', 'REJECTED') OR (decided_by <> requested_by AND decided_by <> target_user_id)),
  CHECK (status <> 'CANCELLED' OR decided_by = requested_by),
  CHECK ((status = 'APPROVED') = (approved_xact IS NOT NULL))
);
CREATE UNIQUE INDEX operator_role_request_one_pending ON operator_role_request (target_user_id, role_code) WHERE status = 'PENDING';
CREATE TRIGGER operator_role_request_status BEFORE UPDATE ON operator_role_request
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'PENDING>APPROVED,PENDING>REJECTED,PENDING>CANCELLED,PENDING>EXPIRED');
CREATE TRIGGER operator_role_request_immutable BEFORE UPDATE ON operator_role_request
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'decided_by', 'decided_session_id', 'decided_at', 'decision_note', 'approved_xact');
CREATE TRIGGER operator_role_request_no_delete BEFORE DELETE OR TRUNCATE ON operator_role_request
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- What the application may do with the OWNER role (SECURITY §3):
-- - create the first OWNER: never — that is the bootstrap procedure;
-- - grant OWNER while exactly one OWNER is active: only that OWNER, to someone else (single-OWNER mode, audited);
-- - grant OWNER while two or more are active: only in the transaction that approved a request for it, as requested;
-- - remove an OWNER: never — that is the protected procedure too, so the count cannot be lowered to slip a grant.
CREATE FUNCTION inrp2p_guard_owner_role() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owners integer;
  sole uuid;
BEGIN
  IF NOT inrp2p_is_application_session() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.role_code = 'OWNER' THEN
      RAISE EXCEPTION 'an OWNER is removed by the protected operator procedure, not by the application' USING ERRCODE = 'IX091';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.role_code = 'OWNER' OR OLD.role_code = 'OWNER') THEN
    RAISE EXCEPTION 'an OWNER role row does not change' USING ERRCODE = 'IX091';
  END IF;
  IF NEW.role_code <> 'OWNER' THEN
    RETURN NEW;
  END IF;
  IF NEW.granted_by IS NULL OR NEW.granted_by = NEW.user_id THEN
    RAISE EXCEPTION 'nobody grants themselves OWNER, and every grant names who made it' USING ERRCODE = 'IX091';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('inrp2p.operator_roles'));
  SELECT count(*), min(r.user_id::text)::uuid INTO owners, sole
    FROM operator_user_role r JOIN auth_user u ON u.id = r.user_id
   WHERE r.role_code = 'OWNER' AND u.status = 'ACTIVE' AND r.user_id <> NEW.user_id;
  IF owners = 0 THEN
    RAISE EXCEPTION 'the first OWNER is created by the bootstrap procedure, not by the application' USING ERRCODE = 'IX091';
  ELSIF owners = 1 THEN
    IF NEW.granted_by <> sole THEN
      RAISE EXCEPTION 'with one OWNER, only that OWNER grants OWNER' USING ERRCODE = 'IX091';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM operator_role_request q
     WHERE q.target_user_id = NEW.user_id AND q.role_code = 'OWNER' AND q.status = 'APPROVED'
       AND q.requested_by = NEW.granted_by AND q.approved_xact = pg_current_xact_id()
  ) THEN
    RAISE EXCEPTION 'granting OWNER needs another OWNER''s approval, given in their own session' USING ERRCODE = 'IX091';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER operator_user_role_owner_guard BEFORE INSERT OR UPDATE OR DELETE ON operator_user_role
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_owner_role();

GRANT SELECT, INSERT ON operator_role_request TO inrp2p_app;
GRANT UPDATE (status, decided_by, decided_session_id, decided_at, decision_note, approved_xact) ON operator_role_request TO inrp2p_app;
GRANT SELECT ON operator_role_request TO inrp2p_readonly;
GRANT USAGE ON SEQUENCE operator_role_request_ref_seq TO inrp2p_app;
GRANT EXECUTE ON FUNCTION inrp2p_is_application_session() TO inrp2p_app, inrp2p_readonly;
