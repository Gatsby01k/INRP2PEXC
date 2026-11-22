-- 0054 Opening an account with Telegram (2026-11-22, ADR 0026 amended).
--
-- Until now Telegram signed in only an account that had linked it from inside, after signing in by email: someone new
-- who pressed "Continue with Telegram" was sent back to sign in by email first. Now Telegram opens an account by itself.
-- Telegram gives no email, so such an account carries a placeholder address the person never sees and no mail is ever
-- sent to — `telegram-<telegram user id>@telegram.invalid` (`.invalid` is reserved, RFC 2606) — until they add their
-- own email from Account & security.
--
-- 1. `auth_user`: a placeholder address belongs only to a client, and is never "verified" — nothing was sent to it.
-- 2. `inrp2p_auth_account_telegram()` (IX136): a Telegram may be held by an active client with a verified email, as
--    before, or by the account that Telegram itself opened — the one whose placeholder names that very Telegram user.
--    No other account without a verified email can hold one.
--
-- No new error code belongs to this migration (IX136 keeps its meaning). 0001–0053 are not edited.


-- 1. A placeholder address -------------------------------------------------------------------------------------------

ALTER TABLE auth_user ADD CONSTRAINT auth_user_telegram_placeholder CHECK (
  email NOT LIKE '%@telegram.invalid' OR (kind = 'CLIENT' AND email_verified IS NOT TRUE));


-- 2. Who may hold a Telegram -----------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION inrp2p_auth_account_telegram() RETURNS trigger
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
    SELECT kind, status, email, email_verified INTO u FROM auth_user WHERE id = NEW.user_id;
    IF u.kind IS DISTINCT FROM 'CLIENT' OR u.status IS DISTINCT FROM 'ACTIVE'
       OR (u.email_verified IS NOT TRUE AND u.email IS DISTINCT FROM 'telegram-' || NEW.account_id || '@telegram.invalid') THEN
      RAISE EXCEPTION 'only an active client with a verified email, or the account this Telegram opened, holds a Telegram' USING ERRCODE = 'IX136';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
