-- 0042 A P2P deal's chat, and its rupees paid on each rail's own time (docs/adr/0023-deal-chat-and-inr-timing.md).
--
-- 1. The trader programme names how long each step of a P2P deal may take (`p2p_timing`): the trader funding a BUY's
--    escrow, the buyer sending the rupees — by rail (UPI 15, IMPS 30, NEFT 60, RTGS 45 minutes) — the short final period
--    after that, and how long a payee has to confirm rupees said to be sent, by rail (NEFT and RTGS longer). A person
--    changes it; nothing is written into code.
-- 2. `p2p_pay_window`: one deal's time to pay, opened when the escrow is final and the payee's account is shown. Its
--    method is the buyer's (or the one the amount suggests), its timing is the programme's when it opened, and its
--    deadline is its method's time from then — so a buyer can choose a slower rail, but never stretch the window past
--    the slowest one (IX135). Missed, the buyer is warned and has the final period; only then is the deal cancelled.
-- 3. `deal_message` and `deal_file`: the private chat of a P2P deal — the client, the trader and INRP2P's people, the
--    receipts and screenshots they attach. Append-only: the history is kept. The chat never moves money (IX134).
-- 4. `P2P_SUPPORT`: the case a side opens to call INRP2P into the deal's chat. A warning, not a hold.
-- 5. The client's inbox learns of a new message, of the final period to pay, and of rupees not confirmed in time.
--
-- Error codes IX134–IX135 belong to this migration. 0001–0041 are not edited.


-- 1. The programme's timing ------------------------------------------------------------------------------------------

-- A whole number of minutes, read from text, in a range — false (never an error) for anything else.
CREATE FUNCTION inrp2p_minutes_between(v text, lo integer, hi integer) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v ~ '^[0-9]{1,5}$' THEN v::integer BETWEEN lo AND hi ELSE false END
$$;

CREATE FUNCTION inrp2p_valid_p2p_timing(t jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_typeof(t) = 'object'
     AND inrp2p_minutes_between(t->>'escrowMinutes', 10, 120)
     AND inrp2p_minutes_between(t->>'finalMinutes', 2, 30)
     AND jsonb_typeof(t->'pay') = 'object' AND jsonb_typeof(t->'receipt') = 'object'
     AND inrp2p_minutes_between(t->'pay'->>'UPI', 5, 240) AND inrp2p_minutes_between(t->'pay'->>'IMPS', 5, 240)
     AND inrp2p_minutes_between(t->'pay'->>'NEFT', 5, 240) AND inrp2p_minutes_between(t->'pay'->>'RTGS', 5, 240)
     AND inrp2p_minutes_between(t->'receipt'->>'UPI', 10, 1440) AND inrp2p_minutes_between(t->'receipt'->>'IMPS', 10, 1440)
     AND inrp2p_minutes_between(t->'receipt'->>'NEFT', 10, 1440) AND inrp2p_minutes_between(t->'receipt'->>'RTGS', 10, 1440), false)
$$;

ALTER TABLE trader_program ADD COLUMN p2p_timing jsonb NOT NULL
  DEFAULT '{"escrowMinutes": 30, "finalMinutes": 5, "pay": {"UPI": 15, "IMPS": 30, "NEFT": 60, "RTGS": 45}, "receipt": {"UPI": 30, "IMPS": 30, "NEFT": 180, "RTGS": 90}}'
  CHECK (inrp2p_valid_p2p_timing(p2p_timing));
GRANT UPDATE (p2p_timing) ON trader_program TO inrp2p_app;


-- 2. One deal's time to pay ------------------------------------------------------------------------------------------

-- The rail a P2P payment of this many rupees is suggested to go by: UPI up to ₹1 lakh, IMPS up to ₹5 lakh, RTGS above.
CREATE FUNCTION inrp2p_p2p_default_rail(p_inr_minor bigint) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_inr_minor <= 10000000 THEN 'UPI' WHEN p_inr_minor <= 50000000 THEN 'IMPS' ELSE 'RTGS' END
$$;

