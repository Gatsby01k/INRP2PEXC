-- 0050 UPI IDs: a payment destination of their own (ADR 0029, 2026-11-10).
--
-- Until now a UPI payment of a deal went to an address made up from the payee's bank account (`<account>@<ifsc>.ifsc.npci`).
-- Nobody had registered it, no person had checked it, and whether a payer's app accepts it was never tested. A UPI ID
-- (VPA) is now a destination a client or a trader registers itself, apart from any bank account, as many as it has:
--
-- 1. `upi_id`: the address, the name the owner says its app shows, its own limits — one payment (never above UPI's own
--    ₹1,00,000) and, when the owner sets one, a day — and its review. PENDING_REVIEW ─verify─▶ ACTIVE ─archive─▶ ARCHIVED;
--    PENDING_REVIEW ─reject─▶ REJECTED; PENDING_REVIEW ─withdrawn─▶ ARCHIVED. One a client adds waits for a person at
--    INRP2P, who records the name the address resolves to (`verified_name`): nothing is paid to it before. One live
--    address belongs to one client only.
-- 2. `p2p_pay_window.payee_upi_id`: the UPI ID a deal's buyer is shown, fixed when its time to pay opens — a deal keeps
--    the address it was opened with, and that address is not archived from under it by its owner (IX146 at the insert).
-- 3. `fiat_transfer.payer_upi_id`: the UPI ID a payer says it paid from, instead of a bank account — the payer's own, and
--    never both (IX145). The sender of the rupees is judged against its verified name, as against an account's holder.
-- 4. Inbox kind `DESTINATION_REJECTED`: a UPI ID the desk did not verify, and why.
--
-- Error codes IX145–IX146 belong to this migration. 0001–0049 are not edited.

CREATE TABLE upi_id (
  id                       uuid PRIMARY KEY DEFAULT uuidv7(),
  client_id                uuid NOT NULL REFERENCES client (id),
  -- Lower-cased `name@handle`. Never an address made up from an account number (`….ifsc.npci`, `….mmid.npci`).
  vpa                      text NOT NULL CHECK (vpa ~ '^[a-z0-9][a-z0-9._-]{1,255}@[a-z][a-z0-9.-]{1,63}$' AND vpa !~ '\.npci$'),
  -- The name the owner says a payer's app shows for it; the desk verifies it against what the address resolves to.
  holder_name              text NOT NULL CHECK (length(btrim(holder_name)) BETWEEN 2 AND 140),
  label                    text CHECK (label IS NULL OR length(btrim(label)) BETWEEN 1 AND 80),
  -- One payment to it, in paise: at most what UPI itself carries between two people.
  per_payment_limit_minor  bigint NOT NULL DEFAULT 10000000 CHECK (per_payment_limit_minor BETWEEN 100 AND 10000000),
  -- What it takes in one Indian day, when its owner sets a ceiling; null — no ceiling of its own.
  daily_limit_minor        bigint CHECK (daily_limit_minor IS NULL OR daily_limit_minor >= per_payment_limit_minor),
  status                   text NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (status IN ('PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'ARCHIVED')),
  -- The name the address resolved to when a person at INRP2P looked it up.
  verified_name            text CHECK (verified_name IS NULL OR length(btrim(verified_name)) BETWEEN 2 AND 140),
  reviewed_by              text,
  reviewed_at              timestamptz,
  review_note              text CHECK (review_note IS NULL OR length(review_note) <= 500),
  created_by               text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 100),
  created_at               timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at               timestamptz NOT NULL DEFAULT statement_timestamp(),
  archived_by              text,
  archived_at              timestamptz,
  archive_reason           text CHECK (archive_reason IS NULL OR length(archive_reason) <= 500),
  -- Nothing is paid to an address no person verified, and a refusal says why.
  CONSTRAINT upi_id_review_shape CHECK (
    (status <> 'PENDING_REVIEW' OR reviewed_at IS NULL)
    AND (status <> 'ACTIVE' OR (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND verified_name IS NOT NULL))
    AND (status <> 'REJECTED' OR (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND review_note IS NOT NULL)))
);
-- One live address, one client: the same UPI ID cannot be waiting or verified for two.
CREATE UNIQUE INDEX upi_id_live_unique ON upi_id (vpa) WHERE status IN ('PENDING_REVIEW', 'ACTIVE');
CREATE INDEX upi_id_client ON upi_id (client_id, status);

CREATE TRIGGER upi_id_status BEFORE UPDATE ON upi_id
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'PENDING_REVIEW>ACTIVE,PENDING_REVIEW>REJECTED,PENDING_REVIEW>ARCHIVED,ACTIVE>ARCHIVED');
-- The address and its owner never change: a different address is a different row, reviewed again.
CREATE TRIGGER upi_id_immutable BEFORE UPDATE ON upi_id
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns(
    'status', 'label', 'per_payment_limit_minor', 'daily_limit_minor', 'verified_name', 'reviewed_by', 'reviewed_at', 'review_note',
    'archived_by', 'archived_at', 'archive_reason', 'updated_at');
