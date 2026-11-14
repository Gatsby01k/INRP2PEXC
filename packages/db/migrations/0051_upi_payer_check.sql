-- 0051 UPI IDs are checked by the one who pays them (ADR 0030, 2026-11-14).
--
-- ADR 0029 had a person at INRP2P look up every UPI ID a client added before anything was paid to it. What that person
-- saw — the name the address resolves to — is exactly what the payer's own UPI app shows it before it approves a payment.
-- The queue checked nothing the payer does not check anyway; it only made a client wait, nights and weekends included,
-- before it could be paid by UPI. Now:
--
-- 1. A UPI ID its owner adds is live at once (`status` ACTIVE). Until a deal paid to it has been confirmed by its owner —
--    with the payer having said its app showed the right name — it takes a smaller amount (the application's rule,
--    `usableUpiId`); after that, its own limits (`name_confirmed_at`, `name_confirmed_trade_id`).
-- 2. `p2p_pay_window.payee_name_confirmed_at`: the payer said its UPI app showed the name the deal told it to check.
-- 3. A payer whose app shows another name says so instead of paying: the UPI ID is paused (ACTIVE ─▶ PENDING_REVIEW)
--    with what it saw (`reported_*`), the deal goes on by bank transfer, and a person at INRP2P decides — verify it, or
--    reject it. A person is asked only when a payer saw something wrong.
-- 4. Inbox kind `DESTINATION_PAUSED`: the owner is told its UPI ID was paused, and why.
--
-- No error code belongs to this migration. 0001–0050 are not edited.

-- 1. A UPI ID is live when it is added --------------------------------------------------------------------------------

ALTER TABLE upi_id ALTER COLUMN status SET DEFAULT 'ACTIVE';

-- A deal paid to it, confirmed by its owner after the payer checked the name — or a person at INRP2P who looked it up.
ALTER TABLE upi_id ADD COLUMN name_confirmed_at timestamptz;
ALTER TABLE upi_id ADD COLUMN name_confirmed_trade_id uuid REFERENCES trade (id);
-- What a payer's app showed instead of the owner's name, on which deal, and who said so.
ALTER TABLE upi_id ADD COLUMN reported_name text CHECK (reported_name IS NULL OR length(btrim(reported_name)) BETWEEN 1 AND 140);
ALTER TABLE upi_id ADD COLUMN reported_at timestamptz;
ALTER TABLE upi_id ADD COLUMN reported_by text CHECK (reported_by IS NULL OR length(reported_by) BETWEEN 1 AND 100);
ALTER TABLE upi_id ADD COLUMN reported_trade_id uuid REFERENCES trade (id);

-- ACTIVE no longer means a person looked at it. A refusal still says why; a report says what was seen, and when.
ALTER TABLE upi_id DROP CONSTRAINT upi_id_review_shape;
ALTER TABLE upi_id ADD CONSTRAINT upi_id_review_shape CHECK (
  (status <> 'REJECTED' OR (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND review_note IS NOT NULL))
  AND ((reported_at IS NULL) = (reported_name IS NULL))
  AND (name_confirmed_trade_id IS NULL OR name_confirmed_at IS NOT NULL));

-- Paused by a payer's report: ACTIVE ─▶ PENDING_REVIEW. The rest as 0050 had it.
DROP TRIGGER upi_id_status ON upi_id;
CREATE TRIGGER upi_id_status BEFORE UPDATE ON upi_id
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'PENDING_REVIEW>ACTIVE,PENDING_REVIEW>REJECTED,PENDING_REVIEW>ARCHIVED,ACTIVE>ARCHIVED,ACTIVE>PENDING_REVIEW');
DROP TRIGGER upi_id_immutable ON upi_id;
CREATE TRIGGER upi_id_immutable BEFORE UPDATE ON upi_id
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns(
    'status', 'label', 'per_payment_limit_minor', 'daily_limit_minor', 'verified_name', 'reviewed_by', 'reviewed_at', 'review_note',
    'archived_by', 'archived_at', 'archive_reason', 'updated_at',
    'name_confirmed_at', 'name_confirmed_trade_id', 'reported_name', 'reported_at', 'reported_by', 'reported_trade_id');

-- What 0050 left: one a person verified keeps its full limits; one still waiting for a person is live now.
UPDATE upi_id SET name_confirmed_at = reviewed_at WHERE status = 'ACTIVE' AND verified_name IS NOT NULL AND name_confirmed_at IS NULL;
UPDATE upi_id SET status = 'ACTIVE', updated_at = statement_timestamp() WHERE status = 'PENDING_REVIEW';

-- 2. The payer checked the name ---------------------------------------------------------------------------------------

ALTER TABLE p2p_pay_window ADD COLUMN payee_name_confirmed_at timestamptz;
DROP TRIGGER p2p_pay_window_immutable ON p2p_pay_window;
CREATE TRIGGER p2p_pay_window_immutable BEFORE UPDATE ON p2p_pay_window
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('method', 'chosen_by', 'due_at', 'final_until', 'changes', 'warned_at', 'updated_at', 'payee_name_confirmed_at');

-- 4. What the inbox says ---------------------------------------------------------------------------------------------

ALTER TABLE client_notification DROP CONSTRAINT client_notification_kind_check;
ALTER TABLE client_notification ADD CONSTRAINT client_notification_kind_check CHECK (kind IN (
  'QUOTE_SENT', 'QUOTE_EXPIRED', 'REQUEST_DECLINED', 'TRADE_OPENED', 'PAYOUT_CONFIRMED', 'TRADE_COMPLETED', 'TRADE_CANCELLED',
  'DESTINATION_ADDED', 'DESTINATION_ARCHIVED', 'TRADE_DESTINATION_CHANGED',
  'TRADER_APPROVED', 'TRADER_REJECTED', 'TRADER_PAUSED', 'TRADER_RESUMED', 'TRADER_ORDER_NEW', 'TRADER_ORDER_ACCEPTED',
  'TRADER_ACTION_REQUIRED', 'TRADER_PAYMENT_CONFIRMED', 'TRADER_ORDER_COMPLETED', 'TRADER_ORDER_CLOSED', 'TRADER_RESERVE_ISSUE',
  'PAYMENT_RETURNED', 'TEAM_CHANGED', 'P2P_DISPUTE_OPENED', 'P2P_DISPUTE_DECIDED', 'P2P_REFUND', 'DESK_NOTICE',
  'DEAL_MESSAGE', 'P2P_PAY_FINAL', 'P2P_RECEIPT_LATE', 'TRADER_SETTLEMENT_CHANGE', 'TRADER_PRICE_REQUEST',
  'P2P_PAY_NOW', 'P2P_PAYMENT_SENT', 'TRADER_SIDE_EMPTY', 'DESTINATION_REJECTED', 'DESTINATION_PAUSED'));

-- Grants -------------------------------------------------------------------------------------------------------------

GRANT UPDATE (name_confirmed_at, name_confirmed_trade_id, reported_name, reported_at, reported_by, reported_trade_id) ON upi_id TO inrp2p_app;
GRANT UPDATE (payee_name_confirmed_at) ON p2p_pay_window TO inrp2p_app;