CREATE TABLE p2p_pay_window (
  trade_id     uuid PRIMARY KEY REFERENCES trade (id),
  -- When the escrow was final and the payee's account was shown to the buyer: the countdown's start.
  opened_at    timestamptz NOT NULL,
  method       text NOT NULL CHECK (method IN ('IMPS', 'NEFT', 'RTGS', 'UPI')),
  -- Who chose the method; null while it is the one the amount suggests.
  chosen_by    uuid REFERENCES auth_user (id),
  -- The programme's timing when the window opened: a change of policy never moves a running deal's deadline.
  timing       jsonb NOT NULL CHECK (inrp2p_valid_p2p_timing(timing)),
  due_at       timestamptz NOT NULL,
  -- The end of the final period: the deal is cancelled only after it, and only once the buyer was warned.
  final_until  timestamptz NOT NULL,
  changes      smallint NOT NULL DEFAULT 0 CHECK (changes BETWEEN 0 AND 3),
  warned_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT inrp2p_now(),
  updated_at   timestamptz NOT NULL DEFAULT inrp2p_now(),
  CHECK (warned_at IS NULL OR warned_at >= due_at)
);
CREATE TRIGGER p2p_pay_window_immutable BEFORE UPDATE ON p2p_pay_window
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('method', 'chosen_by', 'due_at', 'final_until', 'changes', 'warned_at', 'updated_at');
CREATE TRIGGER p2p_pay_window_no_delete BEFORE DELETE OR TRUNCATE ON p2p_pay_window
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- IX135: a P2P deal's window is its method's time from when it opened, then at least the final period; its method does
-- not change once the rupees are said to be sent.
CREATE FUNCTION inrp2p_guard_p2p_pay_window() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM trade_economics e WHERE e.trade_id = NEW.trade_id AND e.route_execution_mode = 'P2P') THEN
    RAISE EXCEPTION 'a payment window belongs to a P2P deal' USING ERRCODE = 'IX135';
  END IF;
  IF NEW.due_at <> NEW.opened_at + make_interval(mins => (NEW.timing->'pay'->>NEW.method)::integer) THEN
    RAISE EXCEPTION 'a payment window is its method''s time from when it opened' USING ERRCODE = 'IX135';
  END IF;
  IF NEW.final_until < NEW.due_at + make_interval(mins => (NEW.timing->>'finalMinutes')::integer) THEN
    RAISE EXCEPTION 'a payment window ends with its final period' USING ERRCODE = 'IX135';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.method IS DISTINCT FROM OLD.method AND EXISTS (
       SELECT 1 FROM settlement_leg l
        WHERE l.trade_id = NEW.trade_id AND l.asset = 'INR' AND l.status IN ('PENDING', 'PROCESSING', 'COMPLETED')
          AND (l.side = 'CLIENT_TO_EXCHANGE' OR (l.side = 'EXCHANGE_TO_CLIENT' AND l.payer = 'ROUTE'))) THEN
    RAISE EXCEPTION 'the rupees of this deal are said to be sent: its method no longer changes' USING ERRCODE = 'IX135';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER p2p_pay_window_guard BEFORE INSERT OR UPDATE ON p2p_pay_window
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_p2p_pay_window();

-- Deals already waiting for their rupees keep the rule they opened under: 30 minutes from the escrow, for every rail.
INSERT INTO p2p_pay_window (trade_id, opened_at, method, timing, due_at, final_until)
SELECT d.trade_id, d.funded_at, inrp2p_p2p_default_rail(d.inr_minor),
       '{"escrowMinutes": 30, "finalMinutes": 5, "pay": {"UPI": 30, "IMPS": 30, "NEFT": 30, "RTGS": 30}, "receipt": {"UPI": 30, "IMPS": 30, "NEFT": 30, "RTGS": 30}}'::jsonb,
       d.funded_at + interval '30 minutes', d.funded_at + interval '35 minutes'
  FROM (
    SELECT t.id AS trade_id, e.quote_inr_minor AS inr_minor,
           (SELECT max(s.confirmed_at) FROM route_settlement s
             WHERE s.route_obligation_id = o.id AND s.flow = 'FROM_ROUTE_TO_EXCHANGE' AND s.status = 'CONFIRMED') AS funded_at
      FROM trade t
      JOIN trade_economics e ON e.trade_id = t.id
      JOIN route_obligation o ON o.trade_id = t.id
     WHERE e.route_execution_mode = 'P2P' AND t.direction = 'BUY_USDT' AND t.lifecycle_state = 'AWAITING_FIRST_LEG'
       AND inrp2p_counterparty_delivered(o.id)
       AND NOT EXISTS (SELECT 1 FROM settlement_leg l WHERE l.trade_id = t.id AND l.side = 'CLIENT_TO_EXCHANGE')
    UNION ALL
    SELECT t.id, e.quote_inr_minor,
           (SELECT max(l.confirmed_at) FROM settlement_leg l WHERE l.trade_id = t.id AND l.side = 'CLIENT_TO_EXCHANGE' AND l.status = 'COMPLETED')
      FROM trade t
      JOIN trade_economics e ON e.trade_id = t.id
     WHERE e.route_execution_mode = 'P2P' AND t.direction = 'SELL_USDT' AND t.lifecycle_state IN ('FIRST_LEG_CONFIRMED', 'SETTLING')
       AND NOT EXISTS (SELECT 1 FROM settlement_leg l WHERE l.trade_id = t.id AND l.side = 'EXCHANGE_TO_CLIENT' AND l.status IN ('PENDING', 'PROCESSING', 'COMPLETED'))
       AND NOT EXISTS (SELECT 1 FROM p2p_unwind u WHERE u.trade_id = t.id)
  ) d
 WHERE d.funded_at IS NOT NULL;


