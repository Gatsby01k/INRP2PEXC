-- 0052 Where each sign-in came from (2026-11-18).
--
-- The desk could not say where a client signed up or signs in from. A session keeps the address and device Better Auth
-- recorded only while it lives — signing out deletes it — and the audit trail keeps a hash of the address on purpose: it
-- is exported to write-once storage, where a person's address must never be. So:
--
-- 1. `sign_in`: one row for every sign-in on either surface, written by the application when a sign-in request opens a
--    session — who, which session, how (email code, Telegram, password), the address Better Auth resolved, the country,
--    region and city the edge resolved that address to (Vercel's `x-vercel-ip-*` headers; nothing is sent anywhere to
--    look an address up), and the device's user agent. A client's first row is where it signed up from.
-- 2. It is a record, not a log to edit: no UPDATE, no TRUNCATE. The application may only add and read. Rows are never
--    exported and can be removed by the database owner when they are no longer needed.
--
-- No error code belongs to this migration. 0001–0051 are not edited.

CREATE TABLE sign_in (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id     uuid NOT NULL REFERENCES auth_user (id),
  -- The session the sign-in opened. Not a reference: the session is deleted when its person signs out, the record stays.
  session_id  uuid NOT NULL,
  surface     text NOT NULL CHECK (surface IN ('CLIENT', 'OPERATOR')),
  method      text CHECK (method IS NULL OR method IN ('EMAIL', 'TELEGRAM', 'PASSWORD')),
  ip          inet,
  -- ISO 3166-1 alpha-2, the subdivision code under it (ISO 3166-2, without the country), and the city — as the edge said.
  country     text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  region      text CHECK (region IS NULL OR region ~ '^[A-Z0-9]{1,3}$'),
  city        text CHECK (city IS NULL OR length(btrim(city)) BETWEEN 1 AND 120),
  user_agent  text CHECK (user_agent IS NULL OR length(user_agent) BETWEEN 1 AND 512),
  at          timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX sign_in_user ON sign_in (user_id, at DESC);

CREATE TRIGGER sign_in_append_only BEFORE UPDATE OR TRUNCATE ON sign_in
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- Grants -------------------------------------------------------------------------------------------------------------

GRANT SELECT, INSERT ON sign_in TO inrp2p_app;
GRANT SELECT ON sign_in TO inrp2p_readonly;
