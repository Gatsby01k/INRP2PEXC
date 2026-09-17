-- 0008 reference data: shared row guards + clients, contacts, client users, beneficiary bank accounts,
-- client wallets (DOMAIN_MODEL §2.2, SECURITY §2.2, §5; STATE_MACHINES rules).

-- Status whitelist guard (STATE_MACHINES "Rules"; SECURITY §6 defence in depth behind the TS commands).
-- TG_ARGV[0] = status column, TG_ARGV[1] = comma-separated allowed "FROM>TO" pairs.
CREATE FUNCTION inrp2p_guard_status_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  col text := TG_ARGV[0];
  old_status text := to_jsonb(OLD) ->> col;
  new_status text := to_jsonb(NEW) ->> col;
BEGIN
  IF old_status IS DISTINCT FROM new_status
     AND NOT ((old_status || '>' || new_status) = ANY (string_to_array(TG_ARGV[1], ','))) THEN
    RAISE EXCEPTION '%: transition % -> % is not allowed', TG_TABLE_NAME, old_status, new_status USING ERRCODE = 'IX040';
  END IF;
  RETURN NEW;
END
$$;

-- Immutable-row guard: every column except the listed mutable ones must keep its value (TG_ARGV = mutable columns).
CREATE FUNCTION inrp2p_guard_immutable_columns() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mutable text[] := coalesce(TG_ARGV::text[], ARRAY[]::text[]);
BEGIN
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION '%: only (%) may change', TG_TABLE_NAME, array_to_string(mutable, ', ') USING ERRCODE = 'IX041';
  END IF;
  RETURN NEW;
END
$$;

-- Envelope-encrypted value written by packages/adapters field protector: "v1.<kid>.<b64url wrapped dek>.<b64url iv>.<b64url ct>.<b64url tag>".
CREATE DOMAIN inrp2p_sealed AS text CHECK (VALUE ~ '^v1\.[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9_-]+){4}$');
CREATE DOMAIN inrp2p_hmac AS text CHECK (VALUE ~ '^[0-9a-f]{64}$');
CREATE DOMAIN inrp2p_tron_address AS text CHECK (VALUE ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$');

CREATE SEQUENCE client_ref_seq;

CREATE TABLE client (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  ref                     text NOT NULL UNIQUE DEFAULT ('CL-' || lpad(nextval('client_ref_seq')::text, 4, '0')),
  legal_name              text NOT NULL CHECK (length(btrim(legal_name)) BETWEEN 1 AND 200),
  display_name            text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  type                    text NOT NULL CHECK (type IN ('COMPANY', 'INDIVIDUAL')),
  status                  text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  typical_direction       text CHECK (typical_direction IN ('SELL_USDT', 'BUY_USDT')),
  typical_size_usdt_minor bigint CHECK (typical_size_usdt_minor > 0),
  pricing_notes           text CHECK (length(pricing_notes) <= 2000),
  -- Compliance hooks (D-07): schema only; no workflow in V1 phases before counsel sign-off.
  kyc_status              text NOT NULL DEFAULT 'NOT_STARTED' CHECK (kyc_status IN ('NOT_STARTED', 'PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED')),
  screening_status        text NOT NULL DEFAULT 'NOT_SCREENED' CHECK (screening_status IN ('NOT_SCREENED', 'CLEAR', 'POTENTIAL_MATCH', 'CONFIRMED_MATCH')),
  compliance_notes        text,
  created_by              text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at              timestamptz NOT NULL DEFAULT statement_timestamp(),
  version                 integer NOT NULL DEFAULT 1 CHECK (version >= 1)
);
CREATE TRIGGER client_status BEFORE UPDATE ON client
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'ACTIVE>SUSPENDED,SUSPENDED>ACTIVE');
CREATE TRIGGER client_identity BEFORE UPDATE ON client
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('legal_name', 'display_name', 'status', 'typical_direction', 'typical_size_usdt_minor', 'pricing_notes', 'kyc_status', 'screening_status', 'compliance_notes', 'updated_at', 'version');

CREATE TABLE client_contact (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  client_id        uuid NOT NULL REFERENCES client (id),
  name             text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  email            text CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+$'),
  phone_enc        inrp2p_sealed,
  phone_last4      text CHECK (phone_last4 ~ '^[0-9]{4}$'),
  whatsapp_enc     inrp2p_sealed,
  whatsapp_last4   text CHECK (whatsapp_last4 ~ '^[0-9]{4}$'),
  telegram_handle  text CHECK (telegram_handle ~ '^@?[A-Za-z0-9_]{5,32}$'),
  is_primary       boolean NOT NULL DEFAULT false,
  notes            text CHECK (length(notes) <= 2000),
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT statement_timestamp(),
  archived_by      text,
  archived_at      timestamptz,
  CHECK ((phone_enc IS NULL) = (phone_last4 IS NULL)),
  CHECK ((whatsapp_enc IS NULL) = (whatsapp_last4 IS NULL)),
  CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL AND archived_by IS NOT NULL))
);
CREATE INDEX client_contact_client_idx ON client_contact (client_id);
CREATE UNIQUE INDEX client_contact_one_primary ON client_contact (client_id) WHERE is_primary AND status = 'ACTIVE';
CREATE TRIGGER client_contact_status BEFORE UPDATE ON client_contact
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'ACTIVE>ARCHIVED');
CREATE TRIGGER client_contact_immutable BEFORE UPDATE ON client_contact
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'archived_by', 'archived_at', 'is_primary');