-- 3. The deal's chat -------------------------------------------------------------------------------------------------

-- A receipt or a screenshot a side of the deal (or INRP2P) attached. Kept here, private: served only through the
-- application to the people of this deal, never from a public URL. The bytes are checked to be what their type says.
CREATE TABLE deal_file (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  trade_id      uuid NOT NULL REFERENCES trade (id),
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  content_type  text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  byte_size     integer NOT NULL CHECK (byte_size BETWEEN 1 AND 3145728),
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  body          bytea NOT NULL,
  uploaded_by   uuid NOT NULL REFERENCES auth_user (id),
  created_at    timestamptz NOT NULL DEFAULT inrp2p_now(),
  CHECK (octet_length(body) = byte_size)
);
CREATE INDEX deal_file_trade_idx ON deal_file (trade_id);
CREATE TRIGGER deal_file_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON deal_file
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

CREATE TABLE deal_message (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  trade_id           uuid NOT NULL REFERENCES trade (id),
  -- The side that wrote it: the trade's client, the route's trader, or INRP2P's people.
  author             text NOT NULL CHECK (author IN ('CLIENT', 'TRADER', 'INRP2P')),
  author_user_id     uuid NOT NULL REFERENCES auth_user (id),
  kind               text NOT NULL DEFAULT 'TEXT' CHECK (kind IN ('TEXT', 'RECEIPT', 'SUPPORT_CALLED', 'SUPPORT_JOINED')),
  body               text CHECK (body IS NULL OR length(btrim(body)) BETWEEN 1 AND 2000),
  file_id            uuid UNIQUE REFERENCES deal_file (id),
  -- A receipt names the rupee payment it is for.
  settlement_leg_id  uuid REFERENCES settlement_leg (id),
  created_at         timestamptz NOT NULL DEFAULT inrp2p_now(),
  CHECK (body IS NOT NULL OR file_id IS NOT NULL),
  CHECK ((kind = 'RECEIPT') = (settlement_leg_id IS NOT NULL)),
  CHECK (kind <> 'RECEIPT' OR file_id IS NOT NULL),
  CHECK (kind NOT IN ('SUPPORT_CALLED', 'SUPPORT_JOINED') OR file_id IS NULL),
  CHECK (kind <> 'SUPPORT_JOINED' OR author = 'INRP2P'),
  CHECK (kind <> 'SUPPORT_CALLED' OR author <> 'INRP2P')
);
CREATE INDEX deal_message_trade_idx ON deal_message (trade_id, created_at);
CREATE INDEX deal_message_author_idx ON deal_message (author_user_id, created_at);
CREATE TRIGGER deal_message_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON deal_message
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- IX134: a chat is a P2P deal's; a message carries only a file of its own deal its author uploaded, and a receipt only
-- for a rupee payment of that deal.
CREATE FUNCTION inrp2p_guard_deal_message() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trade_economics e WHERE e.trade_id = NEW.trade_id AND e.route_execution_mode = 'P2P') THEN
    RAISE EXCEPTION 'a deal chat belongs to a P2P deal' USING ERRCODE = 'IX134';
  END IF;
  IF NEW.file_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM deal_file f WHERE f.id = NEW.file_id AND f.trade_id = NEW.trade_id AND f.uploaded_by = NEW.author_user_id) THEN
    RAISE EXCEPTION 'a message carries a file of its own deal, uploaded by its author' USING ERRCODE = 'IX134';
  END IF;
  IF NEW.settlement_leg_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM settlement_leg l WHERE l.id = NEW.settlement_leg_id AND l.trade_id = NEW.trade_id AND l.asset = 'INR'
          AND (l.side = 'CLIENT_TO_EXCHANGE' OR (l.side = 'EXCHANGE_TO_CLIENT' AND l.payer = 'ROUTE'))) THEN
    RAISE EXCEPTION 'a receipt is for a rupee payment of its own deal' USING ERRCODE = 'IX134';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER deal_message_guard BEFORE INSERT ON deal_message
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_deal_message();
CREATE FUNCTION inrp2p_guard_deal_file() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trade_economics e WHERE e.trade_id = NEW.trade_id AND e.route_execution_mode = 'P2P') THEN
    RAISE EXCEPTION 'a deal file belongs to a P2P deal' USING ERRCODE = 'IX134';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER deal_file_guard BEFORE INSERT ON deal_file
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_deal_file();


