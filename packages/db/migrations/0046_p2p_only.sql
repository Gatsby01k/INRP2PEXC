-- Migration 46: only P2P remains (ADR 0027, stage 3).
--
-- Drops what served the two settlement models before P2P: the exchange's INR accounts and their capacity, statements,
-- collection, trader rewards, treasury reservations, applying a reserve to a delivery.
--
-- It never destroys a record of money. The block between the preflight marks refuses, whole and with the reasons, if
-- anything it would remove ever carried any: the migration runs in one transaction, so a refusal leaves schema 45
-- untouched. `scripts/p2p-only-preflight.ts` runs the same block in a read-only transaction, so the answer is known
-- before anyone stops anything.
--
-- What it does let go, because no money was ever behind it: a treasury reservation released without a micro-USDT of it used
-- (production has one, from its only trade, cancelled on 2026-09-20), and a draft quote nobody was ever sent (production
-- has six, on its test route).
--
-- `execution_mode` stays: fifteen financial guards read it, and rewriting them to remove one word is not worth their risk.
-- A live route and every new deal can only be P2P.

-- preflight:begin
DO $preflight$
DECLARE
  found text[] := ARRAY[]::text[];
  t text;
  n bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_statement_import', 'bank_statement_line', 'capacity_reservation', 'trade_collection', 'trader_reward_payout'] LOOP
    EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
    IF n > 0 THEN found := found || format('%s row(s) in %s', n, t); END IF;
  END LOOP;

  SELECT count(*) INTO n FROM treasury_reservation WHERE status = 'ACTIVE' OR consumed_minor <> 0;
  IF n > 0 THEN found := found || format('%s treasury reservation(s) holding USDT or having paid it', n); END IF;

  SELECT count(*) INTO n FROM inr_account_day WHERE used_minor <> 0 OR reserved_minor <> 0;
  IF n > 0 THEN found := found || format('%s INR account day(s) with capacity used or reserved', n); END IF;

  SELECT count(*) INTO n FROM settlement_leg WHERE inr_account_id IS NOT NULL OR capacity_reservation_id IS NOT NULL OR (payer = 'EXCHANGE_ACCOUNT' AND asset = 'INR');
  IF n > 0 THEN found := found || format('%s settlement leg(s) paid from an exchange INR account', n); END IF;

  SELECT count(*) INTO n FROM fiat_transfer WHERE payer_type = 'EXCHANGE_ACCOUNT' OR payee_type = 'EXCHANGE_ACCOUNT';
  IF n > 0 THEN found := found || format('%s rupee transfer(s) through an exchange INR account', n); END IF;

  SELECT count(*) INTO n FROM route_settlement WHERE capacity_reservation_id IS NOT NULL OR reserve_application_id IS NOT NULL;
  IF n > 0 THEN found := found || format('%s route settlement(s) using capacity or an applied reserve', n); END IF;

  SELECT count(*) INTO n FROM fiat_sender_check WHERE via = 'STATEMENT' OR statement_line_id IS NOT NULL;
  IF n > 0 THEN found := found || format('%s sender check(s) from a bank statement', n); END IF;

  SELECT count(*) INTO n FROM trader_reserve_application WHERE kind = 'APPLY' OR status IN ('SENT', 'COMPLETED', 'FAILED');
  IF n > 0 THEN found := found || format('%s reserve application(s) that deliver USDT', n); END IF;

  SELECT count(*) INTO n FROM treasury_wallet WHERE reserved_minor <> 0;
  IF n > 0 THEN found := found || format('%s treasury wallet(s) with USDT reserved', n); END IF;

  SELECT count(*) INTO n FROM network_budget_hold WHERE coalesce(reimbursed_sun, 0) <> 0 OR coalesce(reimbursed_inr_minor, 0) <> 0;
  IF n > 0 THEN found := found || format('%s network hold(s) with TRX paid back', n); END IF;

  SELECT count(*) INTO n FROM trader_order WHERE coalesce(reward_inr_minor, 0) <> 0;
  IF n > 0 THEN found := found || format('%s trader order(s) with a reward', n); END IF;

  SELECT count(*) INTO n FROM quote_network_fee WHERE reward_inr_minor <> 0;
  IF n > 0 THEN found := found || format('%s quote(s) counting a reward', n); END IF;

  SELECT count(*) INTO n FROM ledger_account_balance
   WHERE (code LIKE 'ASSET:INR_SETTLEMENT:%' OR code LIKE 'LIAB:TRADER_REWARD_PAYABLE:%') AND dr_minus_cr_minor <> 0;
  IF n > 0 THEN found := found || format('%s ledger account(s) of INR accounts or rewards with a balance', n); END IF;

  -- Anything still running on the old models: it would not survive what follows.
  SELECT count(*) INTO n FROM trade t JOIN trade_economics e ON e.trade_id = t.id
   WHERE e.route_execution_mode <> 'P2P' AND t.lifecycle_state NOT IN ('COMPLETED', 'CANCELLED');
  IF n > 0 THEN found := found || format('%s open trade(s) that are not P2P', n); END IF;

  SELECT count(*) INTO n FROM route_obligation WHERE execution_mode <> 'P2P' AND status IN ('OPEN', 'PARTIALLY_SETTLED');
  IF n > 0 THEN found := found || format('%s open obligation(s) that are not P2P', n); END IF;

  SELECT count(*) INTO n FROM trader_order o JOIN liquidity_route r ON r.id = o.route_id
   WHERE r.execution_mode <> 'P2P' AND o.status IN ('OFFERED', 'ACCEPTED', 'IN_PROGRESS');
  IF n > 0 THEN found := found || format('%s open trader order(s) on a route that is not P2P', n); END IF;

  SELECT count(*) INTO n FROM quote q JOIN liquidity_route r ON r.id = q.route_id
   WHERE r.execution_mode <> 'P2P' AND q.status = 'SENT';
  IF n > 0 THEN found := found || format('%s sent quote(s) on a route that is not P2P', n); END IF;

  IF cardinality(found) > 0 THEN
    RAISE EXCEPTION 'migration 46 refuses, nothing was changed: %', array_to_string(found, '; ');
  END IF;
