-- 0010 liquidity routes and append-only rate snapshots (DOMAIN_MODEL §2.4, D-03, D-14, FI-11, FI-63).
-- Route data reveals economics: never granted to client-facing read paths.

CREATE TABLE liquidity_route (
  id                         uuid PRIMARY KEY DEFAULT uuidv7(),
  name                       text NOT NULL UNIQUE CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  direction                  text NOT NULL CHECK (direction IN ('SELL_USDT', 'BUY_USDT', 'BOTH')),
  asset                      text NOT NULL DEFAULT 'USDT' CHECK (asset IN ('USDT')),
  network                    text NOT NULL DEFAULT 'TRON' CHECK (network IN ('TRON')),
  status                     text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'RETIRED')),
  settlement_model           text NOT NULL DEFAULT 'PER_TRADE' CHECK (settlement_model IN ('PER_TRADE', 'PREFUNDED', 'NET_SETTLED')),
  execution_mode             text NOT NULL CHECK (execution_mode IN ('DIRECT_TO_CLIENT', 'TO_EXCHANGE')),
  registered_payout_identity text CHECK (length(registered_payout_identity) <= 200),
  registered_route_address   inrp2p_tron_address,
  available_base_minor       bigint NOT NULL DEFAULT 0 CHECK (available_base_minor >= 0),
  notes                      text CHECK (length(notes) <= 2000),
  created_by                 text NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at                 timestamptz NOT NULL DEFAULT statement_timestamp(),
  version                    integer NOT NULL DEFAULT 1,
  -- FI-63: V1 implements PER_TRADE only. Dropped by the migration that implements another model.
  CONSTRAINT liquidity_route_v1_per_trade_only CHECK (settlement_model = 'PER_TRADE')
);
CREATE TRIGGER liquidity_route_status BEFORE UPDATE ON liquidity_route
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'ACTIVE>PAUSED,PAUSED>ACTIVE,ACTIVE>RETIRED,PAUSED>RETIRED');
CREATE TRIGGER liquidity_route_immutable BEFORE UPDATE ON liquidity_route
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'settlement_model', 'execution_mode', 'registered_payout_identity', 'registered_route_address', 'available_base_minor', 'notes', 'updated_at', 'version');

-- Append-only price history. "Current" = latest effective_at per (kind, route, direction).
CREATE TABLE rate_snapshot (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  kind          text NOT NULL CHECK (kind IN ('REFERENCE', 'ROUTE')),
  route_id      uuid REFERENCES liquidity_route (id),
  direction     text NOT NULL CHECK (direction IN ('SELL_USDT', 'BUY_USDT')),
  rate_micro    bigint NOT NULL CHECK (rate_micro > 0),
  source        text NOT NULL CHECK (source ~ '^(OPERATOR|FEED:[a-z0-9_]{1,40})$'),
  effective_at  timestamptz NOT NULL DEFAULT statement_timestamp(),
  supersedes_id uuid UNIQUE REFERENCES rate_snapshot (id),
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK ((kind = 'ROUTE') = (route_id IS NOT NULL)),
  CHECK (kind = 'REFERENCE' OR source = 'OPERATOR'),
  CHECK (supersedes_id IS DISTINCT FROM id)
);
CREATE INDEX rate_snapshot_route_current_idx ON rate_snapshot (route_id, direction, effective_at DESC, id DESC) WHERE kind = 'ROUTE';
CREATE INDEX rate_snapshot_reference_current_idx ON rate_snapshot (direction, effective_at DESC, id DESC) WHERE kind = 'REFERENCE';

-- A superseded snapshot must belong to the same series.
CREATE FUNCTION inrp2p_guard_rate_snapshot_series() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prev rate_snapshot%ROWTYPE;
BEGIN
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO prev FROM rate_snapshot WHERE id = NEW.supersedes_id;
    IF prev.kind <> NEW.kind OR prev.route_id IS DISTINCT FROM NEW.route_id OR prev.direction <> NEW.direction THEN
      RAISE EXCEPTION 'rate snapshot may only supersede a snapshot of the same series' USING ERRCODE = 'IX042';
    END IF;
    IF NEW.effective_at < prev.effective_at THEN
      RAISE EXCEPTION 'rate snapshot cannot be effective before the snapshot it supersedes' USING ERRCODE = 'IX042';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER rate_snapshot_series BEFORE INSERT ON rate_snapshot
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_rate_snapshot_series();
CREATE TRIGGER rate_snapshot_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON rate_snapshot
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

GRANT SELECT, INSERT ON liquidity_route, rate_snapshot TO inrp2p_app;
GRANT UPDATE (status, settlement_model, execution_mode, registered_payout_identity, registered_route_address, available_base_minor, notes, updated_at, version) ON liquidity_route TO inrp2p_app;
GRANT SELECT ON liquidity_route, rate_snapshot TO inrp2p_readonly;
