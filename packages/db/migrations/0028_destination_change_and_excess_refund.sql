-- 0028 a changed destination for an open trade (production task D1, TD-18) and a refund of an overpayment (D2, TD-19).
--
-- D1. A trade's destination was frozen at acceptance in the insert-only `trade_economics`, so a client who replaced
--     their bank account or wallet mid-trade could only be unwound. The economics stay as they are; a change is an
--     append-only amendment, requested by one person and approved by another, to a destination of the same client
--     that is ACTIVE (verified) — and a payout goes to the destination in force, which the database checks.
-- D2. An overpayment could be re-priced to or fully refunded, never partly returned. A refund leg now says whether it
--     unwinds the trade or returns an excess; excess refunds may never exceed what arrived beyond the receivable; and
--     completion counts what the client sent net of the excess confirmed back to them.
--
-- Error codes IX092–IX093 belong to this migration. 0001–0027 are not edited.

-- ── D1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE SEQUENCE trade_destination_change_ref_seq;
CREATE TABLE trade_destination_change (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  ref                  text NOT NULL UNIQUE DEFAULT ('DC-' || inrp2p_ref_number(nextval('trade_destination_change_ref_seq'), 4)),
  trade_id             uuid NOT NULL REFERENCES trade (id),
  -- The CLIENT_BANK_CHANGED case this answers, when there is one.
  exception_case_id    uuid REFERENCES exception_case (id),
  from_bank_account_id uuid REFERENCES bank_account (id),
  from_wallet_id       uuid REFERENCES crypto_wallet (id),
  to_bank_account_id   uuid REFERENCES bank_account (id),
  to_wallet_id         uuid REFERENCES crypto_wallet (id),
  reason               text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  -- How the client confirmed the new destination (their administrator's step-up, a call to the number on file…).
  evidence             text NOT NULL CHECK (length(btrim(evidence)) BETWEEN 10 AND 1000),
  status               text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED')),
  requested_by         uuid NOT NULL REFERENCES auth_user (id),
  requested_at         timestamptz NOT NULL DEFAULT inrp2p_now(),
  decided_by           uuid REFERENCES auth_user (id),
  decided_at           timestamptz,
  decision_note        text CHECK (length(decision_note) <= 500),
  CHECK ((to_bank_account_id IS NULL) <> (to_wallet_id IS NULL)),
  CHECK ((to_bank_account_id IS NULL) = (from_bank_account_id IS NULL) AND (to_wallet_id IS NULL) = (from_wallet_id IS NULL)),
  CHECK ((status = 'REQUESTED') = (decided_at IS NULL)),
  CHECK (status NOT IN ('APPROVED', 'REJECTED') OR (decided_by IS NOT NULL AND decided_by <> requested_by)),
  CHECK (status <> 'CANCELLED' OR decided_by = requested_by)
);
CREATE UNIQUE INDEX trade_destination_change_one_open ON trade_destination_change (trade_id) WHERE status = 'REQUESTED';
CREATE INDEX trade_destination_change_trade_idx ON trade_destination_change (trade_id, decided_at);
CREATE TRIGGER trade_destination_change_status BEFORE UPDATE ON trade_destination_change
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'REQUESTED>APPROVED,REQUESTED>REJECTED,REQUESTED>CANCELLED');
CREATE TRIGGER trade_destination_change_immutable BEFORE UPDATE ON trade_destination_change
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'decided_by', 'decided_at', 'decision_note');
CREATE TRIGGER trade_destination_change_no_delete BEFORE DELETE OR TRUNCATE ON trade_destination_change
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- The destination a trade pays to now: its latest approved change, else what it was accepted with.
CREATE FUNCTION inrp2p_trade_payout_destination(p_trade uuid, OUT bank_account_id uuid, OUT wallet_id uuid)
LANGUAGE sql STABLE AS $$
  SELECT coalesce(c.to_bank_account_id, e.bank_account_id), coalesce(c.to_wallet_id, e.crypto_wallet_id)
    FROM trade_economics e
    LEFT JOIN LATERAL (
      SELECT d.to_bank_account_id, d.to_wallet_id FROM trade_destination_change d
       WHERE d.trade_id = e.trade_id AND d.status = 'APPROVED'
       ORDER BY d.decided_at DESC, d.id DESC LIMIT 1
    ) c ON true
   WHERE e.trade_id = p_trade
$$;

