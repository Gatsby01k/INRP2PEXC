-- 0005 transactional outbox (ARCHITECTURE §5).
CREATE TABLE outbox_event (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  type            text NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  aggregate_type  text,
  aggregate_id    text,
  payload         jsonb NOT NULL,
  correlation_id  text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT statement_timestamp(),
  dispatched_at   timestamptz,
  failed_at       timestamptz,
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error      text,
  CHECK (NOT (dispatched_at IS NOT NULL AND failed_at IS NOT NULL))
);
CREATE INDEX outbox_event_pending_idx ON outbox_event (created_at) WHERE dispatched_at IS NULL AND failed_at IS NULL;

CREATE FUNCTION inrp2p_guard_outbox_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'outbox events are not deleted by the application' USING ERRCODE = 'IX001';
  END IF;
  IF NEW.id <> OLD.id OR NEW.type <> OLD.type OR NEW.payload <> OLD.payload
     OR NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
     OR NEW.correlation_id <> OLD.correlation_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'outbox event content is immutable' USING ERRCODE = 'IX001';
  END IF;
  IF OLD.dispatched_at IS NOT NULL THEN
    RAISE EXCEPTION 'dispatched outbox event is final' USING ERRCODE = 'IX001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER outbox_event_guard BEFORE UPDATE OR DELETE ON outbox_event
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_outbox_event();

-- Handler-level idempotency keyed by event id.
CREATE TABLE outbox_delivery (
  event_id     uuid NOT NULL REFERENCES outbox_event (id),
  handler      text NOT NULL,
  delivered_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (event_id, handler)
);
CREATE TRIGGER outbox_delivery_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON outbox_delivery
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

GRANT SELECT, INSERT ON outbox_event TO inrp2p_app;
GRANT UPDATE (dispatched_at, failed_at, attempts, last_error) ON outbox_event TO inrp2p_worker;
GRANT SELECT, INSERT ON outbox_delivery TO inrp2p_worker;