END
$preflight$;
-- preflight:end

-- ── Every live route is P2P ───────────────────────────────────────────────────────────────────────────────────────────

-- A draft on a route that is going away was never sent to anyone: it is discarded, as the desk discards one.
UPDATE quote q SET status = 'CANCELLED', cancel_reason = 'DISCARDED', closed_at = inrp2p_now()
  FROM liquidity_route r
 WHERE r.id = q.route_id AND r.execution_mode <> 'P2P' AND q.status = 'DRAFT';

-- A trader's route settles P2P (the programme's switch did this between deals, and the switch is gone); a route with no
-- trader has nothing left to do.
UPDATE liquidity_route SET execution_mode = 'P2P', version = version + 1, updated_at = statement_timestamp()
 WHERE trader_id IS NOT NULL AND execution_mode <> 'P2P' AND status <> 'RETIRED';
UPDATE liquidity_route SET status = 'RETIRED', version = version + 1, updated_at = statement_timestamp()
 WHERE trader_id IS NULL AND status <> 'RETIRED';

ALTER TABLE liquidity_route DROP CONSTRAINT liquidity_route_trader_shape;
ALTER TABLE liquidity_route ADD CONSTRAINT liquidity_route_live_is_p2p CHECK (
  status = 'RETIRED' OR (trader_id IS NOT NULL AND execution_mode = 'P2P' AND direction <> 'BOTH'));

-- Rows from before stay as they were written; nothing new can be anything but P2P.
ALTER TABLE route_obligation ADD CONSTRAINT route_obligation_new_is_p2p CHECK (execution_mode = 'P2P') NOT VALID;
ALTER TABLE trade_economics ADD CONSTRAINT trade_economics_new_is_p2p CHECK (route_execution_mode = 'P2P') NOT VALID;

-- ── Applying a reserve to a delivery ──────────────────────────────────────────────────────────────────────────────────

DROP TRIGGER trader_reserve_application_settlement ON trader_reserve_application;
DROP TRIGGER route_settlement_reserve_application ON route_settlement;
DROP FUNCTION inrp2p_check_reserve_application_settlement();

