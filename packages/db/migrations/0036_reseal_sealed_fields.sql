-- 0036 moving sealed values to another key-encryption key (owner direction 2026-10-11: keep the two clients' bank
-- accounts while production moves from the locally held key `prod-v1` to AWS KMS; RUNBOOKS `field-encryption-keys`).
--
-- A sealed value is `v1.<key id>.<wrapped data key>.<iv>.<ciphertext>.<tag>`: the data is encrypted once, under its
-- own data key, and only the data key is wrapped by the key-encryption key. Moving a value to a new key-encryption key
-- therefore re-wraps the data key and leaves the iv, the ciphertext and the tag exactly as they were — the account
-- number is never decrypted for the move and cannot change, and its lookup HMAC (a separate key) is untouched.
--
-- The rows holding sealed values are immutable (`inrp2p_guard_immutable_columns`, `inrp2p_guard_otp_delivery`), so a
-- re-wrap needs a way through. This migration gives exactly one, `inrp2p_is_reseal(old, new)`, true only when:
--
-- 1. the session is not the application's (`inrp2p_is_application_session()`, 0027): the web and the worker can
--    never use it, whatever they set — only the schema owner, running `scripts/reseal-fields.ts`;
-- 2. the transaction declared it (`set local inrp2p.reseal = 'on'`), so an owner's ordinary update stays refused;
-- 3. every column that changed is an `inrp2p_sealed` column, and in each the key id changed while the iv, the
--    ciphertext and the tag did not.
--
-- Error codes are unchanged (IX041). 0001–0035 are not edited.

CREATE FUNCTION inrp2p_is_reseal(p_table regclass, p_old jsonb, p_new jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  col record;
  changed integer := 0;
  o text[];
  n text[];
BEGIN
  IF coalesce(current_setting('inrp2p.reseal', true), '') <> 'on' OR inrp2p_is_application_session() THEN
    RETURN false;
  END IF;
  FOR col IN
    SELECT a.attname::text AS name, a.atttypid = 'inrp2p_sealed'::regtype AS sealed
    FROM pg_attribute a
    WHERE a.attrelid = p_table AND a.attnum > 0 AND NOT a.attisdropped
  LOOP
    CONTINUE WHEN (p_old -> col.name) IS NOT DISTINCT FROM (p_new -> col.name);
    IF NOT col.sealed OR (p_old ->> col.name) IS NULL OR (p_new ->> col.name) IS NULL THEN
      RETURN false;
    END IF;
    o := string_to_array(p_old ->> col.name, '.');
    n := string_to_array(p_new ->> col.name, '.');
    IF o[2] = n[2] OR o[4] <> n[4] OR o[5] <> n[5] OR o[6] <> n[6] THEN
      RETURN false;
    END IF;
    changed := changed + 1;
  END LOOP;
  RETURN changed > 0;
END
$$;

CREATE OR REPLACE FUNCTION inrp2p_guard_immutable_columns() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mutable text[] := coalesce(TG_ARGV::text[], ARRAY[]::text[]);
BEGIN
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable)
     AND NOT inrp2p_is_reseal(TG_RELID, to_jsonb(OLD) - mutable, to_jsonb(NEW) - mutable) THEN
    RAISE EXCEPTION '%: only (%) may change', TG_TABLE_NAME, array_to_string(mutable, ', ') USING ERRCODE = 'IX041';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION inrp2p_guard_otp_delivery() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.challenge_id <> OLD.challenge_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'otp delivery identity is immutable' USING ERRCODE = 'IX041';
  END IF;
  IF OLD.code_sealed IS NULL AND NEW.code_sealed IS NOT NULL THEN
    RAISE EXCEPTION 'an erased OTP code cannot be restored' USING ERRCODE = 'IX041';
  END IF;
  IF OLD.code_sealed IS NOT NULL AND NEW.code_sealed IS NOT NULL AND NEW.code_sealed <> OLD.code_sealed
     AND NOT inrp2p_is_reseal(TG_RELID, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RAISE EXCEPTION 'OTP code cannot be replaced' USING ERRCODE = 'IX041';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION inrp2p_is_reseal(regclass, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inrp2p_is_reseal(regclass, jsonb, jsonb) TO inrp2p_app;
