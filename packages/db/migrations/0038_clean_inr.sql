-- 0038 Clean INR (ADR 0018): rupees count only when they came from the payer's own registered account.
--
-- In India the costly failure of a crypto desk is not a bad rate but a frozen bank account: rupees that a scam
-- victim was made to send reach the desk through a "payer" who is not their owner, a cyber-crime complaint follows
-- them, and the bank freezes every account they touched. So the exchange takes INR only from the client's (or the
-- trader's) own registered account, under the trade's own reference, and counts it only once the sender has been
-- seen to be that account's holder.
--
-- 1. Collection details. An INR account that collects says who payers pay (`beneficiary_name`) and, when it has one,
--    its UPI ID (`upi_vpa`), so a client can pay by scanning a code instead of typing an account number.
-- 2. `trade_collection`: a BUY trade's payment instructions, fixed when the quote is accepted — the account to pay,
--    the trade's own payment reference, and the time the client has to pay (IX117). Never changed afterwards.
-- 3. Declared source. A recorded INR payment from a client or a trader names the payer's registered bank account it
--    came from (`fiat_transfer.payer_bank_account_id`, IX118) and who filed the reference (`filed_by`).
-- 4. `fiat_sender_check`: who the sender of a credit was seen to be — on the bank statement or by a person looking at
--    the account — and the verdict against the declared account. Append-only; the latest check is the one that
--    counts, and a person may accept a partial match only, with the reason (IX119).
-- 5. IX116: a client's INR payment, and a trader's INR into the exchange, are confirmed only when the latest sender
--    check says MATCH (or ACCEPTED by a person over a partial one), and no statement ever showed someone else.
-- 6. `INR_UNEXPECTED_SENDER`: rupees from someone other than the payer — returned to where they came from, never kept.
--
-- Additive: every existing payment flow keeps working; what changes is that a credit from a stranger can no longer
-- be counted.

-- 1. Collection details --------------------------------------------------------------------------------------------

ALTER TABLE inr_settlement_account
  ADD COLUMN upi_vpa text CHECK (upi_vpa IS NULL OR upi_vpa ~ '^[a-z0-9][a-z0-9._-]{1,255}@[a-z][a-z0-9.-]{1,63}$'),
  ADD COLUMN beneficiary_name text CHECK (beneficiary_name IS NULL OR length(btrim(beneficiary_name)) BETWEEN 1 AND 140);
DROP TRIGGER inr_settlement_account_immutable ON inr_settlement_account;
CREATE TRIGGER inr_settlement_account_immutable BEFORE UPDATE ON inr_settlement_account
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'default_daily_capacity_minor', 'notes', 'updated_at', 'version', 'upi_vpa', 'beneficiary_name');

-- 2. A BUY trade's payment instructions ----------------------------------------------------------------------------

CREATE TABLE trade_collection (
  trade_id       uuid PRIMARY KEY REFERENCES trade (id),
  inr_account_id uuid NOT NULL REFERENCES inr_settlement_account (id),
  -- The trade's own payment reference: 'P' and seven Crockford base-32 characters, put in the transfer's remarks.
  reference      text NOT NULL UNIQUE CHECK (reference ~ '^P[0-9ABCDEFGHJKMNPQRSTVWXYZ]{7}$'),
  pay_by         timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT inrp2p_now(),
  CHECK (pay_by > created_at)
);
CREATE INDEX trade_collection_account_idx ON trade_collection (inr_account_id);
CREATE INDEX trade_collection_pay_by_idx ON trade_collection (pay_by);
CREATE TRIGGER trade_collection_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON trade_collection
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- IX117: only a BUY trade collects, into an account that is active and collects.
CREATE FUNCTION inrp2p_guard_trade_collection() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t_direction text;
  a record;
BEGIN
  SELECT direction INTO t_direction FROM trade WHERE id = NEW.trade_id;
  IF t_direction IS DISTINCT FROM 'BUY_USDT' THEN
    RAISE EXCEPTION 'only a BUY trade collects INR from its client' USING ERRCODE = 'IX117';
  END IF;
  SELECT direction, status INTO a FROM inr_settlement_account WHERE id = NEW.inr_account_id;
  IF a.status IS DISTINCT FROM 'ACTIVE' OR a.direction NOT IN ('COLLECTION', 'BOTH') THEN
    RAISE EXCEPTION 'INR account % does not collect', NEW.inr_account_id USING ERRCODE = 'IX117';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trade_collection_guard BEFORE INSERT ON trade_collection
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_trade_collection();

-- 3. Declared source -----------------------------------------------------------------------------------------------

ALTER TABLE fiat_transfer
  ADD COLUMN payer_bank_account_id uuid REFERENCES bank_account (id),
  ADD COLUMN filed_by text NOT NULL DEFAULT 'DESK' CHECK (filed_by IN ('DESK', 'CLIENT', 'TRADER'));

-- IX118: the account a payment is declared from is the payer's own — the client's for a client, the route trader's for
-- a trader's route — and only a payer that is a person or a trader declares one.
CREATE FUNCTION inrp2p_guard_fiat_payer_account() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner uuid;
  expected uuid;
