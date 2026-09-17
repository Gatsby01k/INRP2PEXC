-- 0006 Better Auth schema (better-auth 1.7.5 core + twoFactor + emailOTP + database rate limit),
-- committed as explicit SQL with snake_case names mapped in packages/identity/src/auth/schema-mapping.ts.
-- An integration test asserts Better Auth's own migration planner finds nothing to add.
CREATE TABLE auth_user (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  name               text NOT NULL,
  email              text NOT NULL UNIQUE CHECK (email = lower(email)),
  email_verified     boolean NOT NULL DEFAULT false,
  image              text,
  created_at         timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at         timestamptz NOT NULL DEFAULT statement_timestamp(),
  two_factor_enabled boolean DEFAULT false,
  kind               text NOT NULL CHECK (kind IN ('OPERATOR', 'CLIENT')),
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED'))
);

CREATE TABLE auth_session (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  expires_at  timestamptz NOT NULL,
  token       text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at  timestamptz NOT NULL DEFAULT statement_timestamp(),
  ip_address  text,
  user_agent  text,
  user_id     uuid NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
  surface     text NOT NULL CHECK (surface IN ('OPERATOR', 'CLIENT'))
);
CREATE INDEX auth_session_user_idx ON auth_session (user_id);

-- A session's surface must match its user's kind: operators never hold client sessions and vice versa.
CREATE FUNCTION inrp2p_auth_session_surface() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  u_kind text;
BEGIN
  SELECT kind INTO u_kind FROM auth_user WHERE id = NEW.user_id;
  IF u_kind IS DISTINCT FROM NEW.surface THEN
    RAISE EXCEPTION 'session surface % does not match user kind %', NEW.surface, u_kind USING ERRCODE = 'IX020';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER auth_session_surface BEFORE INSERT OR UPDATE OF surface, user_id ON auth_session
  FOR EACH ROW EXECUTE FUNCTION inrp2p_auth_session_surface();

CREATE TABLE auth_account (
  id                       uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id               text NOT NULL,
  provider_id              text NOT NULL,
  user_id                  uuid NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
  access_token             text,
  refresh_token            text,
  id_token                 text,
  access_token_expires_at  timestamptz,
  refresh_token_expires_at timestamptz,
  scope                    text,
  password                 text,
  created_at               timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at               timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX auth_account_user_idx ON auth_account (user_id);

-- text id: Better Auth writes deterministic reservation ids (SHA-256 base64url) here for single-use codes.
CREATE TABLE auth_verification (
  id         text PRIMARY KEY DEFAULT uuidv7()::text,
  identifier text NOT NULL,
  value      text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX auth_verification_identifier_idx ON auth_verification (identifier);

CREATE TABLE auth_two_factor (
  id                        uuid PRIMARY KEY DEFAULT uuidv7(),
  secret                    text NOT NULL,
  backup_codes              text NOT NULL,
  user_id                   uuid NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
  verified                  boolean DEFAULT true,
  failed_verification_count integer DEFAULT 0,
  locked_until              timestamptz
);
CREATE INDEX auth_two_factor_secret_idx ON auth_two_factor (secret);
CREATE INDEX auth_two_factor_user_idx ON auth_two_factor (user_id);

CREATE TABLE auth_rate_limit (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  key          text NOT NULL UNIQUE,
  count        integer NOT NULL,
  last_request bigint NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_user, auth_session, auth_account, auth_verification, auth_two_factor, auth_rate_limit TO inrp2p_app;