CREATE OR REPLACE FUNCTION inrp2p_guard_route_delivery_source() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c record;
  payer text;
BEGIN
  IF NEW.flow = 'FROM_ROUTE_TO_EXCHANGE' THEN
    -- D-16: a route's delivery is the route's own money, never money the exchange already held.
    IF NEW.transfer_kind = 'FIAT' THEN
      SELECT f.payer_type INTO payer FROM fiat_transfer f WHERE f.id = NEW.fiat_transfer_id;
      IF payer IS DISTINCT FROM 'ROUTE' THEN
        RAISE EXCEPTION 'a route delivery is paid by the route' USING ERRCODE = 'IX095';
      END IF;
    ELSE
      SELECT t.payer_type, t.from_address INTO c FROM crypto_transfer t WHERE t.id = NEW.crypto_transfer_id;
      IF c.payer_type IS DISTINCT FROM 'ROUTE'
         OR EXISTS (SELECT 1 FROM treasury_wallet w WHERE w.address = c.from_address)
         OR EXISTS (SELECT 1 FROM deposit_address d WHERE d.address = c.from_address) THEN
        RAISE EXCEPTION 'a route delivery is paid by the route, not from an exchange address' USING ERRCODE = 'IX095';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- What remains of an application is a hold: USDT kept back against rupees an order owes. Nothing moves, so nothing about
-- it is an outgoing payment.
DROP TRIGGER trader_reserve_application_restore_fence ON trader_reserve_application;

CREATE OR REPLACE FUNCTION inrp2p_guard_outgoing_payment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (OLD.status = 'PENDING' AND NEW.status = 'PROCESSING' AND NEW.payer = 'EXCHANGE_ACCOUNT') THEN
    RETURN NEW;
  END IF;
  IF inrp2p_payouts_held() THEN
    RAISE EXCEPTION 'outgoing payments are held until the restore fence is lifted: % refused', TG_TABLE_NAME USING ERRCODE = 'IX100';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION inrp2p_guard_reserve_application() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o record;
  ob record;
  free bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (OLD.status = 'REQUESTED' AND NEW.status = 'APPROVED') THEN
    RETURN NEW;
  END IF;
  -- Serialized with the trader's withdrawals and its other holds.
  PERFORM 1 FROM trader_profile WHERE id = NEW.trader_id FOR UPDATE;
  SELECT t.trader_id, t.side, t.status, t.route_obligation_id INTO o FROM trader_order t WHERE t.id = NEW.trader_order_id;
  IF o.trader_id IS DISTINCT FROM NEW.trader_id OR o.route_obligation_id IS DISTINCT FROM NEW.route_obligation_id THEN
    RAISE EXCEPTION 'a reserve is held only against an order of the same trader' USING ERRCODE = 'IX094';
  END IF;
  -- The reserve is USDT and the debt is rupees: nothing is converted, the amount is only kept back.
  IF o.status <> 'IN_PROGRESS' OR o.side <> 'BUY_USDT' THEN
    RAISE EXCEPTION 'a reserve is held only against rupees a started order owes' USING ERRCODE = 'IX094';
  END IF;
  SELECT r.status, r.route_delivers_asset INTO ob FROM route_obligation r WHERE r.id = NEW.route_obligation_id;
  IF ob.route_delivers_asset <> 'INR' OR ob.status NOT IN ('OPEN', 'PARTIALLY_SETTLED') THEN
    RAISE EXCEPTION 'the order''s obligation does not owe that now' USING ERRCODE = 'IX094';
  END IF;
  IF inrp2p_route_delivery_open(NEW.route_obligation_id) <= 0 THEN
    RAISE EXCEPTION 'the order owes nothing a hold could stand against' USING ERRCODE = 'IX094';
  END IF;
  free := inrp2p_trader_reserve_free(NEW.trader_id, NEW.id);
  IF NEW.amount_minor > free THEN
    RAISE EXCEPTION 'the reserve holds % USDT minor units free; % cannot be held', free, NEW.amount_minor USING ERRCODE = 'IX094';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION inrp2p_trader_reserve_free(p_trader uuid, p_except uuid) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT inrp2p_trader_reserve_balance(p_trader)
       - coalesce((SELECT sum(w.amount_minor) FROM trader_reserve_withdrawal w WHERE w.trader_id = p_trader AND w.status IN ('REQUESTED', 'SENT')), 0)
       - coalesce((SELECT sum(a.amount_minor) FROM trader_reserve_application a
                    WHERE a.trader_id = p_trader AND a.status = 'APPROVED' AND a.id IS DISTINCT FROM p_except), 0)