-- Login identity of a client (DECISIONS D-01, D-08). Not a CRM contact.
CREATE TABLE client_user (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  client_id         uuid NOT NULL REFERENCES client (id),
  user_id           uuid NOT NULL UNIQUE REFERENCES auth_user (id),
  role              text NOT NULL CHECK (role IN ('CLIENT_ADMIN', 'CLIENT_TRADER')),
  can_accept_quotes boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at        timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX client_user_client_idx ON client_user (client_id);
CREATE TRIGGER client_user_status BEFORE UPDATE ON client_user
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'ACTIVE>DISABLED,DISABLED>ACTIVE');
CREATE TRIGGER client_user_immutable BEFORE UPDATE ON client_user
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('role', 'can_accept_quotes', 'status', 'updated_at');

CREATE FUNCTION inrp2p_require_client_user_kind() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT kind FROM auth_user WHERE id = NEW.user_id) IS DISTINCT FROM 'CLIENT' THEN
    RAISE EXCEPTION 'client_user must reference a CLIENT auth user' USING ERRCODE = 'IX022';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER client_user_kind BEFORE INSERT ON client_user
  FOR EACH ROW EXECUTE FUNCTION inrp2p_require_client_user_kind();

-- Client beneficiary bank account. Never edited in place: change = archive + new row (DOMAIN_MODEL §2.2, S8).
CREATE TABLE bank_account (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  client_id          uuid NOT NULL REFERENCES client (id),
  holder_name        text NOT NULL CHECK (length(btrim(holder_name)) BETWEEN 1 AND 140),
  bank_name          text NOT NULL CHECK (length(btrim(bank_name)) BETWEEN 1 AND 140),
  ifsc               text NOT NULL CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  account_number_enc inrp2p_sealed NOT NULL,
  account_last4      text NOT NULL CHECK (account_last4 ~ '^[0-9]{4}$'),
  account_hmac       inrp2p_hmac NOT NULL,
  rail_preferences   text[] NOT NULL DEFAULT ARRAY['IMPS', 'NEFT', 'RTGS']::text[]
                     CHECK (cardinality(rail_preferences) >= 1 AND rail_preferences <@ ARRAY['IMPS', 'NEFT', 'RTGS', 'UPI']::text[]),
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  verified_at        timestamptz,
  created_by         text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT statement_timestamp(),
  archived_by        text,
  archived_at        timestamptz,
  archive_reason     text CHECK (length(archive_reason) <= 500),
  CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL AND archived_by IS NOT NULL))
);
CREATE INDEX bank_account_client_idx ON bank_account (client_id);
CREATE UNIQUE INDEX bank_account_active_unique ON bank_account (client_id, account_hmac) WHERE status = 'ACTIVE';
CREATE TRIGGER bank_account_status BEFORE UPDATE ON bank_account
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'ACTIVE>ARCHIVED');
CREATE TRIGGER bank_account_immutable BEFORE UPDATE ON bank_account
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'archived_by', 'archived_at', 'archive_reason', 'verified_at');

CREATE TABLE crypto_wallet (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  client_id   uuid NOT NULL REFERENCES client (id),
  network     text NOT NULL CHECK (network IN ('TRON')),
  address     inrp2p_tron_address NOT NULL,
  label       text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  purpose     text NOT NULL CHECK (purpose IN ('SOURCE', 'DESTINATION', 'BOTH')),
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT statement_timestamp(),
  archived_by text,
  archived_at timestamptz,
  archive_reason text CHECK (length(archive_reason) <= 500),
  CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL AND archived_by IS NOT NULL))
);
CREATE INDEX crypto_wallet_client_idx ON crypto_wallet (client_id);
CREATE UNIQUE INDEX crypto_wallet_active_unique ON crypto_wallet (client_id, network, address) WHERE status = 'ACTIVE';
CREATE TRIGGER crypto_wallet_status BEFORE UPDATE ON crypto_wallet
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'ACTIVE>ARCHIVED');
CREATE TRIGGER crypto_wallet_immutable BEFORE UPDATE ON crypto_wallet
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'archived_by', 'archived_at', 'archive_reason');

-- No DELETE anywhere on reference data; UPDATE limited to the mutable columns above.
GRANT USAGE ON SEQUENCE client_ref_seq TO inrp2p_app;
GRANT SELECT, INSERT ON client, client_contact, client_user, bank_account, crypto_wallet TO inrp2p_app;
GRANT UPDATE (display_name, legal_name, status, typical_direction, typical_size_usdt_minor, pricing_notes, updated_at, version) ON client TO inrp2p_app;
GRANT UPDATE (status, archived_by, archived_at, is_primary) ON client_contact TO inrp2p_app;
GRANT UPDATE (role, can_accept_quotes, status, updated_at) ON client_user TO inrp2p_app;
GRANT UPDATE (status, archived_by, archived_at, archive_reason, verified_at) ON bank_account TO inrp2p_app;
GRANT UPDATE (status, archived_by, archived_at, archive_reason) ON crypto_wallet TO inrp2p_app;
GRANT SELECT ON client, client_contact, client_user, crypto_wallet TO inrp2p_readonly;
GRANT SELECT (id, client_id, holder_name, bank_name, ifsc, account_last4, rail_preferences, status, verified_at, created_by, created_at, archived_by, archived_at, archive_reason) ON bank_account TO inrp2p_readonly;
