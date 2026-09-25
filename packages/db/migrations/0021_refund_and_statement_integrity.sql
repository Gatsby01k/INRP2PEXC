-- 0021 refunds never exceed the client's confirmed funds; an ambiguous statement line is recorded as ambiguous.

-- FI-25: every refund leg that is planned, in flight or done is money promised back to the client, so together
-- they may never exceed what the client actually sent (its confirmed client legs). Before this, a refund was
-- sized against completed refunds only, so two planned refunds could each return the whole amount.
--
-- Checked at commit, whatever path wrote the legs. The trade row is locked first, so two transactions adding
-- refunds to one trade are checked one after the other and the second sees the first; every command that writes a
-- leg already holds that lock, for which this is a no-op.
CREATE FUNCTION inrp2p_check_refund_total() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  refunds bigint;
  received bigint;
BEGIN
  PERFORM 1 FROM trade WHERE id = NEW.trade_id FOR UPDATE;
  SELECT coalesce(sum(amount_minor) FILTER (WHERE side = 'REFUND_TO_CLIENT' AND status IN ('PENDING', 'PROCESSING', 'COMPLETED')), 0),
         coalesce(sum(amount_minor) FILTER (WHERE side = 'CLIENT_TO_EXCHANGE' AND status = 'COMPLETED'), 0)
    INTO refunds, received
    FROM settlement_leg
   WHERE trade_id = NEW.trade_id;
  IF refunds > received THEN
    RAISE EXCEPTION 'refund legs of trade % total % over the % the client sent', NEW.trade_id, refunds, received USING ERRCODE = 'IX025';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER settlement_leg_refunds_within_received AFTER INSERT OR UPDATE ON settlement_leg
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.side = 'REFUND_TO_CLIENT')
  EXECUTE FUNCTION inrp2p_check_refund_total();

-- SECURITY S7: a statement line is matched only when account, reference, direction and amount together identify
-- exactly one recorded transfer. A reference that several transfers on the account share (FI-22 makes a UTR
-- unique per rail, not across rails) with no single one fitting is AMBIGUOUS: it names no transfer, because
-- choosing one would be a guess, and it opens a reconciliation case instead.
ALTER TABLE bank_statement_line DROP CONSTRAINT bank_statement_line_outcome_check;
ALTER TABLE bank_statement_line DROP CONSTRAINT bank_statement_line_check;
ALTER TABLE bank_statement_line ADD CONSTRAINT bank_statement_line_outcome_check
  CHECK (outcome IN ('MATCHED', 'MISMATCHED', 'UNRECORDED', 'AMBIGUOUS'));
ALTER TABLE bank_statement_line ADD CONSTRAINT bank_statement_line_transfer_check
  CHECK ((outcome IN ('UNRECORDED', 'AMBIGUOUS')) = (fiat_transfer_id IS NULL));