$$;

ALTER TABLE trader_reserve_application
  DROP CONSTRAINT trader_reserve_application_status_check,
  DROP CONSTRAINT trader_reserve_application_check3,
  DROP CONSTRAINT trader_reserve_application_check4,
  DROP CONSTRAINT trader_reserve_application_check5,
  DROP CONSTRAINT trader_reserve_application_check6,
  DROP CONSTRAINT trader_reserve_application_check7,
  DROP CONSTRAINT trader_reserve_application_kind_check;
ALTER TABLE trader_reserve_application
  DROP COLUMN kind,
  DROP COLUMN sent_at,
  DROP COLUMN completed_at;
ALTER TABLE trader_reserve_application
  ADD CONSTRAINT trader_reserve_application_status_check CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED')),
  ADD CONSTRAINT trader_reserve_application_closed CHECK ((status IN ('REJECTED', 'CANCELLED')) = (closed_at IS NOT NULL)),
  ADD CONSTRAINT trader_reserve_application_close_reason_given CHECK (status NOT IN ('REJECTED', 'CANCELLED') OR close_reason IS NOT NULL);

DROP TRIGGER trader_reserve_application_status ON trader_reserve_application;
CREATE TRIGGER trader_reserve_application_status BEFORE UPDATE ON trader_reserve_application
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'REQUESTED>APPROVED,REQUESTED>REJECTED,REQUESTED>CANCELLED,APPROVED>CANCELLED');
DROP TRIGGER trader_reserve_application_immutable ON trader_reserve_application;
CREATE TRIGGER trader_reserve_application_immutable BEFORE UPDATE ON trader_reserve_application
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'decided_by', 'decided_at', 'decision_note', 'closed_at', 'closed_by', 'close_reason');

-- ── Trader rewards ────────────────────────────────────────────────────────────────────────────────────────────────────

DROP TRIGGER trader_order_reward_frozen ON trader_order;
DROP FUNCTION inrp2p_guard_trader_order_reward();

CREATE OR REPLACE FUNCTION inrp2p_guard_quote_network_fee() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  q record;
  o record;
  desk_trader uuid;
BEGIN
  SELECT status, gross_margin_base_minor, network_fee_base_minor, route_id, trade_request_id INTO q FROM quote WHERE id = NEW.quote_id;
  IF q.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'the network fee of quote % is fixed when it is created', NEW.quote_id USING ERRCODE = 'IX103';
  END IF;
  IF NEW.unit = 'USDT' THEN
    SELECT d.trader_id INTO desk_trader FROM trade_request r JOIN desk d ON d.id = r.desk_id WHERE r.id = q.trade_request_id;
    IF q.gross_margin_base_minor IS NULL OR q.network_fee_base_minor IS DISTINCT FROM NEW.fee_usdt_minor
       OR NEW.net_margin_usdt_minor IS DISTINCT FROM q.gross_margin_base_minor - NEW.fee_usdt_minor
       OR NEW.funder_trader_id IS DISTINCT FROM desk_trader THEN
      RAISE EXCEPTION 'USDT network terms of quote % must be carried by whoever owns the client, out of its USDT side', NEW.quote_id USING ERRCODE = 'IX103';
    END IF;
  ELSIF q.network_fee_base_minor IS NOT NULL THEN
    RAISE EXCEPTION 'quote % carries a USDT network allowance: its terms are in USDT', NEW.quote_id USING ERRCODE = 'IX103';
  ELSIF q.gross_margin_base_minor IS NULL THEN
    RAISE EXCEPTION 'quote % has no USDT margin: every deal is P2P', NEW.quote_id USING ERRCODE = 'IX103';
  ELSIF NEW.fee_usdt_minor IS NULL OR NEW.net_margin_usdt_minor <> q.gross_margin_base_minor
        OR NEW.funder_trader_id IS DISTINCT FROM (SELECT trader_id FROM liquidity_route WHERE id = q.route_id) THEN
    RAISE EXCEPTION 'P2P quote % is funded by its route''s trader: its net margin is its USDT margin', NEW.quote_id USING ERRCODE = 'IX103';
  END IF;
  -- The fee is priced on the order this quote is made on.
  IF NEW.trader_order_id IS NOT NULL THEN
    SELECT route_id, trade_request_id, status INTO o FROM trader_order WHERE id = NEW.trader_order_id;
    IF o.route_id <> q.route_id OR o.trade_request_id <> q.trade_request_id OR o.status <> 'ACCEPTED' THEN
      RAISE EXCEPTION 'quote % is not made on that trader order', NEW.quote_id USING ERRCODE = 'IX113';
    END IF;
  ELSIF (SELECT trader_id FROM liquidity_route WHERE id = q.route_id) IS NOT NULL THEN
    RAISE EXCEPTION 'quote % is on a trader''s route: it names the order it prices', NEW.quote_id USING ERRCODE = 'IX113';
  END IF;
  RETURN NEW;