CREATE FUNCTION inrp2p_guard_destination_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  client uuid;
  cur record;
  ok boolean;
  inflight integer;
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (OLD.status = 'REQUESTED' AND NEW.status = 'APPROVED') THEN
    RETURN NEW;
  END IF;
  SELECT t.client_id INTO client FROM trade t WHERE t.id = NEW.trade_id;
  -- The new destination is the same client's, verified (ACTIVE), and of the kind the trade pays.
  IF NEW.to_bank_account_id IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM bank_account b WHERE b.id = NEW.to_bank_account_id AND b.client_id = client AND b.status = 'ACTIVE') INTO ok;
  ELSE
    SELECT EXISTS (SELECT 1 FROM crypto_wallet w WHERE w.id = NEW.to_wallet_id AND w.client_id = client AND w.status = 'ACTIVE' AND w.purpose IN ('DESTINATION', 'BOTH')) INTO ok;
  END IF;
  IF NOT ok THEN
    RAISE EXCEPTION 'trade % can be paid only to an active destination of its own client', NEW.trade_id USING ERRCODE = 'IX092';
  END IF;
  SELECT * INTO cur FROM inrp2p_trade_payout_destination(NEW.trade_id);
  IF NEW.from_bank_account_id IS DISTINCT FROM (CASE WHEN NEW.to_bank_account_id IS NOT NULL THEN cur.bank_account_id END)
     OR NEW.from_wallet_id IS DISTINCT FROM (CASE WHEN NEW.to_wallet_id IS NOT NULL THEN cur.wallet_id END) THEN
    RAISE EXCEPTION 'trade % no longer pays to the destination this change replaces', NEW.trade_id USING ERRCODE = 'IX092';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- A payout already sent, or still waiting to be sent, to the old destination is resolved first: never two payees.
    SELECT count(*) INTO inflight FROM settlement_leg l
     WHERE l.trade_id = NEW.trade_id AND l.side = 'EXCHANGE_TO_CLIENT' AND l.status IN ('PENDING', 'PROCESSING');
    IF inflight > 0 THEN
      RAISE EXCEPTION 'trade % has a payout planned or in flight; resolve it before changing where the trade pays', NEW.trade_id USING ERRCODE = 'IX092';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trade_destination_change_guard BEFORE INSERT OR UPDATE ON trade_destination_change
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_destination_change();

-- A payout goes to the destination in force for its trade.
CREATE FUNCTION inrp2p_guard_payout_destination() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cur record;
BEGIN
  SELECT * INTO cur FROM inrp2p_trade_payout_destination(NEW.trade_id);
  IF (NEW.asset = 'INR' AND NEW.destination_bank_account_id IS DISTINCT FROM cur.bank_account_id)
     OR (NEW.asset = 'USDT' AND NEW.destination_wallet_id IS DISTINCT FROM cur.wallet_id) THEN
    RAISE EXCEPTION 'payout leg % does not go to the destination trade % pays to now', NEW.ref, NEW.trade_id USING ERRCODE = 'IX092';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER settlement_leg_payout_destination BEFORE INSERT ON settlement_leg
  FOR EACH ROW WHEN (NEW.side = 'EXCHANGE_TO_CLIENT') EXECUTE FUNCTION inrp2p_guard_payout_destination();

GRANT SELECT, INSERT ON trade_destination_change TO inrp2p_app;
GRANT UPDATE (status, decided_by, decided_at, decision_note) ON trade_destination_change TO inrp2p_app;
GRANT SELECT ON trade_destination_change TO inrp2p_readonly;
GRANT USAGE ON SEQUENCE trade_destination_change_ref_seq TO inrp2p_app;
GRANT EXECUTE ON FUNCTION inrp2p_trade_payout_destination(uuid) TO inrp2p_app, inrp2p_readonly;

-- ── D2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
-- UNWIND returns everything the client sent before a cancellation (T10); EXCESS returns only what arrived beyond the
-- receivable, and the trade goes on. Refund legs recorded before 0028 have no kind: they are UNWIND.
ALTER TABLE settlement_leg
  ADD COLUMN refund_kind text CHECK (refund_kind IS NULL OR (side = 'REFUND_TO_CLIENT' AND refund_kind IN ('UNWIND', 'EXCESS'))),
  ADD CONSTRAINT settlement_leg_excess_refund_destination
    CHECK (refund_kind IS DISTINCT FROM 'EXCESS' OR (CASE WHEN asset = 'USDT' THEN destination_wallet_id IS NOT NULL ELSE destination_bank_account_id IS NOT NULL END));

-- FI-25 for an excess: what is planned, in flight or confirmed back as excess never exceeds what arrived beyond the
-- receivable. Checked at commit under the trade lock, like the total refunds (IX025).
CREATE FUNCTION inrp2p_check_excess_refunds() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  excess bigint;
  received bigint;