-- 4. Calling INRP2P in ------------------------------------------------------------------------------------------------

ALTER TABLE exception_case DROP CONSTRAINT exception_case_type_check;
ALTER TABLE exception_case ADD CONSTRAINT exception_case_type_check CHECK (type IN (
  'USDT_WRONG_AMOUNT', 'USDT_OVERPAYMENT', 'USDT_UNEXPECTED_SENDER', 'WRONG_NETWORK', 'TX_NOT_FINAL',
  'ROUTE_DIRECT_PAYOUT_MISMATCH', 'FUNDS_AFTER_TRADE_CLOSED', 'UNALLOCATED_DEPOSIT', 'DEPOSIT_POOL_LOW',
  'ROUTE_SETTLEMENT_MISMATCH', 'ROUTE_OBLIGATION_OVERDUE', 'DUPLICATE_TX_HASH', 'DUPLICATE_UTR',
  'PARTIAL_INR_PAYOUT', 'INR_PAYOUT_DELAYED', 'BANK_TRANSFER_FAILED', 'CLIENT_BANK_CHANGED',
  'ROUTE_CAPACITY_CHANGED', 'TRADE_CANCELLATION', 'OPERATOR_MISTAKE', 'RECONCILIATION_MISMATCH',
  'CHAIN_SEND_UNRESOLVED', 'NETWORK_BUDGET_SHORT', 'INR_UNEXPECTED_SENDER',
  'P2P_PAYMENT_OVERDUE', 'P2P_RECEIPT_OVERDUE', 'P2P_DISPUTE', 'GASFREE_UNAVAILABLE', 'P2P_SUPPORT'));


-- 5. What the inbox says ---------------------------------------------------------------------------------------------

ALTER TABLE client_notification DROP CONSTRAINT client_notification_kind_check;
ALTER TABLE client_notification ADD CONSTRAINT client_notification_kind_check CHECK (kind IN (
  'QUOTE_SENT', 'QUOTE_EXPIRED', 'REQUEST_DECLINED', 'TRADE_OPENED', 'PAYOUT_CONFIRMED', 'TRADE_COMPLETED', 'TRADE_CANCELLED',
  'DESTINATION_ADDED', 'DESTINATION_ARCHIVED', 'TRADE_DESTINATION_CHANGED',
  'TRADER_APPROVED', 'TRADER_REJECTED', 'TRADER_PAUSED', 'TRADER_RESUMED', 'TRADER_ORDER_NEW', 'TRADER_ORDER_ACCEPTED',
  'TRADER_ACTION_REQUIRED', 'TRADER_PAYMENT_CONFIRMED', 'TRADER_ORDER_COMPLETED', 'TRADER_ORDER_CLOSED', 'TRADER_RESERVE_ISSUE',
  'PAYMENT_RETURNED', 'TEAM_CHANGED', 'P2P_DISPUTE_OPENED', 'P2P_DISPUTE_DECIDED', 'P2P_REFUND', 'DESK_NOTICE',
  'DEAL_MESSAGE', 'P2P_PAY_FINAL', 'P2P_RECEIPT_LATE'));


-- Grants -------------------------------------------------------------------------------------------------------------

GRANT SELECT, INSERT ON p2p_pay_window, deal_file, deal_message TO inrp2p_app;
GRANT UPDATE (method, chosen_by, due_at, final_until, changes, warned_at, updated_at) ON p2p_pay_window TO inrp2p_app;
GRANT SELECT ON p2p_pay_window TO inrp2p_readonly;
-- What was written and attached stays with the people of the deal: the reader role sees that a message or a file
-- exists, never its words or its bytes.
GRANT SELECT (id, trade_id, author, author_user_id, kind, file_id, settlement_leg_id, created_at) ON deal_message TO inrp2p_readonly;
GRANT SELECT (id, trade_id, content_type, byte_size, sha256, uploaded_by, created_at) ON deal_file TO inrp2p_readonly;
GRANT EXECUTE ON FUNCTION inrp2p_minutes_between(text, integer, integer), inrp2p_valid_p2p_timing(jsonb), inrp2p_p2p_default_rail(bigint) TO inrp2p_app, inrp2p_readonly;
