-- 0023 trader self-onboarding (docs/TRADERS.md §3): anyone may apply to be a trader with their own email, and submit
-- their own settlement details, without the desk provisioning anything first. Three things make that safe:
--   - Exchange access is a property of the client, granted by the desk. A client that exists only because someone
--     applied to be a trader has none, so it can never open a request, receive a quote or trade (IX080).
--   - A bank account or wallet a trader submits starts PENDING_REVIEW. Everything that settles money already asks for
--     ACTIVE, so an unreviewed destination is unusable until an operator verifies it (ACTIVE) or rejects it.
--   - What the applicant tells the desk about themselves is kept on the trader profile, next to the application.
-- An approved trader may also propose a replacement bank account or wallet (TD-24): it waits beside the verified one,
-- which keeps working until the desk approves the change.
-- Error code IX080 belongs to this migration. 0022 is applied in production and is not edited.

-- ---------------------------------------------------------------------------------------------------------------
-- Exchange access. Every client that exists today was onboarded by the desk and keeps it; a self-registered
-- trader's client is created with it off.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE client ADD COLUMN exchange_access boolean NOT NULL DEFAULT true;
DROP TRIGGER client_identity ON client;
CREATE TRIGGER client_identity BEFORE UPDATE ON client
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('legal_name', 'display_name', 'status', 'typical_direction', 'typical_size_usdt_minor', 'pricing_notes', 'kyc_status', 'screening_status', 'compliance_notes', 'updated_at', 'version', 'exchange_access');

-- A request is where every quote, trade and payout of the Exchange starts, so this one guard closes all of them.
CREATE FUNCTION inrp2p_guard_exchange_access() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce((SELECT exchange_access FROM client WHERE id = NEW.client_id), false) THEN
    RAISE EXCEPTION 'client % has no Exchange access', NEW.client_id USING ERRCODE = 'IX080';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trade_request_exchange_access BEFORE INSERT ON trade_request
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_exchange_access();

-- ---------------------------------------------------------------------------------------------------------------
-- Destination review. PENDING_REVIEW ─verify─▶ ACTIVE ─archive─▶ ARCHIVED;  PENDING_REVIEW ─reject─▶ REJECTED;
-- PENDING_REVIEW ─withdrawn or replaced─▶ ARCHIVED. A row starts ACTIVE (added by the desk, as before) or
-- PENDING_REVIEW (submitted by the client); never REJECTED or ARCHIVED.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE bank_account DROP CONSTRAINT bank_account_status_check;
ALTER TABLE bank_account ADD CONSTRAINT bank_account_status_check CHECK (status IN ('PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'ARCHIVED'));
ALTER TABLE bank_account ADD COLUMN reviewed_by text;
ALTER TABLE bank_account ADD COLUMN reviewed_at timestamptz;
ALTER TABLE bank_account ADD COLUMN review_note text CHECK (length(review_note) <= 500);
ALTER TABLE bank_account ADD CONSTRAINT bank_account_review_shape CHECK (
  (status <> 'PENDING_REVIEW' OR reviewed_at IS NULL)
  AND (status <> 'REJECTED' OR (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND review_note IS NOT NULL)));
CREATE UNIQUE INDEX bank_account_pending_unique ON bank_account (client_id, account_hmac) WHERE status = 'PENDING_REVIEW';
DROP TRIGGER bank_account_status ON bank_account;
CREATE TRIGGER bank_account_status BEFORE UPDATE ON bank_account
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'PENDING_REVIEW>ACTIVE,PENDING_REVIEW>REJECTED,PENDING_REVIEW>ARCHIVED,ACTIVE>ARCHIVED');
DROP TRIGGER bank_account_immutable ON bank_account;
CREATE TRIGGER bank_account_immutable BEFORE UPDATE ON bank_account
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'archived_by', 'archived_at', 'archive_reason', 'verified_at', 'reviewed_by', 'reviewed_at', 'review_note');

ALTER TABLE crypto_wallet DROP CONSTRAINT crypto_wallet_status_check;
ALTER TABLE crypto_wallet ADD CONSTRAINT crypto_wallet_status_check CHECK (status IN ('PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'ARCHIVED'));
ALTER TABLE crypto_wallet ADD COLUMN reviewed_by text;
ALTER TABLE crypto_wallet ADD COLUMN reviewed_at timestamptz;
ALTER TABLE crypto_wallet ADD COLUMN review_note text CHECK (length(review_note) <= 500);
ALTER TABLE crypto_wallet ADD CONSTRAINT crypto_wallet_review_shape CHECK (
  (status <> 'PENDING_REVIEW' OR reviewed_at IS NULL)
  AND (status <> 'REJECTED' OR (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND review_note IS NOT NULL)));
CREATE UNIQUE INDEX crypto_wallet_pending_unique ON crypto_wallet (client_id, network, address) WHERE status = 'PENDING_REVIEW';
DROP TRIGGER crypto_wallet_status ON crypto_wallet;
CREATE TRIGGER crypto_wallet_status BEFORE UPDATE ON crypto_wallet
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'PENDING_REVIEW>ACTIVE,PENDING_REVIEW>REJECTED,PENDING_REVIEW>ARCHIVED,ACTIVE>ARCHIVED');
DROP TRIGGER crypto_wallet_immutable ON crypto_wallet;
CREATE TRIGGER crypto_wallet_immutable BEFORE UPDATE ON crypto_wallet
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'archived_by', 'archived_at', 'archive_reason', 'reviewed_by', 'reviewed_at', 'review_note');