END
$$;

ALTER TABLE trader_order DROP COLUMN reward_bps, DROP COLUMN reward_inr_minor;
ALTER TABLE quote_network_fee DROP COLUMN reward_bps, DROP COLUMN reward_inr_minor;
ALTER TABLE trader_profile DROP COLUMN reward_bps;
ALTER TABLE trader_program DROP COLUMN reward_bps, DROP COLUMN collection_account_id, DROP COLUMN execution_mode;

DROP TRIGGER trader_order_immutable ON trader_order;
CREATE TRIGGER trader_order_immutable BEFORE UPDATE ON trader_order
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'accepted_at', 'accepted_by', 'hold_until', 'route_rate_snapshot_id', 'trade_id', 'route_obligation_id', 'quote_id', 'started_at', 'delivered_at', 'completed_at', 'closed_at', 'closed_by', 'close_reason', 'version');
DROP TRIGGER trader_profile_immutable ON trader_profile;
CREATE TRIGGER trader_profile_immutable BEFORE UPDATE ON trader_profile
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'offers_buy', 'offers_sell', 'typical_inr_minor', 'typical_usdt_minor', 'bank_account_id', 'wallet_id', 'required_reserve_minor', 'max_order_inr_minor', 'max_order_usdt_minor', 'max_capacity_inr_minor', 'max_capacity_usdt_minor', 'available', 'assignments_enabled', 'control_note', 'applied_by', 'applied_at', 'reviewed_by', 'reviewed_at', 'review_note', 'updated_at', 'version', 'p2p_experience', 'profile_link', 'telegram_handle', 'phone_enc', 'phone_last4', 'daily_capacity_inr_minor', 'daily_capacity_usdt_minor', 'ownership_confirmed_at', 'proposed_bank_account_id', 'proposed_wallet_id', 'approved_at', 'auto_review_flags', 'auto_reviewed_at', 'proposal_effective_at', 'proposed_by');

-- ── Paying a trader's TRX back ────────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE network_budget_hold DROP CONSTRAINT network_budget_hold_unit_shape, DROP CONSTRAINT network_budget_hold_check1;
ALTER TABLE network_budget_hold DROP COLUMN reimbursed_sun, DROP COLUMN reimbursed_inr_minor;
ALTER TABLE network_budget_hold ADD CONSTRAINT network_budget_hold_unit_shape CHECK (
  (unit = 'TRX' AND amount_sun IS NOT NULL AND per_send_sun IS NOT NULL AND snapshot_id IS NOT NULL AND deal_funded_usdt_minor IS NULL)
  OR (unit = 'USDT' AND amount_sun IS NULL AND per_send_sun IS NULL AND deal_funded_usdt_minor IS NOT NULL));
DROP TRIGGER network_budget_hold_immutable ON network_budget_hold;
CREATE TRIGGER network_budget_hold_immutable BEFORE UPDATE ON network_budget_hold
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'closed_at', 'close_reason', 'spent_sun', 'amount_sun', 'spent_usdt_minor', 'unused_usdt_minor');