BEGIN
  IF NEW.payer_bank_account_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT client_id INTO owner FROM bank_account WHERE id = NEW.payer_bank_account_id;
  IF NEW.payer_type = 'CLIENT' THEN
    expected := NEW.payer_id;
  ELSIF NEW.payer_type = 'ROUTE' THEN
    SELECT tp.client_id INTO expected FROM liquidity_route r JOIN trader_profile tp ON tp.id = r.trader_id WHERE r.id = NEW.payer_id;
  END IF;
  IF expected IS NULL OR owner IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'payment % is declared from an account that is not the payer''s own', NEW.id USING ERRCODE = 'IX118';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiat_transfer_payer_account BEFORE INSERT ON fiat_transfer
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_fiat_payer_account();

-- 4. Who sent it -----------------------------------------------------------------------------------------------------

ALTER TABLE bank_statement_line
  ADD COLUMN sender_name text CHECK (sender_name IS NULL OR length(btrim(sender_name)) BETWEEN 1 AND 140),
  ADD COLUMN sender_account text CHECK (sender_account IS NULL OR length(btrim(sender_account)) BETWEEN 1 AND 80);

CREATE TABLE fiat_sender_check (
  id                       uuid PRIMARY KEY DEFAULT uuidv7(),
  fiat_transfer_id         uuid NOT NULL REFERENCES fiat_transfer (id),
  via                      text NOT NULL CHECK (via IN ('STATEMENT', 'DESK')),
  -- What the bank showed: the remitter's name, and the sending account's digits or UPI ID.
  seen_name                text CHECK (seen_name IS NULL OR length(btrim(seen_name)) BETWEEN 1 AND 140),
  seen_account             text CHECK (seen_account IS NULL OR length(btrim(seen_account)) BETWEEN 1 AND 80),
  -- The registered account it was judged against (the declared one, or the payer's account the name matched best).
  expected_bank_account_id uuid REFERENCES bank_account (id),
  verdict                  text NOT NULL CHECK (verdict IN ('MATCH', 'PARTIAL', 'MISMATCH', 'UNKNOWN', 'ACCEPTED')),
  -- Word by word, the account comparison and the narration it came from: what a person reviewing it needs.
  detail                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  statement_line_id        uuid REFERENCES bank_statement_line (id),
  reason                   text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 3 AND 500),
  checked_by               text NOT NULL CHECK (length(checked_by) BETWEEN 1 AND 100),
  checked_at               timestamptz NOT NULL DEFAULT inrp2p_now(),
  CHECK ((via = 'STATEMENT') = (statement_line_id IS NOT NULL)),
  CHECK (verdict <> 'ACCEPTED' OR (via = 'DESK' AND reason IS NOT NULL)),
  CHECK (verdict IN ('UNKNOWN', 'ACCEPTED') OR seen_name IS NOT NULL OR seen_account IS NOT NULL)
);
CREATE INDEX fiat_sender_check_transfer_idx ON fiat_sender_check (fiat_transfer_id, checked_at DESC, id DESC);
CREATE TRIGGER fiat_sender_check_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON fiat_sender_check
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- Whether a payment's rupees must be shown to be the payer's own before they count: every payment into the exchange
-- from a client, and from a trader's route.
CREATE FUNCTION inrp2p_fiat_needs_sender_check(f fiat_transfer) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT f.payee_type = 'EXCHANGE_ACCOUNT' AND (
    f.payer_type = 'CLIENT'
    OR (f.payer_type = 'ROUTE' AND EXISTS (SELECT 1 FROM liquidity_route r WHERE r.id = f.payer_id AND r.trader_id IS NOT NULL))
  )
$$;

-- The verdict that counts now: the latest check. A statement that once showed someone else is never outvoted; a
-- statement that showed too little (a cut-off name, initials) does not undo what a person saw in full on the bank's
-- own screen — it counts only where nobody has looked.
CREATE FUNCTION inrp2p_fiat_sender_verdict(transfer_id uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM fiat_sender_check c WHERE c.fiat_transfer_id = transfer_id AND c.via = 'STATEMENT' AND c.verdict = 'MISMATCH') THEN 'MISMATCH'
    ELSE coalesce((
      SELECT c.verdict FROM fiat_sender_check c
      WHERE c.fiat_transfer_id = transfer_id
        AND (c.via = 'DESK' OR c.verdict = 'MATCH'
             OR NOT EXISTS (SELECT 1 FROM fiat_sender_check d WHERE d.fiat_transfer_id = transfer_id AND d.via = 'DESK'))
      ORDER BY c.checked_at DESC, c.id DESC LIMIT 1), 'NOT_CHECKED')
  END
$$;

