-- 0007 INRP2P RBAC, step-up and idle-timeout tracking around Better Auth (SECURITY §2–§3).
CREATE TABLE operator_role (
  code text PRIMARY KEY CHECK (code IN ('OWNER', 'DEALER', 'SETTLEMENT_OPERATOR', 'FINANCE', 'SUPPORT', 'READ_ONLY'))
);
INSERT INTO operator_role (code) VALUES ('OWNER'), ('DEALER'), ('SETTLEMENT_OPERATOR'), ('FINANCE'), ('SUPPORT'), ('READ_ONLY');
CREATE TRIGGER operator_role_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON operator_role
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

CREATE TABLE operator_user_role (
  user_id    uuid NOT NULL REFERENCES auth_user (id),
  role_code  text NOT NULL REFERENCES operator_role (code),
  granted_by uuid REFERENCES auth_user (id),
  granted_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (user_id, role_code)
);

-- Per-user grants of permissions the matrix marks as grantable (e.g. economics:view for READ_ONLY).
CREATE TABLE operator_permission_grant (
  user_id         uuid NOT NULL REFERENCES auth_user (id),
  permission_code text NOT NULL CHECK (permission_code ~ '^[a-z_]+:[a-z_]+$'),
  granted_by      uuid NOT NULL REFERENCES auth_user (id),
  granted_at      timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (user_id, permission_code)
);

CREATE FUNCTION inrp2p_require_operator_user() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  u_kind text;
BEGIN
  SELECT kind INTO u_kind FROM auth_user WHERE id = NEW.user_id;
  IF u_kind IS DISTINCT FROM 'OPERATOR' THEN
    RAISE EXCEPTION 'operator roles and grants can only be assigned to operator users' USING ERRCODE = 'IX021';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER operator_user_role_kind BEFORE INSERT OR UPDATE ON operator_user_role
  FOR EACH ROW EXECUTE FUNCTION inrp2p_require_operator_user();
CREATE TRIGGER operator_permission_grant_kind BEFORE INSERT OR UPDATE ON operator_permission_grant
  FOR EACH ROW EXECUTE FUNCTION inrp2p_require_operator_user();

-- Written after every successful Better Auth TOTP verification; read for MFA-verified sessions and step-up freshness.
CREATE TABLE step_up_verification (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id     uuid NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
  session_id  uuid NOT NULL REFERENCES auth_session (id) ON DELETE CASCADE,
  method      text NOT NULL CHECK (method IN ('TOTP')),
  verified_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  ip_hash     text
);
CREATE INDEX step_up_verification_session_idx ON step_up_verification (session_id, verified_at DESC);

-- Idle-timeout tracking (Better Auth has absolute expiry only).
CREATE TABLE session_activity (
  session_id       uuid PRIMARY KEY REFERENCES auth_session (id) ON DELETE CASCADE,
  last_activity_at timestamptz NOT NULL
);

GRANT SELECT ON operator_role TO inrp2p_app, inrp2p_readonly;
GRANT SELECT, INSERT, DELETE ON operator_user_role, operator_permission_grant TO inrp2p_app;
GRANT SELECT, INSERT ON step_up_verification TO inrp2p_app;
GRANT SELECT, INSERT, UPDATE ON session_activity TO inrp2p_app;
