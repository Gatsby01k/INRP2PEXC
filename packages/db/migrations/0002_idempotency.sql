-- 0002 idempotency keys (FI-50). A key is claimed at the start of the command transaction and
-- completed in the same transaction, so a rollback releases it and a concurrent duplicate blocks
-- on the primary key until the first attempt commits or rolls back.
CREATE TABLE idempotency_key (
  scope         text NOT NULL CHECK (scope ~ '^[a-z_]+(\.[a-z_]+)*$'),
  key           text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  request_hash  text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  actor_id      text,
  status        text NOT NULL CHECK (status IN ('PENDING', 'COMPLETED')),
  response      jsonb,
  created_at    timestamptz NOT NULL DEFAULT statement_timestamp(),
  completed_at  timestamptz,
  PRIMARY KEY (scope, key),
  CHECK ((status = 'PENDING') = (response IS NULL AND completed_at IS NULL))
);

CREATE FUNCTION inrp2p_guard_idempotency() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'idempotency keys are not deleted by the application' USING ERRCODE = 'IX001';
  END IF;
  IF NEW.scope <> OLD.scope OR NEW.key <> OLD.key OR NEW.request_hash <> OLD.request_hash
     OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'idempotency key identity is immutable' USING ERRCODE = 'IX001';
  END IF;
  IF OLD.status <> 'PENDING' OR NEW.status <> 'COMPLETED' THEN
    RAISE EXCEPTION 'idempotency key may only move PENDING -> COMPLETED' USING ERRCODE = 'IX001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER idempotency_key_guard BEFORE UPDATE OR DELETE ON idempotency_key
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_idempotency();

GRANT SELECT, INSERT ON idempotency_key TO inrp2p_app;
GRANT UPDATE (status, response, completed_at) ON idempotency_key TO inrp2p_app;