-- IX119: a person accepts only a partial match — never a stranger, and never a credit nobody has looked at — and only
-- while the payment is still open; nothing is checked for a payment that needs no check.
CREATE FUNCTION inrp2p_guard_fiat_sender_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  f fiat_transfer;
BEGIN
  SELECT * INTO f FROM fiat_transfer WHERE id = NEW.fiat_transfer_id FOR UPDATE;
  IF NOT inrp2p_fiat_needs_sender_check(f) THEN
    RAISE EXCEPTION 'payment % is not one whose sender is checked', NEW.fiat_transfer_id USING ERRCODE = 'IX119';
  END IF;
  IF f.status <> 'RECORDED' AND NEW.via = 'DESK' THEN
    RAISE EXCEPTION 'payment % is % — its sender is no longer decided by hand', NEW.fiat_transfer_id, f.status USING ERRCODE = 'IX119';
  END IF;
  IF NEW.verdict = 'ACCEPTED' AND inrp2p_fiat_sender_verdict(NEW.fiat_transfer_id) <> 'PARTIAL' THEN
    RAISE EXCEPTION 'only a partial match can be accepted as the payer''s own (it is %)', inrp2p_fiat_sender_verdict(NEW.fiat_transfer_id) USING ERRCODE = 'IX119';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiat_sender_check_guard BEFORE INSERT ON fiat_sender_check
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_fiat_sender_check();

-- IX116: rupees from a client, or from a trader's route, count only once their sender is the payer.
CREATE FUNCTION inrp2p_guard_fiat_confirm_sender() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  verdict text;
BEGIN
  IF NEW.status = 'CONFIRMED' AND OLD.status = 'RECORDED' AND inrp2p_fiat_needs_sender_check(NEW) THEN
    verdict := inrp2p_fiat_sender_verdict(NEW.id);
    IF verdict NOT IN ('MATCH', 'ACCEPTED') THEN
      RAISE EXCEPTION 'payment % cannot count: its sender is % (the payer''s own account must be seen to have sent it)', NEW.id, verdict USING ERRCODE = 'IX116';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiat_transfer_confirm_sender BEFORE UPDATE OF status ON fiat_transfer
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_fiat_confirm_sender();

-- 6. Exceptions ------------------------------------------------------------------------------------------------------

ALTER TABLE exception_case DROP CONSTRAINT exception_case_type_check;
ALTER TABLE exception_case ADD CONSTRAINT exception_case_type_check CHECK (type IN (
  'USDT_WRONG_AMOUNT', 'USDT_OVERPAYMENT', 'USDT_UNEXPECTED_SENDER', 'WRONG_NETWORK', 'TX_NOT_FINAL',
  'ROUTE_DIRECT_PAYOUT_MISMATCH', 'FUNDS_AFTER_TRADE_CLOSED', 'UNALLOCATED_DEPOSIT', 'DEPOSIT_POOL_LOW',
  'ROUTE_SETTLEMENT_MISMATCH', 'ROUTE_OBLIGATION_OVERDUE', 'DUPLICATE_TX_HASH', 'DUPLICATE_UTR',
  'PARTIAL_INR_PAYOUT', 'INR_PAYOUT_DELAYED', 'BANK_TRANSFER_FAILED', 'CLIENT_BANK_CHANGED',
  'ROUTE_CAPACITY_CHANGED', 'TRADE_CANCELLATION', 'OPERATOR_MISTAKE', 'RECONCILIATION_MISMATCH',
  'CHAIN_SEND_UNRESOLVED', 'NETWORK_BUDGET_SHORT', 'INR_UNEXPECTED_SENDER'));

-- The client hears at once when rupees came from someone else: they are going back, and do not count.
ALTER TABLE client_notification DROP CONSTRAINT client_notification_kind_check;
ALTER TABLE client_notification ADD CONSTRAINT client_notification_kind_check CHECK (kind IN (
  'QUOTE_SENT', 'QUOTE_EXPIRED', 'REQUEST_DECLINED', 'TRADE_OPENED', 'PAYOUT_CONFIRMED', 'TRADE_COMPLETED', 'TRADE_CANCELLED',
  'DESTINATION_ADDED', 'DESTINATION_ARCHIVED', 'TRADE_DESTINATION_CHANGED',
  'TRADER_APPROVED', 'TRADER_REJECTED', 'TRADER_PAUSED', 'TRADER_RESUMED', 'TRADER_ORDER_NEW', 'TRADER_ORDER_ACCEPTED',
  'TRADER_ACTION_REQUIRED', 'TRADER_PAYMENT_CONFIRMED', 'TRADER_ORDER_COMPLETED', 'TRADER_ORDER_CLOSED', 'TRADER_RESERVE_ISSUE',
  'PAYMENT_RETURNED'));

-- Grants --------------------------------------------------------------------------------------------------------------

GRANT SELECT, INSERT ON trade_collection, fiat_sender_check TO inrp2p_app;
GRANT UPDATE (upi_vpa, beneficiary_name) ON inr_settlement_account TO inrp2p_app;
GRANT SELECT ON trade_collection, fiat_sender_check TO inrp2p_readonly;
GRANT SELECT (upi_vpa, beneficiary_name) ON inr_settlement_account TO inrp2p_readonly;
GRANT EXECUTE ON FUNCTION inrp2p_fiat_needs_sender_check(fiat_transfer), inrp2p_fiat_sender_verdict(uuid) TO inrp2p_app, inrp2p_readonly;
