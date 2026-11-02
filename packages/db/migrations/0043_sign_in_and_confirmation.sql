-- 0043 Sign in with an email code or with Telegram, and confirm what matters with a factor other than the one the session
-- was opened with (docs/adr/0026-sign-in-and-confirmation.md).
--
-- 1. `auth_session.sign_in_method`: how a session was opened — a code to the email, Telegram, or (the desk) a password. A
--    step-up confirms a client's sensitive change only when it is by another factor (packages/identity `factors.ts`).
--    Sessions opened before this migration have none and are read as what they were: EMAIL on the client surface (the
--    only way a client signed in), PASSWORD on the desk.
-- 2. `step_up_verification.method`: a code sent to the person's email, or to their linked Telegram, joins the
--    authenticator as a way to confirm.
-- 3. `auth_account` rows of provider `telegram` are Better Auth's linked Telegram identities: one Telegram per person and
--    one person per Telegram; only an active client with a verified email links one (IX136); the provider's tokens are
--    never kept (IX137); its username is kept to show which Telegram it is.
--
-- Error codes IX136–IX137 belong to this migration. 0001–0042 are not edited.


-- 1. How a session was opened ----------------------------------------------------------------------------------------

ALTER TABLE auth_session ADD COLUMN sign_in_method text;
-- A client signs in with an email code or Telegram; the desk with a password and its authenticator. Never the other way.
ALTER TABLE auth_session ADD CONSTRAINT auth_session_sign_in_method_check CHECK (
  sign_in_method IS NULL
  OR (surface = 'CLIENT' AND sign_in_method IN ('EMAIL', 'TELEGRAM'))
  OR (surface = 'OPERATOR' AND sign_in_method = 'PASSWORD'));


-- 2. What confirmed a step-up ----------------------------------------------------------------------------------------

ALTER TABLE step_up_verification DROP CONSTRAINT step_up_verification_method_check;
ALTER TABLE step_up_verification ADD CONSTRAINT step_up_verification_method_check CHECK (method IN ('TOTP', 'EMAIL', 'TELEGRAM'));


-- 3. A linked Telegram -----------------------------------------------------------------------------------------------

ALTER TABLE auth_account ADD COLUMN telegram_username text
  CHECK (telegram_username IS NULL OR telegram_username ~ '^[A-Za-z0-9_]{1,64}$');
CREATE UNIQUE INDEX auth_account_telegram_identity ON auth_account (account_id) WHERE provider_id = 'telegram';
CREATE UNIQUE INDEX auth_account_one_telegram ON auth_account (user_id) WHERE provider_id = 'telegram';

CREATE FUNCTION inrp2p_auth_account_telegram() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  u record;
BEGIN
  IF NEW.provider_id <> 'telegram' THEN
    RETURN NEW;
  END IF;
  -- Telegram's own user id, which is also the bot's chat with that person.
  IF NEW.account_id !~ '^[1-9][0-9]{0,19}$' THEN
    RAISE EXCEPTION 'a Telegram identity is its numeric user id' USING ERRCODE = 'IX136';
  END IF;
  IF NEW.access_token IS NOT NULL OR NEW.refresh_token IS NOT NULL OR NEW.id_token IS NOT NULL OR NEW.password IS NOT NULL THEN
    RAISE EXCEPTION 'no Telegram token or secret is kept' USING ERRCODE = 'IX137';
  END IF;
  IF TG_OP = 'INSERT' OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    SELECT kind, status, email_verified INTO u FROM auth_user WHERE id = NEW.user_id;
    IF u.kind IS DISTINCT FROM 'CLIENT' OR u.status IS DISTINCT FROM 'ACTIVE' OR u.email_verified IS NOT TRUE THEN
      RAISE EXCEPTION 'only an active client with a verified email links a Telegram' USING ERRCODE = 'IX136';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER auth_account_telegram BEFORE INSERT OR UPDATE ON auth_account
  FOR EACH ROW EXECUTE FUNCTION inrp2p_auth_account_telegram();