-- ── Treasury reservations ─────────────────────────────────────────────────────────────────────────────────────────────

DROP TRIGGER treasury_wallet_reserved_guard ON treasury_wallet;
DROP TRIGGER treasury_wallet_reserved_consistent ON treasury_wallet;
DROP TRIGGER treasury_reservation_wallet_consistent ON treasury_reservation;
DROP TRIGGER treasury_reservation_funding ON treasury_reservation;
DROP FUNCTION inrp2p_guard_treasury_reserved();
DROP FUNCTION inrp2p_check_treasury_reserved();
DROP FUNCTION inrp2p_guard_treasury_reservation_funding();
ALTER TABLE treasury_wallet DROP COLUMN reserved_minor;
DROP TRIGGER treasury_wallet_immutable ON treasury_wallet;
CREATE TRIGGER treasury_wallet_immutable BEFORE UPDATE ON treasury_wallet
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'observed_balance_minor', 'observed_at', 'updated_at');

-- ── INR accounts, capacity, statements, collection ────────────────────────────────────────────────────────────────────

-- Where a use of funds takes its money from: a deal's USDT address. No rupee is ever earmarked: they never pass through
-- an account of the exchange.
CREATE OR REPLACE FUNCTION inrp2p_funding_use_location(p_leg uuid, p_route_settlement uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_leg IS NOT NULL THEN (
      SELECT 'TRON:' || coalesce((SELECT d.address::text FROM deposit_address d WHERE d.id = l.source_deposit_address_id),
                                 (SELECT w.address::text FROM treasury_wallet w WHERE w.id = l.treasury_wallet_id))
        FROM settlement_leg l WHERE l.id = p_leg AND l.asset = 'USDT')
    ELSE (
      SELECT 'TRON:' || c.from_address::text
        FROM route_settlement s
        JOIN crypto_transfer c ON c.id = s.crypto_transfer_id
       WHERE s.id = p_route_settlement)
  END
$$;

ALTER TABLE settlement_leg DROP COLUMN inr_account_id, DROP COLUMN capacity_reservation_id;
-- Rupees go straight between a deal's two sides: the exchange never pays any.
ALTER TABLE settlement_leg ADD CONSTRAINT settlement_leg_exchange_pays_only_usdt CHECK (NOT (payer = 'EXCHANGE_ACCOUNT' AND asset = 'INR'));
DROP TRIGGER settlement_leg_immutable ON settlement_leg;
CREATE TRIGGER settlement_leg_immutable BEFORE UPDATE ON settlement_leg
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'notes', 'sent_at', 'confirmed_at', 'failed_at', 'cancelled_at', 'failure_reason', 'sent_by', 'confirmed_by');

ALTER TABLE route_settlement DROP COLUMN capacity_reservation_id, DROP COLUMN reserve_application_id;
DROP TRIGGER route_settlement_immutable ON route_settlement;
CREATE TRIGGER route_settlement_immutable BEFORE UPDATE ON route_settlement
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'confirmed_at', 'failed_at', 'failure_reason');

ALTER TABLE fiat_sender_check DROP CONSTRAINT fiat_sender_check_via_check, DROP CONSTRAINT fiat_sender_check_check;
ALTER TABLE fiat_sender_check DROP COLUMN statement_line_id;
ALTER TABLE fiat_sender_check ADD CONSTRAINT fiat_sender_check_via_check CHECK (via IN ('DESK', 'PAYEE'));

-- No CASCADE: anything else that still depends on these tables stops the migration here.
DROP TABLE bank_statement_line, bank_statement_import, trade_collection, trader_reward_payout, capacity_reservation,
           inr_account_day, inr_settlement_account, settlement_entity, treasury_reservation;

DROP FUNCTION inrp2p_guard_reward_from_margin();
DROP FUNCTION inrp2p_inr_account_free_margin(uuid);
DROP FUNCTION inrp2p_check_day_reserved();
DROP FUNCTION inrp2p_guard_inr_account_day();
DROP FUNCTION inrp2p_guard_inr_account_day_insert();
DROP FUNCTION inrp2p_guard_reservation_monotonic();
DROP FUNCTION inrp2p_guard_trade_collection();