BEGIN
  PERFORM 1 FROM trade WHERE id = NEW.trade_id FOR UPDATE;
  SELECT coalesce(sum(amount_minor) FILTER (WHERE side = 'REFUND_TO_CLIENT' AND refund_kind = 'EXCESS' AND status IN ('PENDING', 'PROCESSING', 'COMPLETED')), 0),
         coalesce(sum(amount_minor) FILTER (WHERE side = 'CLIENT_TO_EXCHANGE' AND status = 'COMPLETED'), 0)
    INTO excess, received
    FROM settlement_leg WHERE trade_id = NEW.trade_id;
  IF excess > greatest(received - inrp2p_trade_receivable_obligation(NEW.trade_id), 0) THEN
    RAISE EXCEPTION 'excess refunds of trade % total % — more than arrived beyond what the trade receives', NEW.trade_id, excess USING ERRCODE = 'IX093';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER settlement_leg_excess_within_overpayment AFTER INSERT OR UPDATE ON settlement_leg
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.side = 'REFUND_TO_CLIENT')
  EXECUTE FUNCTION inrp2p_check_excess_refunds();

-- FI-21, restated: COMPLETED means the payout is fully paid and what the client sent, less the excess confirmed back to
-- them, is exactly the receivable — an excess still owed to the client keeps the trade open.
CREATE OR REPLACE FUNCTION inrp2p_guard_trade_completion() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  paid bigint;
  received bigint;
  excess_back bigint;
  blocking integer;
BEGIN
  IF NEW.lifecycle_state = 'COMPLETED' AND OLD.lifecycle_state <> 'COMPLETED' THEN
    SELECT coalesce(sum(amount_minor) FILTER (WHERE side = 'EXCHANGE_TO_CLIENT' AND status = 'COMPLETED'), 0),
           coalesce(sum(amount_minor) FILTER (WHERE side = 'CLIENT_TO_EXCHANGE' AND status = 'COMPLETED'), 0),
           coalesce(sum(amount_minor) FILTER (WHERE side = 'REFUND_TO_CLIENT' AND refund_kind = 'EXCESS' AND status = 'COMPLETED'), 0)
      INTO paid, received, excess_back
      FROM settlement_leg WHERE trade_id = NEW.id;
    IF paid <> inrp2p_trade_payout_obligation(NEW.id) OR received - excess_back <> inrp2p_trade_receivable_obligation(NEW.id) THEN
      RAISE EXCEPTION 'trade % cannot complete: paid %/% received % (less % excess returned)/%', NEW.id, paid, inrp2p_trade_payout_obligation(NEW.id),
        received, excess_back, inrp2p_trade_receivable_obligation(NEW.id) USING ERRCODE = 'IX021';
    END IF;
    SELECT count(*) INTO blocking FROM exception_case WHERE trade_id = NEW.id AND severity = 'BLOCKING' AND status IN ('OPEN', 'IN_PROGRESS');
    IF blocking > 0 THEN
      RAISE EXCEPTION 'trade % has % open blocking exception(s)', NEW.id, blocking USING ERRCODE = 'IX021';
    END IF;
    IF NEW.completed_at IS NULL THEN
      RAISE EXCEPTION 'a completed trade records completed_at' USING ERRCODE = 'IX021';
    END IF;
  END IF;
  IF NEW.lifecycle_state = 'CANCELLED' AND NEW.cancelled_at IS NULL THEN
    RAISE EXCEPTION 'a cancelled trade records cancelled_at' USING ERRCODE = 'IX040';
  END IF;
  RETURN NEW;
END
$$;

-- Every client administrator hears that a trade now pays somewhere else (D1).
ALTER TABLE client_notification DROP CONSTRAINT client_notification_kind_check;
ALTER TABLE client_notification ADD CONSTRAINT client_notification_kind_check CHECK (kind IN (
  'QUOTE_SENT', 'QUOTE_EXPIRED', 'REQUEST_DECLINED', 'TRADE_OPENED', 'PAYOUT_CONFIRMED', 'TRADE_COMPLETED', 'TRADE_CANCELLED',
  'DESTINATION_ADDED', 'DESTINATION_ARCHIVED', 'TRADE_DESTINATION_CHANGED',
  'TRADER_APPROVED', 'TRADER_REJECTED', 'TRADER_PAUSED', 'TRADER_RESUMED', 'TRADER_ORDER_NEW', 'TRADER_ORDER_ACCEPTED',
  'TRADER_ACTION_REQUIRED', 'TRADER_PAYMENT_CONFIRMED', 'TRADER_ORDER_COMPLETED', 'TRADER_ORDER_CLOSED', 'TRADER_RESERVE_ISSUE'));
