-- 0003 append-only audit with hash-chain sealing (FI-51, SECURITY §8).
CREATE TABLE audit_event (
  seq             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id              uuid NOT NULL DEFAULT uuidv7() UNIQUE,
  at              timestamptz NOT NULL DEFAULT statement_timestamp(),
  actor_type      text NOT NULL CHECK (actor_type IN ('USER', 'SYSTEM', 'CLIENT_LINK')),
  actor_id        text,
  surface         text NOT NULL CHECK (surface IN ('OPERATOR', 'CLIENT', 'PUBLIC', 'SYSTEM')),
  action          text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  entity_type     text NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]*$'),
  entity_id       text,
  before          jsonb,
  after           jsonb,
  correlation_id  text NOT NULL CHECK (length(correlation_id) BETWEEN 8 AND 200),
  idempotency_key text,
  session_id      text,
  ip_hash         text,
  CHECK (actor_type = 'SYSTEM' OR actor_id IS NOT NULL)
);
CREATE INDEX audit_event_entity_idx ON audit_event (entity_type, entity_id);
CREATE INDEX audit_event_correlation_idx ON audit_event (correlation_id);

CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- Deterministic hash of a contiguous seq range, chained to the previous seal.
CREATE FUNCTION inrp2p_audit_range_hash(p_prev text, p_from bigint, p_to bigint) RETURNS text
LANGUAGE sql STABLE
SET timezone = 'UTC'
SET datestyle = 'ISO, YMD'
AS $$
  SELECT encode(
    sha256(convert_to(
      coalesce(p_prev, 'GENESIS') || E'\n' ||
      coalesce(string_agg(
        concat_ws('|', e.seq, e.id, to_char(e.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), e.actor_type,
                  coalesce(e.actor_id, ''), e.surface, e.action, e.entity_type, coalesce(e.entity_id, ''),
                  coalesce(e.before::text, ''), coalesce(e.after::text, ''), e.correlation_id,
                  coalesce(e.idempotency_key, ''), coalesce(e.session_id, ''), coalesce(e.ip_hash, '')),
        E'\n' ORDER BY e.seq), ''),
      'UTF8')),
    'hex')
  FROM audit_event e
  WHERE e.seq BETWEEN p_from AND p_to
$$;

CREATE TABLE audit_seal (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_seq       bigint NOT NULL UNIQUE,
  to_seq         bigint NOT NULL UNIQUE,
  event_count    bigint NOT NULL CHECK (event_count >= 0),
  prev_seal_hash text,
  seal_hash      text NOT NULL CHECK (seal_hash ~ '^[0-9a-f]{64}$'),
  sealed_at      timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (to_seq >= from_seq)
);

-- Seals must be contiguous and chained.
CREATE FUNCTION inrp2p_audit_seal_contiguous() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last_seal audit_seal%ROWTYPE;
BEGIN
  SELECT * INTO last_seal FROM audit_seal ORDER BY to_seq DESC LIMIT 1;
  IF last_seal.id IS NULL THEN
    IF NEW.from_seq <> 1 OR NEW.prev_seal_hash IS NOT NULL THEN
      RAISE EXCEPTION 'first audit seal must start at seq 1 without predecessor' USING ERRCODE = 'IX002';
    END IF;
  ELSIF NEW.from_seq <> last_seal.to_seq + 1 OR NEW.prev_seal_hash IS DISTINCT FROM last_seal.seal_hash THEN
    RAISE EXCEPTION 'audit seal must continue from seq % and chain hash', last_seal.to_seq + 1 USING ERRCODE = 'IX002';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER audit_seal_contiguous BEFORE INSERT ON audit_seal
  FOR EACH ROW EXECUTE FUNCTION inrp2p_audit_seal_contiguous();
CREATE TRIGGER audit_seal_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_seal
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

GRANT SELECT, INSERT ON audit_event TO inrp2p_app;
GRANT SELECT ON audit_event, audit_seal TO inrp2p_readonly;
GRANT SELECT ON audit_seal TO inrp2p_app;
GRANT INSERT ON audit_seal TO inrp2p_worker;
GRANT EXECUTE ON FUNCTION inrp2p_audit_range_hash(text, bigint, bigint) TO inrp2p_app, inrp2p_readonly;