CREATE FUNCTION inrp2p_guard_destination_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('ACTIVE', 'PENDING_REVIEW') THEN
    RAISE EXCEPTION '%: a destination starts ACTIVE or PENDING_REVIEW, not %', TG_TABLE_NAME, NEW.status USING ERRCODE = 'IX040';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bank_account_insert_status BEFORE INSERT ON bank_account
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_destination_insert();
CREATE TRIGGER crypto_wallet_insert_status BEFORE INSERT ON crypto_wallet
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_destination_insert();

-- ---------------------------------------------------------------------------------------------------------------
-- The application, in the applicant's own words: how to reach them, their P2P experience, what they can provide
-- per order and per day, and their confirmation that the settlement details are their own. The phone number is
-- sealed like every other phone number (SECURITY §5). No rate is asked for here: rates belong to an approved trader.
--
-- A proposed replacement (TD-24) is a pending destination of the same client, named here until the desk decides.
-- The registered pair (bank_account_id, wallet_id) is what settles; a proposal never does.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE trader_profile ADD COLUMN p2p_experience text CHECK (p2p_experience IN ('BINANCE', 'BYBIT', 'OTHER', 'NONE'));
ALTER TABLE trader_profile ADD COLUMN profile_link text CHECK (length(profile_link) BETWEEN 1 AND 300);
ALTER TABLE trader_profile ADD COLUMN telegram_handle text CHECK (telegram_handle ~ '^@?[A-Za-z0-9_]{5,32}$');
ALTER TABLE trader_profile ADD COLUMN phone_enc inrp2p_sealed;
ALTER TABLE trader_profile ADD COLUMN phone_last4 text CHECK (phone_last4 ~ '^[0-9]{4}$');
ALTER TABLE trader_profile ADD COLUMN daily_capacity_inr_minor bigint CHECK (daily_capacity_inr_minor > 0);
ALTER TABLE trader_profile ADD COLUMN daily_capacity_usdt_minor bigint CHECK (daily_capacity_usdt_minor > 0);
ALTER TABLE trader_profile ADD COLUMN ownership_confirmed_at timestamptz;
ALTER TABLE trader_profile ADD COLUMN proposed_bank_account_id uuid REFERENCES bank_account (id);
ALTER TABLE trader_profile ADD COLUMN proposed_wallet_id uuid REFERENCES crypto_wallet (id);
ALTER TABLE trader_profile ADD CONSTRAINT trader_profile_phone_pair CHECK ((phone_enc IS NULL) = (phone_last4 IS NULL));
ALTER TABLE trader_profile ADD CONSTRAINT trader_profile_proposal_differs CHECK (
  (proposed_bank_account_id IS NULL OR proposed_bank_account_id <> bank_account_id)
  AND (proposed_wallet_id IS NULL OR proposed_wallet_id <> wallet_id));
DROP TRIGGER trader_profile_immutable ON trader_profile;
CREATE TRIGGER trader_profile_immutable BEFORE UPDATE ON trader_profile
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns(
    'status', 'offers_buy', 'offers_sell', 'typical_inr_minor', 'typical_usdt_minor', 'bank_account_id', 'wallet_id',
    'required_reserve_minor', 'reward_bps', 'max_order_inr_minor', 'max_order_usdt_minor', 'max_capacity_inr_minor',
    'max_capacity_usdt_minor', 'available', 'assignments_enabled', 'control_note', 'applied_by', 'applied_at',
    'reviewed_by', 'reviewed_at', 'review_note', 'updated_at', 'version',
    'p2p_experience', 'profile_link', 'telegram_handle', 'phone_enc', 'phone_last4', 'daily_capacity_inr_minor',
    'daily_capacity_usdt_minor', 'ownership_confirmed_at', 'proposed_bank_account_id', 'proposed_wallet_id');

-- The proposed destinations belong to the trader's own client too (IX070, as for the registered pair).
CREATE FUNCTION inrp2p_guard_trader_proposed_destinations() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.proposed_bank_account_id IS NOT NULL
     AND (SELECT client_id FROM bank_account WHERE id = NEW.proposed_bank_account_id) IS DISTINCT FROM NEW.client_id THEN
    RAISE EXCEPTION 'trader % proposed bank account must belong to the same client', NEW.id USING ERRCODE = 'IX070';
  END IF;
  IF NEW.proposed_wallet_id IS NOT NULL
     AND (SELECT client_id FROM crypto_wallet WHERE id = NEW.proposed_wallet_id) IS DISTINCT FROM NEW.client_id THEN
    RAISE EXCEPTION 'trader % proposed wallet must belong to the same client', NEW.id USING ERRCODE = 'IX070';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trader_profile_proposed_destinations BEFORE INSERT OR UPDATE OF proposed_bank_account_id, proposed_wallet_id ON trader_profile
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_trader_proposed_destinations();

-- ---------------------------------------------------------------------------------------------------------------
-- Grants: the new lifecycle columns only.
-- ---------------------------------------------------------------------------------------------------------------
GRANT UPDATE (exchange_access) ON client TO inrp2p_app;
GRANT UPDATE (reviewed_by, reviewed_at, review_note) ON bank_account TO inrp2p_app;
GRANT UPDATE (reviewed_by, reviewed_at, review_note) ON crypto_wallet TO inrp2p_app;
GRANT SELECT (reviewed_by, reviewed_at, review_note) ON bank_account TO inrp2p_readonly;
GRANT UPDATE (p2p_experience, profile_link, telegram_handle, phone_enc, phone_last4, daily_capacity_inr_minor, daily_capacity_usdt_minor,
  ownership_confirmed_at, proposed_bank_account_id, proposed_wallet_id) ON trader_profile TO inrp2p_app;