CREATE TRIGGER upi_id_no_delete BEFORE DELETE OR TRUNCATE ON upi_id
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- 2. The UPI ID a deal's buyer is shown ---------------------------------------------------------------------------------

ALTER TABLE p2p_pay_window ADD COLUMN payee_upi_id uuid REFERENCES upi_id (id);

-- IX146: a deal is opened only on a verified UPI ID of the one who receives its rupees — the trader of a client's BUY,
-- the client of its SELL.
CREATE FUNCTION inrp2p_guard_pay_window_upi() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  u record;
  payee uuid;
BEGIN
  IF NEW.payee_upi_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT client_id, status INTO u FROM upi_id WHERE id = NEW.payee_upi_id;
  SELECT CASE WHEN t.direction = 'BUY_USDT' THEN tp.client_id ELSE t.client_id END INTO payee
    FROM trade t
    JOIN route_obligation o ON o.trade_id = t.id
    JOIN liquidity_route r ON r.id = o.route_id
    LEFT JOIN trader_profile tp ON tp.id = r.trader_id
   WHERE t.id = NEW.trade_id;
  IF u.status IS DISTINCT FROM 'ACTIVE' OR payee IS NULL OR u.client_id IS DISTINCT FROM payee THEN
    RAISE EXCEPTION 'deal % cannot be paid to this UPI ID: it is not a verified UPI ID of the one who receives the rupees', NEW.trade_id USING ERRCODE = 'IX146';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER p2p_pay_window_upi BEFORE INSERT ON p2p_pay_window
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_pay_window_upi();

-- 3. The UPI ID a payment is declared from ---------------------------------------------------------------------------

ALTER TABLE fiat_transfer ADD COLUMN payer_upi_id uuid REFERENCES upi_id (id);

-- IX145: like the account of IX118 — the payer's own, verified — and a payment names an account or a UPI ID, not both.
CREATE FUNCTION inrp2p_guard_fiat_payer_upi() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  u record;
  expected uuid;
BEGIN
  IF NEW.payer_upi_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.payer_bank_account_id IS NOT NULL THEN
    RAISE EXCEPTION 'payment % is declared from a bank account and a UPI ID at once', NEW.id USING ERRCODE = 'IX145';
  END IF;
  SELECT client_id, status INTO u FROM upi_id WHERE id = NEW.payer_upi_id;
  IF NEW.payer_type = 'CLIENT' THEN
    expected := NEW.payer_id;
  ELSIF NEW.payer_type = 'ROUTE' THEN
    SELECT tp.client_id INTO expected FROM liquidity_route r JOIN trader_profile tp ON tp.id = r.trader_id WHERE r.id = NEW.payer_id;
  END IF;
  IF expected IS NULL OR u.client_id IS DISTINCT FROM expected OR u.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'payment % is declared from a UPI ID that is not the payer''s own verified one', NEW.id USING ERRCODE = 'IX145';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiat_transfer_payer_upi BEFORE INSERT ON fiat_transfer
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_fiat_payer_upi();

-- 4. What the inbox says ---------------------------------------------------------------------------------------------

ALTER TABLE client_notification DROP CONSTRAINT client_notification_kind_check;
ALTER TABLE client_notification ADD CONSTRAINT client_notification_kind_check CHECK (kind IN (
  'QUOTE_SENT', 'QUOTE_EXPIRED', 'REQUEST_DECLINED', 'TRADE_OPENED', 'PAYOUT_CONFIRMED', 'TRADE_COMPLETED', 'TRADE_CANCELLED',
  'DESTINATION_ADDED', 'DESTINATION_ARCHIVED', 'TRADE_DESTINATION_CHANGED',
  'TRADER_APPROVED', 'TRADER_REJECTED', 'TRADER_PAUSED', 'TRADER_RESUMED', 'TRADER_ORDER_NEW', 'TRADER_ORDER_ACCEPTED',
  'TRADER_ACTION_REQUIRED', 'TRADER_PAYMENT_CONFIRMED', 'TRADER_ORDER_COMPLETED', 'TRADER_ORDER_CLOSED', 'TRADER_RESERVE_ISSUE',
  'PAYMENT_RETURNED', 'TEAM_CHANGED', 'P2P_DISPUTE_OPENED', 'P2P_DISPUTE_DECIDED', 'P2P_REFUND', 'DESK_NOTICE',
  'DEAL_MESSAGE', 'P2P_PAY_FINAL', 'P2P_RECEIPT_LATE', 'TRADER_SETTLEMENT_CHANGE', 'TRADER_PRICE_REQUEST',
  'P2P_PAY_NOW', 'P2P_PAYMENT_SENT', 'TRADER_SIDE_EMPTY', 'DESTINATION_REJECTED'));

-- Grants -------------------------------------------------------------------------------------------------------------

GRANT SELECT, INSERT ON upi_id TO inrp2p_app;
GRANT UPDATE (status, label, per_payment_limit_minor, daily_limit_minor, verified_name, reviewed_by, reviewed_at, review_note, archived_by, archived_at, archive_reason, updated_at) ON upi_id TO inrp2p_app;
GRANT SELECT ON upi_id TO inrp2p_readonly;
