-- 0039 P2P escrow (ADR 0019): rupees go straight between client and trader; the exchange holds the USDT.
--
-- INRP2P has no INR bank account. A trader's route can therefore execute `P2P`: the rupees of a trade move once,
-- directly between the client's and the trader's own registered accounts, and the USDT moves through the deal's own
-- address of the exchange's HD wallet, which only the exchange's signer can spend.
--
-- 1. Execution mode `P2P` — trader routes only. The trader programme names the mode its routes run in.
-- 2. Economics (FI-97). One rupee amount (`route_value_inr = quote_inr`, `gross_margin_inr = 0`) and two USDT amounts:
--    `base` (the client's) and `route_base` (the trader's); the exchange's margin is the USDT between them
--    (`gross_margin_base`), frozen with the quote and the trade (IX045), and its route obligation is the trader's side.
-- 3. A quote's network fee and net margin are in USDT on a P2P route (IX103); no trader reward is counted.
-- 4. Direct rupees: the client paying the trader (`DIRECT_FROM_CLIENT`, the exchange's side of a BUY) and the trader
--    paying the client (`DIRECT_TO_CLIENT`, the route's side of a SELL) settle the obligation without any exchange
--    account. Who sent them is checked by the one who received them (`fiat_sender_check.via = PAYEE`, ADR 0018).

-- 1. Execution mode -------------------------------------------------------------------------------------------------

ALTER TABLE liquidity_route DROP CONSTRAINT liquidity_route_execution_mode_check;
ALTER TABLE liquidity_route ADD CONSTRAINT liquidity_route_execution_mode_check CHECK (execution_mode IN ('DIRECT_TO_CLIENT', 'TO_EXCHANGE', 'P2P'));
ALTER TABLE liquidity_route DROP CONSTRAINT liquidity_route_trader_shape;
ALTER TABLE liquidity_route ADD CONSTRAINT liquidity_route_trader_shape CHECK (
  (trader_id IS NULL AND execution_mode <> 'P2P')
  OR (trader_id IS NOT NULL AND execution_mode IN ('TO_EXCHANGE', 'P2P') AND direction <> 'BOTH'));
ALTER TABLE trade_economics DROP CONSTRAINT trade_economics_route_execution_mode_check;
ALTER TABLE trade_economics ADD CONSTRAINT trade_economics_route_execution_mode_check CHECK (route_execution_mode IN ('DIRECT_TO_CLIENT', 'TO_EXCHANGE', 'P2P'));
ALTER TABLE route_obligation DROP CONSTRAINT route_obligation_execution_mode_check;
ALTER TABLE route_obligation ADD CONSTRAINT route_obligation_execution_mode_check CHECK (execution_mode IN ('DIRECT_TO_CLIENT', 'TO_EXCHANGE', 'P2P'));

ALTER TABLE trader_program ADD COLUMN execution_mode text NOT NULL DEFAULT 'TO_EXCHANGE' CHECK (execution_mode IN ('TO_EXCHANGE', 'P2P'));
GRANT UPDATE (execution_mode) ON trader_program TO inrp2p_app;

-- 2. Economics ------------------------------------------------------------------------------------------------------

ALTER TABLE quote
  ADD COLUMN route_base_minor bigint CHECK (route_base_minor > 0),
  ADD COLUMN gross_margin_base_minor bigint,
  ADD CONSTRAINT quote_p2p_shape CHECK ((route_base_minor IS NULL) = (gross_margin_base_minor IS NULL)),
  ADD CONSTRAINT quote_p2p_margin_derived CHECK (route_base_minor IS NULL OR (
    route_value_inr_minor = quote_inr_minor AND gross_margin_inr_minor = 0
    AND ((direction = 'BUY_USDT' AND gross_margin_base_minor = route_base_minor - base_minor)
      OR (direction = 'SELL_USDT' AND gross_margin_base_minor = base_minor - route_base_minor))));

ALTER TABLE trade_economics
  ADD COLUMN route_base_minor bigint CHECK (route_base_minor > 0),
  ADD COLUMN gross_margin_base_minor bigint,
  ADD CONSTRAINT trade_economics_p2p_shape CHECK ((route_execution_mode = 'P2P') = (route_base_minor IS NOT NULL) AND (route_base_minor IS NULL) = (gross_margin_base_minor IS NULL)),
  ADD CONSTRAINT trade_economics_p2p_margin_derived CHECK (route_base_minor IS NULL OR (
    route_value_inr_minor = quote_inr_minor AND gross_margin_inr_minor = 0
    AND ((direction = 'BUY_USDT' AND gross_margin_base_minor = route_base_minor - base_minor)
      OR (direction = 'SELL_USDT' AND gross_margin_base_minor = base_minor - route_base_minor))));

-- IX045: copied values equal the accepted quote exactly, the trader's USDT side included.
CREATE OR REPLACE FUNCTION inrp2p_guard_trade_economics_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  q quote%ROWTYPE;
BEGIN
  SELECT quote.* INTO q FROM quote JOIN trade ON trade.quote_id = quote.id WHERE trade.id = NEW.trade_id;
  IF q.direction <> NEW.direction OR q.fixed_side <> NEW.fixed_side OR q.base_minor <> NEW.base_minor OR q.quote_inr_minor <> NEW.quote_inr_minor
     OR q.client_rate_micro <> NEW.client_rate_micro OR q.route_rate_micro <> NEW.route_rate_micro OR q.route_value_inr_minor <> NEW.route_value_inr_minor
     OR q.gross_margin_inr_minor <> NEW.gross_margin_inr_minor OR q.route_id <> NEW.route_id OR q.route_rate_snapshot_id <> NEW.route_rate_snapshot_id
     OR q.network <> NEW.network OR q.bank_account_id IS DISTINCT FROM NEW.bank_account_id OR q.crypto_wallet_id IS DISTINCT FROM NEW.crypto_wallet_id
     OR q.route_base_minor IS DISTINCT FROM NEW.route_base_minor OR q.gross_margin_base_minor IS DISTINCT FROM NEW.gross_margin_base_minor THEN
    RAISE EXCEPTION 'trade economics for % do not equal the accepted quote', NEW.trade_id USING ERRCODE = 'IX045';
  END IF;
  RETURN NEW;
END
$$;

-- IX045: a P2P obligation is the trader's side — its USDT is `route_base`, its rupees the one shared amount.
CREATE OR REPLACE FUNCTION inrp2p_guard_route_obligation_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  e trade_economics%ROWTYPE;
  usdt bigint;
BEGIN
  IF NEW.status <> 'OPEN' THEN
    RAISE EXCEPTION 'a route obligation starts OPEN' USING ERRCODE = 'IX040';
  END IF;
  SELECT * INTO e FROM trade_economics WHERE trade_id = NEW.trade_id;
  usdt := coalesce(e.route_base_minor, e.base_minor);
  IF e.trade_id IS NULL OR e.route_id <> NEW.route_id OR e.direction <> NEW.direction OR e.route_execution_mode <> NEW.execution_mode
     OR (NEW.direction = 'SELL_USDT' AND (NEW.exchange_delivers_minor <> usdt OR NEW.route_delivers_minor <> e.route_value_inr_minor))
     OR (NEW.direction = 'BUY_USDT' AND (NEW.exchange_delivers_minor <> e.route_value_inr_minor OR NEW.route_delivers_minor <> usdt)) THEN
    RAISE EXCEPTION 'route obligation does not equal the frozen trade economics' USING ERRCODE = 'IX045';
  END IF;
  RETURN NEW;
END
$$;

-- IX073 / IX075: a trader's order is its own side of the deal — on a P2P route, the trader's USDT.
CREATE OR REPLACE FUNCTION inrp2p_guard_trader_order_link() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  q quote%ROWTYPE;
BEGIN
  IF NEW.trade_id IS NOT NULL AND OLD.trade_id IS NULL THEN
    SELECT * INTO q FROM quote WHERE id = NEW.quote_id;
    IF q.route_id <> NEW.route_id OR q.trade_request_id <> NEW.trade_request_id OR q.route_rate_snapshot_id <> NEW.route_rate_snapshot_id
       OR coalesce(q.route_base_minor, q.base_minor) <> NEW.base_minor OR q.route_value_inr_minor <> NEW.inr_minor THEN
      RAISE EXCEPTION 'trader order % does not match the accepted quote %', NEW.ref, q.ref USING ERRCODE = 'IX073';
    END IF;
    IF (SELECT quote_id FROM trade WHERE id = NEW.trade_id) <> NEW.quote_id
       OR (SELECT trade_id FROM route_obligation WHERE id = NEW.route_obligation_id) <> NEW.trade_id THEN
      RAISE EXCEPTION 'trader order % links a trade and obligation that do not belong together', NEW.ref USING ERRCODE = 'IX073';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION inrp2p_guard_trader_route_quote() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mode text;
BEGIN
  SELECT CASE WHEN trader_id IS NULL THEN NULL ELSE execution_mode END INTO mode FROM liquidity_route WHERE id = NEW.route_id;
  IF mode IS NULL THEN
    RETURN NEW;
  END IF;
  -- A P2P route's quote carries the trader's USDT side; a through-the-exchange one never does.
  IF (mode = 'P2P') <> (NEW.route_base_minor IS NOT NULL) THEN
    RAISE EXCEPTION 'a quote on a % trader route % its trader''s USDT side', mode, CASE WHEN mode = 'P2P' THEN 'carries' ELSE 'has no' END USING ERRCODE = 'IX075';
  END IF;
  IF TG_OP = 'UPDATE' AND NOT (NEW.status = 'SENT' AND OLD.status <> 'SENT') THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM trader_order o
    WHERE o.trade_request_id = NEW.trade_request_id AND o.route_id = NEW.route_id AND o.status = 'ACCEPTED'
      AND o.route_rate_snapshot_id = NEW.route_rate_snapshot_id AND o.base_minor = coalesce(NEW.route_base_minor, NEW.base_minor) AND o.inr_minor = NEW.route_value_inr_minor
  ) THEN
    RAISE EXCEPTION 'a quote on a trader route needs that trader''s accepted order for exactly this amount' USING ERRCODE = 'IX075';
  END IF;
  RETURN NEW;
END
$$;

-- 3. The network fee and net margin of a P2P quote are in USDT ----------------------------------------------------------

ALTER TABLE quote_network_fee
  ADD COLUMN fee_usdt_minor bigint CHECK (fee_usdt_minor >= 0),
  ADD COLUMN net_margin_usdt_minor bigint,
  ADD COLUMN min_net_margin_usdt_minor bigint CHECK (min_net_margin_usdt_minor >= 0),
  ADD CONSTRAINT quote_network_fee_usdt_shape CHECK ((fee_usdt_minor IS NULL) = (net_margin_usdt_minor IS NULL) AND (fee_usdt_minor IS NULL) = (min_net_margin_usdt_minor IS NULL));

-- FI-90 / FI-97: the net margin is derived, never input — in rupees through the exchange, in USDT on a P2P route, where
-- no trader reward is counted.
CREATE OR REPLACE FUNCTION inrp2p_guard_quote_network_fee() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  q record;
  o record;
BEGIN
  SELECT status, gross_margin_inr_minor, gross_margin_base_minor, route_id, trade_request_id INTO q FROM quote WHERE id = NEW.quote_id;
  IF q.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'the network fee of quote % is fixed when it is created', NEW.quote_id USING ERRCODE = 'IX103';
  END IF;
  IF q.gross_margin_base_minor IS NOT NULL THEN
    IF NEW.fee_usdt_minor IS NULL OR NEW.net_margin_usdt_minor <> q.gross_margin_base_minor - NEW.fee_usdt_minor
       OR coalesce(NEW.reward_bps, 0) <> 0 OR NEW.reward_inr_minor <> 0 OR NEW.funder_trader_id IS NOT NULL THEN
      RAISE EXCEPTION 'net margin of P2P quote % must equal its USDT margin less the network fee, with no reward, funded by the platform', NEW.quote_id USING ERRCODE = 'IX103';
    END IF;
  ELSIF NEW.fee_usdt_minor IS NOT NULL OR NEW.net_margin_inr_minor <> q.gross_margin_inr_minor - NEW.reward_inr_minor - NEW.fee_inr_minor THEN
    RAISE EXCEPTION 'net margin of quote % must equal gross margin less reward less network fee', NEW.quote_id USING ERRCODE = 'IX103';
  END IF;
  -- The reward is the trader order's own: the order this quote prices, at the basis points it records, of its INR.
  IF NEW.trader_order_id IS NOT NULL THEN
    SELECT route_id, trade_request_id, inr_minor, status INTO o FROM trader_order WHERE id = NEW.trader_order_id;
    IF o.route_id <> q.route_id OR o.trade_request_id <> q.trade_request_id OR o.status <> 'ACCEPTED'
       OR NEW.reward_inr_minor <> (o.inr_minor * coalesce(NEW.reward_bps, 0)) / 10000 THEN
      RAISE EXCEPTION 'the reward of quote % is not its trader order''s', NEW.quote_id USING ERRCODE = 'IX113';
    END IF;
  ELSIF (SELECT trader_id FROM liquidity_route WHERE id = q.route_id) IS NOT NULL THEN
    RAISE EXCEPTION 'quote % is on a trader''s route: it names the order whose reward it counts', NEW.quote_id USING ERRCODE = 'IX113';
  END IF;
  RETURN NEW;
END
$$;

-- 4. Direct rupees ------------------------------------------------------------------------------------------------------

ALTER TABLE route_settlement DROP CONSTRAINT route_settlement_flow_check;
ALTER TABLE route_settlement ADD CONSTRAINT route_settlement_flow_check CHECK (flow IN ('FROM_ROUTE_TO_EXCHANGE', 'TO_ROUTE', 'DIRECT_TO_CLIENT', 'DIRECT_FROM_CLIENT'));
ALTER TABLE route_settlement DROP CONSTRAINT route_settlement_check4;
ALTER TABLE route_settlement ADD CONSTRAINT route_settlement_side_of_flow CHECK ((flow IN ('TO_ROUTE', 'DIRECT_FROM_CLIENT')) = (obligation_side = 'EXCHANGE_DELIVERS'));

-- A route-paid client leg exists on a route that pays the client directly: DIRECT_TO_CLIENT, or P2P.
CREATE OR REPLACE FUNCTION inrp2p_guard_settlement_leg_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t trade%ROWTYPE;
  e trade_economics%ROWTYPE;
  expected_asset text;
BEGIN
  SELECT * INTO t FROM trade WHERE id = NEW.trade_id;
  SELECT * INTO e FROM trade_economics WHERE trade_id = NEW.trade_id;
  IF NEW.status NOT IN ('PENDING', 'PROCESSING') OR (NEW.status = 'PROCESSING' AND NEW.side <> 'CLIENT_TO_EXCHANGE') THEN
    RAISE EXCEPTION 'a settlement leg starts PENDING (the client leg may start PROCESSING)' USING ERRCODE = 'IX040';
  END IF;
  -- Asset is decided by direction and side, never by the caller.
  expected_asset := CASE
    WHEN NEW.side = 'EXCHANGE_TO_CLIENT' THEN CASE WHEN t.direction = 'SELL_USDT' THEN 'INR' ELSE 'USDT' END
    ELSE CASE WHEN t.direction = 'SELL_USDT' THEN 'USDT' ELSE 'INR' END
  END;
  IF NEW.asset <> expected_asset THEN
    RAISE EXCEPTION 'leg asset % does not match a % % leg', NEW.asset, t.direction, NEW.side USING ERRCODE = 'IX047';
  END IF;
  -- FI-65: only a trade whose route pays the client directly may have a route-paid leg, and only on its own route.
  IF NEW.payer = 'ROUTE' AND (e.route_execution_mode NOT IN ('DIRECT_TO_CLIENT', 'P2P') OR NEW.route_id <> e.route_id) THEN
    RAISE EXCEPTION 'a route-paid leg requires the trade route to pay the client directly' USING ERRCODE = 'IX065';
  END IF;
  -- D-12: no payout before the client leg is confirmed.
  IF NEW.side = 'EXCHANGE_TO_CLIENT' AND t.lifecycle_state NOT IN ('FIRST_LEG_CONFIRMED', 'SETTLING', 'PARTIALLY_SETTLED') THEN
    RAISE EXCEPTION 'payout legs require a confirmed client leg (trade is %)', t.lifecycle_state USING ERRCODE = 'IX048';
  END IF;
  NEW.ref := t.ref || '-L' || NEW.seq;
  RETURN NEW;
END
$$;

-- A direct route settlement exists only as the other half of a confirmed direct payment: the route paying the client
-- (`DIRECT_TO_CLIENT`), or — P2P — the client paying the route (`DIRECT_FROM_CLIENT`).
CREATE OR REPLACE FUNCTION inrp2p_guard_route_settlement_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  movement_amount bigint;
  direct boolean;
BEGIN
  IF NEW.transfer_kind = 'FIAT' THEN
    SELECT amount_minor INTO movement_amount FROM fiat_transfer WHERE id = NEW.fiat_transfer_id;
  ELSE
    SELECT amount_minor INTO movement_amount FROM crypto_transfer WHERE id = NEW.crypto_transfer_id;
  END IF;
  IF movement_amount IS DISTINCT FROM NEW.amount_minor THEN
    RAISE EXCEPTION 'a route settlement amount must equal its movement amount' USING ERRCODE = 'IX061';
  END IF;
  IF NEW.flow IN ('DIRECT_TO_CLIENT', 'DIRECT_FROM_CLIENT') THEN
    IF NEW.status <> 'CONFIRMED' THEN
      RAISE EXCEPTION 'a % route settlement is created confirmed by the confirmation of its payment', NEW.flow USING ERRCODE = 'IX065';
    END IF;
    IF NEW.flow = 'DIRECT_TO_CLIENT' THEN
      IF NEW.transfer_kind = 'FIAT' THEN
        SELECT payer_type = 'ROUTE' AND payee_type = 'CLIENT_BANK' INTO direct FROM fiat_transfer WHERE id = NEW.fiat_transfer_id;
      ELSE
        SELECT payer_type = 'ROUTE' AND payee_type = 'CLIENT_WALLET' INTO direct FROM crypto_transfer WHERE id = NEW.crypto_transfer_id;
      END IF;
    ELSE
      SELECT NEW.transfer_kind = 'FIAT' AND payer_type = 'CLIENT' AND payee_type = 'ROUTE' INTO direct FROM fiat_transfer WHERE id = NEW.fiat_transfer_id;
    END IF;
    IF NOT coalesce(direct, false) THEN
      RAISE EXCEPTION 'a % route settlement needs the matching direct payment', NEW.flow USING ERRCODE = 'IX065';
    END IF;
  END IF;
  IF NEW.flow NOT IN ('DIRECT_TO_CLIENT', 'DIRECT_FROM_CLIENT') AND NEW.status <> 'RECORDED' THEN
    RAISE EXCEPTION 'a route settlement starts RECORDED' USING ERRCODE = 'IX040';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION inrp2p_guard_route_settlement_allocation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s route_settlement%ROWTYPE;
  o route_obligation%ROWTYPE;
  side_asset text;
BEGIN
  SELECT * INTO s FROM route_settlement WHERE id = NEW.route_settlement_id;
  SELECT * INTO o FROM route_obligation WHERE id = NEW.route_obligation_id;
  IF s.status <> 'CONFIRMED' THEN
    RAISE EXCEPTION 'only a CONFIRMED route settlement can be allocated' USING ERRCODE = 'IX061';
  END IF;
  IF s.route_id <> o.route_id THEN
    RAISE EXCEPTION 'route settlement and obligation belong to different routes' USING ERRCODE = 'IX061';
  END IF;
  side_asset := CASE WHEN NEW.side = 'ROUTE_DELIVERS' THEN o.route_delivers_asset ELSE o.exchange_delivers_asset END;
  IF s.asset <> side_asset THEN
    RAISE EXCEPTION 'a % settlement cannot satisfy the % side (%)', s.asset, NEW.side, side_asset USING ERRCODE = 'IX061';
  END IF;
  -- FI-65: which flows may satisfy which side, and which modes allow money to skip the exchange at all.
  IF (s.flow IN ('TO_ROUTE', 'DIRECT_FROM_CLIENT')) <> (NEW.side = 'EXCHANGE_DELIVERS') THEN
    RAISE EXCEPTION 'flow % cannot satisfy the % side', s.flow, NEW.side USING ERRCODE = 'IX065';
  END IF;
  IF s.flow = 'DIRECT_TO_CLIENT' AND o.execution_mode NOT IN ('DIRECT_TO_CLIENT', 'P2P') THEN
    RAISE EXCEPTION 'a direct-to-client movement cannot satisfy a TO_EXCHANGE obligation' USING ERRCODE = 'IX065';
  END IF;
  IF s.flow = 'DIRECT_FROM_CLIENT' AND o.execution_mode <> 'P2P' THEN
    RAISE EXCEPTION 'only a P2P obligation is settled by the client paying the route directly' USING ERRCODE = 'IX065';
  END IF;
  RETURN NEW;
END
$$;

-- Who sent direct rupees is checked by the one who received them: the trader for a client's, the client for a trader's.
ALTER TABLE fiat_sender_check DROP CONSTRAINT fiat_sender_check_via_check;
ALTER TABLE fiat_sender_check ADD CONSTRAINT fiat_sender_check_via_check CHECK (via IN ('STATEMENT', 'DESK', 'PAYEE'));

CREATE OR REPLACE FUNCTION inrp2p_fiat_needs_sender_check(f fiat_transfer) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT (f.payee_type = 'EXCHANGE_ACCOUNT' AND (
            f.payer_type = 'CLIENT'
            OR (f.payer_type = 'ROUTE' AND EXISTS (SELECT 1 FROM liquidity_route r WHERE r.id = f.payer_id AND r.trader_id IS NOT NULL))))
      -- P2P: a client paying a trader, or a trader paying a client, directly.
      OR (f.payer_type = 'CLIENT' AND f.payee_type = 'ROUTE')
      OR (f.payer_type = 'ROUTE' AND f.payee_type = 'CLIENT_BANK' AND EXISTS (SELECT 1 FROM liquidity_route r WHERE r.id = f.payer_id AND r.execution_mode = 'P2P'))
$$;

CREATE OR REPLACE FUNCTION inrp2p_guard_fiat_sender_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  f fiat_transfer;
BEGIN
  SELECT * INTO f FROM fiat_transfer WHERE id = NEW.fiat_transfer_id FOR UPDATE;
  IF NOT inrp2p_fiat_needs_sender_check(f) THEN
    RAISE EXCEPTION 'payment % is not one whose sender is checked', NEW.fiat_transfer_id USING ERRCODE = 'IX119';
  END IF;
  IF f.status <> 'RECORDED' AND NEW.via IN ('DESK', 'PAYEE') THEN
    RAISE EXCEPTION 'payment % is % — its sender is no longer decided by hand', NEW.fiat_transfer_id, f.status USING ERRCODE = 'IX119';
  END IF;
  IF NEW.verdict = 'ACCEPTED' AND inrp2p_fiat_sender_verdict(NEW.fiat_transfer_id) <> 'PARTIAL' THEN
    RAISE EXCEPTION 'only a partial match can be accepted as the payer''s own (it is %)', inrp2p_fiat_sender_verdict(NEW.fiat_transfer_id) USING ERRCODE = 'IX119';
  END IF;
  RETURN NEW;
END $$;

-- The verdict that counts: a payee's own look at its bank counts like a person's at the desk.
CREATE OR REPLACE FUNCTION inrp2p_fiat_sender_verdict(transfer_id uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM fiat_sender_check c WHERE c.fiat_transfer_id = transfer_id AND c.via = 'STATEMENT' AND c.verdict = 'MISMATCH') THEN 'MISMATCH'
    ELSE coalesce((
      SELECT c.verdict FROM fiat_sender_check c
      WHERE c.fiat_transfer_id = transfer_id
        AND (c.via IN ('DESK', 'PAYEE') OR c.verdict = 'MATCH'
             OR NOT EXISTS (SELECT 1 FROM fiat_sender_check d WHERE d.fiat_transfer_id = transfer_id AND d.via IN ('DESK', 'PAYEE')))
      ORDER BY c.checked_at DESC, c.id DESC LIMIT 1), 'NOT_CHECKED')
  END
$$;

-- 5. Cases the desk works on a P2P trade -----------------------------------------------------------------------------------

ALTER TABLE exception_case DROP CONSTRAINT exception_case_type_check;
ALTER TABLE exception_case ADD CONSTRAINT exception_case_type_check CHECK (type IN (
  'USDT_WRONG_AMOUNT', 'USDT_OVERPAYMENT', 'USDT_UNEXPECTED_SENDER', 'WRONG_NETWORK', 'TX_NOT_FINAL',
  'ROUTE_DIRECT_PAYOUT_MISMATCH', 'FUNDS_AFTER_TRADE_CLOSED', 'UNALLOCATED_DEPOSIT', 'DEPOSIT_POOL_LOW',
  'ROUTE_SETTLEMENT_MISMATCH', 'ROUTE_OBLIGATION_OVERDUE', 'DUPLICATE_TX_HASH', 'DUPLICATE_UTR',
  'PARTIAL_INR_PAYOUT', 'INR_PAYOUT_DELAYED', 'BANK_TRANSFER_FAILED', 'CLIENT_BANK_CHANGED',
  'ROUTE_CAPACITY_CHANGED', 'TRADE_CANCELLATION', 'OPERATOR_MISTAKE', 'RECONCILIATION_MISMATCH',
  'CHAIN_SEND_UNRESOLVED', 'NETWORK_BUDGET_SHORT', 'INR_UNEXPECTED_SENDER',
  'P2P_PAYMENT_OVERDUE', 'P2P_RECEIPT_OVERDUE'));

-- 6. One movement, two obligations: a client's rupees paid straight to its P2P trader are both the client's leg and the
-- exchange's side of the route obligation (FI-28 extended), like a route's rupees paid straight to the client.
CREATE OR REPLACE FUNCTION inrp2p_guard_transfer_allocation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  movement_amount bigint;
  m_payer text;
  m_payee text;
  m_payee_id uuid;
  other_dimension boolean;
  leg settlement_leg%ROWTYPE;
BEGIN
  IF NEW.transfer_kind = 'FIAT' THEN
    SELECT amount_minor, payer_type, payee_type, payee_id INTO movement_amount, m_payer, m_payee, m_payee_id FROM fiat_transfer WHERE id = NEW.fiat_transfer_id;
    SELECT EXISTS (SELECT 1 FROM transfer_allocation WHERE fiat_transfer_id = NEW.fiat_transfer_id AND dimension <> NEW.dimension AND voided_at IS NULL) INTO other_dimension;
  ELSE
    SELECT amount_minor, payer_type, payee_type, payee_id INTO movement_amount, m_payer, m_payee, m_payee_id FROM crypto_transfer WHERE id = NEW.crypto_transfer_id;
    SELECT EXISTS (SELECT 1 FROM transfer_allocation WHERE crypto_transfer_id = NEW.crypto_transfer_id AND dimension <> NEW.dimension AND voided_at IS NULL) INTO other_dimension;
  END IF;
  -- The whole movement is allocated, never a part of it (over/short payments are exceptions).
  IF movement_amount IS DISTINCT FROM NEW.amount_minor THEN
    RAISE EXCEPTION 'an allocation must cover the whole movement (% vs %)', NEW.amount_minor, movement_amount USING ERRCODE = 'IX028';
  END IF;
  -- Both dimensions only for a route→client movement, or a client's rupees straight to its P2P route.
  IF other_dimension AND NOT (
       (m_payer = 'ROUTE' AND m_payee IN ('CLIENT_BANK', 'CLIENT_WALLET'))
       OR (NEW.transfer_kind = 'FIAT' AND m_payer = 'CLIENT' AND m_payee = 'ROUTE'
           AND EXISTS (SELECT 1 FROM liquidity_route r WHERE r.id = m_payee_id AND r.execution_mode = 'P2P'))) THEN
    RAISE EXCEPTION 'only a route→client movement may satisfy a client leg and a route settlement' USING ERRCODE = 'IX028';
  END IF;
  IF NEW.dimension = 'CLIENT' AND NEW.settlement_leg_id IS NOT NULL THEN
    SELECT * INTO leg FROM settlement_leg WHERE id = NEW.settlement_leg_id;
    IF leg.amount_minor <> NEW.amount_minor THEN
      RAISE EXCEPTION 'leg % amount % does not equal its evidence %', leg.ref, leg.amount_minor, NEW.amount_minor USING ERRCODE = 'IX028';
    END IF;
    -- A route-paid leg is evidenced by a route→client movement, and only such a movement (FI-65).
    IF (leg.payer = 'ROUTE') <> (m_payer = 'ROUTE') THEN
      RAISE EXCEPTION 'leg payer % does not match movement payer %', leg.payer, m_payer USING ERRCODE = 'IX065';
    END IF;
  END IF;
  RETURN NEW;
END
$$;


-- 7. An escrow nobody paid against goes back (§2.7) ----------------------------------------------------------------------
-- A client buying USDT who never paid leaves its trader's USDT in the deal's escrow. The trade is cancelled and the
-- route obligation with it (the only obligation that ends with something delivered: a P2P one the exchange delivered
-- nothing on), and the signer sends the trader its own USDT back from the address it arrived at, to its registered
-- wallet, at the platform's cost (`ESCROW_RETURN`). The ledger: Dr ROUTE_RECEIVABLE / Cr the escrow's treasury asset,
-- which closes what the cancellation left the trader owed.

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'chain_send'::regclass AND contype = 'c'
              AND (pg_get_constraintdef(oid) LIKE '%purpose = ANY%''DEPOSIT_WITHDRAWAL''::text])))'
                   OR pg_get_constraintdef(oid) = 'CHECK (((purpose = ''ROUTE_PAYMENT''::text) = (route_obligation_id IS NOT NULL)))')
  LOOP
    EXECUTE format('ALTER TABLE chain_send DROP CONSTRAINT %I', c.conname);
  END LOOP;
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'funding_allocation'::regclass AND contype = 'c'
              AND (conname IN ('funding_allocation_use_kind_check', 'funding_allocation_route_use_check'))
  LOOP
    EXECUTE format('ALTER TABLE funding_allocation DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;
ALTER TABLE chain_send ADD CONSTRAINT chain_send_purpose_check
  CHECK (purpose IN ('CLIENT_PAYOUT', 'REFUND', 'ROUTE_PAYMENT', 'ESCROW_RETURN', 'TOPUP', 'DEPOSIT_WITHDRAWAL'));
ALTER TABLE chain_send ADD CONSTRAINT chain_send_obligation_check CHECK ((purpose IN ('ROUTE_PAYMENT', 'ESCROW_RETURN')) = (route_obligation_id IS NOT NULL));
CREATE UNIQUE INDEX chain_send_one_live_escrow_return ON chain_send (route_obligation_id) WHERE purpose = 'ESCROW_RETURN' AND status NOT IN ('CONFIRMED', 'CANCELLED');

ALTER TABLE funding_allocation ADD CONSTRAINT funding_allocation_use_kind_check CHECK (use_kind IN ('CLIENT_PAYOUT', 'REFUND', 'ROUTE_PAYMENT', 'ESCROW_RETURN'));
ALTER TABLE funding_allocation ADD CONSTRAINT funding_allocation_route_use_check
  CHECK ((use_kind = 'ROUTE_PAYMENT') = (use_leg_id IS NULL AND use_kind <> 'ESCROW_RETURN' AND ((use_route_settlement_id IS NOT NULL) <> (use_chain_send_id IS NOT NULL))));
-- The trader's escrow goes back out of the trader's own delivery, and only by the signer's send.
ALTER TABLE funding_allocation ADD CONSTRAINT funding_allocation_escrow_return_check
  CHECK (use_kind <> 'ESCROW_RETURN' OR (source_kind = 'COUNTERPARTY_FUNDS' AND use_chain_send_id IS NOT NULL AND use_leg_id IS NULL AND use_route_settlement_id IS NULL));

-- What of a cancelled P2P obligation's escrow is still the trader's to get back: the USDT it delivered, less what any
-- use earmarked or consumed, less what a return already sent or is sending. Zero for any other obligation.
CREATE FUNCTION inrp2p_escrow_returnable(p_obligation uuid) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN o.status = 'CANCELLED' AND o.execution_mode = 'P2P' AND o.route_delivers_asset = 'USDT' THEN greatest(
           coalesce((SELECT sum(s.amount_minor) FROM route_settlement s
                      WHERE s.route_obligation_id = o.id AND s.flow = 'FROM_ROUTE_TO_EXCHANGE' AND s.status = 'CONFIRMED'), 0)
         - coalesce((SELECT sum(a.amount_minor) FROM funding_allocation a JOIN route_settlement s ON s.id = a.source_route_settlement_id
                      WHERE s.route_obligation_id = o.id AND a.status IN ('ACTIVE', 'CONSUMED')), 0), 0)
         ELSE 0 END
  FROM route_obligation o WHERE o.id = p_obligation
$$;
GRANT EXECUTE ON FUNCTION inrp2p_escrow_returnable(uuid) TO inrp2p_app, inrp2p_readonly;

-- A P2P obligation the trader delivered on, and the exchange did not, ends with the trade: its escrow then goes back.
DROP TRIGGER route_obligation_status ON route_obligation;
CREATE TRIGGER route_obligation_status BEFORE UPDATE ON route_obligation
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status',
    'OPEN>PARTIALLY_SETTLED,OPEN>SETTLED,PARTIALLY_SETTLED>SETTLED,OPEN>CANCELLED,PARTIALLY_SETTLED>CANCELLED');

CREATE FUNCTION inrp2p_guard_route_obligation_unwind() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'CANCELLED' AND OLD.status = 'PARTIALLY_SETTLED' THEN
    IF NEW.execution_mode <> 'P2P' OR NEW.route_delivers_asset <> 'USDT'
       OR EXISTS (SELECT 1 FROM route_settlement s WHERE s.route_obligation_id = NEW.id AND s.obligation_side = 'EXCHANGE_DELIVERS' AND s.status <> 'FAILED') THEN
      RAISE EXCEPTION 'route obligation % has allocations: only a P2P escrow the exchange delivered nothing against ends with its cancelled trade', NEW.id
        USING ERRCODE = 'IX120';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER route_obligation_unwind BEFORE UPDATE ON route_obligation
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_route_obligation_unwind();

CREATE OR REPLACE FUNCTION inrp2p_guard_chain_send_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  l record;
  o record;
  parent record;
  expected_to text;
  expected_from text;
  expected_path text;
BEGIN
  IF inrp2p_payouts_held() THEN
    RAISE EXCEPTION 'outgoing payments are held until the restore fence is lifted: no % is planned', NEW.purpose USING ERRCODE = 'IX100';
  END IF;
  IF NEW.status NOT IN ('AWAITING_APPROVAL', 'PLANNED') THEN
    RAISE EXCEPTION 'a send starts AWAITING_APPROVAL or PLANNED' USING ERRCODE = 'IX106';
  END IF;
  -- A send that needs a second person waits for them, unless that person is the one planning it (a refund is planned
  -- by its approver); one that does not need anyone never waits.
  IF (NEW.status = 'AWAITING_APPROVAL') <> (NEW.needs_approval AND NEW.approved_by IS NULL) THEN
    RAISE EXCEPTION 'a send waits for approval exactly when it needs one and has none' USING ERRCODE = 'IX106';
  END IF;
  IF NEW.purpose IN ('CLIENT_PAYOUT', 'REFUND') THEN
    SELECT trade_id, side, asset, amount_minor, payer, source_deposit_address_id, treasury_wallet_id, destination_wallet_id, status INTO l
      FROM settlement_leg WHERE id = NEW.settlement_leg_id;
    IF l.trade_id <> NEW.trade_id OR l.asset <> 'USDT' OR l.amount_minor <> NEW.amount_minor OR l.payer <> 'EXCHANGE_ACCOUNT'
       OR l.side <> (CASE NEW.purpose WHEN 'CLIENT_PAYOUT' THEN 'EXCHANGE_TO_CLIENT' ELSE 'REFUND_TO_CLIENT' END) THEN
      RAISE EXCEPTION 'send does not match leg %', NEW.settlement_leg_id USING ERRCODE = 'IX106';
    END IF;
    expected_from := coalesce((SELECT address::text FROM deposit_address WHERE id = l.source_deposit_address_id),
                              (SELECT address::text FROM treasury_wallet WHERE id = l.treasury_wallet_id));
    IF NEW.purpose = 'CLIENT_PAYOUT' THEN
      SELECT w.address::text INTO expected_to FROM crypto_wallet w WHERE w.id = (SELECT wallet_id FROM inrp2p_trade_payout_destination(l.trade_id));
    ELSIF l.destination_wallet_id IS NOT NULL THEN
      SELECT address::text INTO expected_to FROM crypto_wallet WHERE id = l.destination_wallet_id;
    ELSE
      -- An unwind goes back to a wallet the client registered as one it sends from.
      SELECT w.address::text INTO expected_to FROM crypto_wallet w JOIN trade t ON t.client_id = w.client_id
       WHERE t.id = l.trade_id AND w.address = NEW.to_address AND w.status = 'ACTIVE' AND w.purpose IN ('SOURCE', 'BOTH');
    END IF;
  ELSIF NEW.purpose = 'ROUTE_PAYMENT' THEN
    SELECT ro.trade_id, ro.exchange_delivers_asset, r.trader_id, r.registered_route_address INTO o
      FROM route_obligation ro JOIN liquidity_route r ON r.id = ro.route_id WHERE ro.id = NEW.route_obligation_id;
    IF o.trade_id IS DISTINCT FROM NEW.trade_id OR o.exchange_delivers_asset <> 'USDT' OR NEW.asset <> 'USDT' THEN
      RAISE EXCEPTION 'send does not match route obligation %', NEW.route_obligation_id USING ERRCODE = 'IX106';
    END IF;
    -- Delivery versus payment (FI-77): the counterparty is paid only after it delivered, whoever plans the payment.
    IF inrp2p_trade_is_counterparty_funded(NEW.trade_id) AND NOT inrp2p_counterparty_delivered(NEW.route_obligation_id) THEN
      RAISE EXCEPTION 'the counterparty of trade % has not delivered yet: the exchange does not pay it first', NEW.trade_id USING ERRCODE = 'IX087';
    END IF;
    IF o.trader_id IS NOT NULL THEN
      SELECT w.address::text INTO expected_to FROM trader_profile t JOIN crypto_wallet w ON w.id = t.wallet_id
       WHERE t.id = o.trader_id AND w.status = 'ACTIVE';
    ELSE
      expected_to := o.registered_route_address;
    END IF;
    expected_from := NEW.from_address;
  ELSIF NEW.purpose = 'ESCROW_RETURN' THEN
    -- ADR 0019: a P2P trader's own USDT back from the escrow of a deal its client never paid — the obligation over,
    -- at most what it delivered and nothing has used or returned, to its registered wallet and nowhere else.
    SELECT ro.trade_id, ro.status, ro.execution_mode, ro.route_delivers_asset, r.trader_id INTO o
      FROM route_obligation ro JOIN liquidity_route r ON r.id = ro.route_id WHERE ro.id = NEW.route_obligation_id;
    IF o.trade_id IS DISTINCT FROM NEW.trade_id OR o.status <> 'CANCELLED' OR o.execution_mode <> 'P2P' OR o.route_delivers_asset <> 'USDT'
       OR NEW.asset <> 'USDT' OR o.trader_id IS NULL OR NEW.amount_minor > inrp2p_escrow_returnable(NEW.route_obligation_id) THEN
      RAISE EXCEPTION 'send does not return the escrow of route obligation %', NEW.route_obligation_id USING ERRCODE = 'IX106';
    END IF;
    SELECT w.address::text INTO expected_to FROM trader_profile t JOIN crypto_wallet w ON w.id = t.wallet_id
     WHERE t.id = o.trader_id AND w.status = 'ACTIVE';
    expected_from := NEW.from_address;
  ELSIF NEW.purpose = 'TOPUP' THEN
    SELECT from_address, trade_id, asset, network_cap_sun INTO parent FROM chain_send WHERE id = NEW.parent_send_id;
    IF parent.asset <> 'USDT' OR parent.trade_id IS DISTINCT FROM NEW.trade_id THEN
      RAISE EXCEPTION 'a top-up fuels a USDT send of its own trade' USING ERRCODE = 'IX106';
    END IF;
    -- IX114: never beyond what the send it fuels may draw — gas that rose or retries that burned it wait for a person.
    IF inrp2p_send_network_used(NEW.parent_send_id) + NEW.amount_minor + NEW.fee_estimate_sun > parent.network_cap_sun THEN
      RAISE EXCEPTION 'a top-up of % sun would take send % past its TRX cap of % sun', NEW.amount_minor + NEW.fee_estimate_sun, NEW.parent_send_id, parent.network_cap_sun
        USING ERRCODE = 'IX114';
    END IF;
    expected_to := parent.from_address::text;
    expected_from := (SELECT w.address::text FROM treasury_wallet w WHERE w.role = 'NETWORK_BUDGET' AND w.status = 'ACTIVE');
  ELSE
    SELECT w.to_address::text INTO expected_to FROM network_deposit_withdrawal w WHERE w.id = NEW.withdrawal_id;
    expected_from := (SELECT w.address::text FROM treasury_wallet w WHERE w.role = 'NETWORK_BUDGET' AND w.status = 'ACTIVE');
  END IF;
  IF expected_to IS DISTINCT FROM NEW.to_address::text OR expected_from IS DISTINCT FROM NEW.from_address::text THEN
    RAISE EXCEPTION 'send % pays % from %; its business pays % from %', NEW.purpose, NEW.to_address, NEW.from_address, expected_to, expected_from
      USING ERRCODE = 'IX106';
  END IF;
  -- The key is the one the custody HD account issued that address under.
  expected_path := CASE WHEN NEW.asset = 'USDT'
    THEN (SELECT d.custody_reference FROM deposit_address d JOIN custody_hd_account h ON h.provider = d.provider
           WHERE d.network = 'TRON' AND d.address = NEW.from_address AND d.source = 'DERIVED')
    ELSE (SELECT h.fee_wallet_path FROM custody_hd_account h WHERE h.fee_wallet_address = NEW.from_address) END;
  IF expected_path IS DISTINCT FROM NEW.from_path THEN
    RAISE EXCEPTION 'send % leaves % which the custody HD account did not issue under %', NEW.purpose, NEW.from_address, NEW.from_path USING ERRCODE = 'IX106';
  END IF;
  -- IX115: a trade's USDT sends together never draw more than the trade holds; one that would not fit is not planned.
  IF NEW.asset = 'USDT' AND inrp2p_trade_network_committed(NEW.trade_id, NULL) + NEW.network_cap_sun
       > coalesce((SELECT amount_sun FROM network_budget_hold WHERE trade_id = NEW.trade_id AND status = 'ACTIVE'), 0) THEN
    RAISE EXCEPTION 'send % of trade % needs a TRX cap of % sun that its hold no longer has', NEW.purpose, NEW.trade_id, NEW.network_cap_sun USING ERRCODE = 'IX115';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION inrp2p_guard_funding_allocation_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  src record;
  use_trade uuid;
  use_asset text;
  use_ok boolean;
  use_location text;
BEGIN
  IF NEW.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'a funding allocation starts ACTIVE' USING ERRCODE = 'IX084';
  END IF;
  IF NOT inrp2p_trade_is_counterparty_funded(NEW.trade_id) THEN
    RAISE EXCEPTION 'trade % is not counterparty-funded', NEW.trade_id USING ERRCODE = 'IX084';
  END IF;
  SELECT * INTO src FROM funding_source
   WHERE kind = NEW.source_kind AND source_id = coalesce(NEW.source_leg_id, NEW.source_route_settlement_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'funding source % is not a confirmed incoming movement', coalesce(NEW.source_leg_id, NEW.source_route_settlement_id) USING ERRCODE = 'IX084';
  END IF;
  IF src.trade_id <> NEW.trade_id OR src.asset <> NEW.asset OR src.location <> NEW.location THEN
    RAISE EXCEPTION 'funding source belongs to trade % in % at %; the allocation is for % in % at %', src.trade_id, src.asset, src.location, NEW.trade_id, NEW.asset, NEW.location
      USING ERRCODE = 'IX084';
  END IF;
  IF NEW.use_leg_id IS NOT NULL THEN
    SELECT l.trade_id, l.asset,
           CASE NEW.use_kind
             WHEN 'CLIENT_PAYOUT' THEN l.side = 'EXCHANGE_TO_CLIENT' AND l.payer = 'EXCHANGE_ACCOUNT'
             ELSE l.side = 'REFUND_TO_CLIENT' END
      INTO use_trade, use_asset, use_ok
      FROM settlement_leg l WHERE l.id = NEW.use_leg_id;
    use_location := inrp2p_funding_use_location(NEW.use_leg_id, NULL);
  ELSIF NEW.use_chain_send_id IS NOT NULL THEN
    SELECT s.trade_id, s.asset, s.purpose = NEW.use_kind AND s.purpose IN ('ROUTE_PAYMENT', 'ESCROW_RETURN'), 'TRON:' || s.from_address::text
      INTO use_trade, use_asset, use_ok, use_location
      FROM chain_send s WHERE s.id = NEW.use_chain_send_id;
  ELSE
    SELECT o.trade_id, s.asset, s.flow = 'TO_ROUTE'
      INTO use_trade, use_asset, use_ok
      FROM route_settlement s JOIN route_obligation o ON o.id = s.route_obligation_id WHERE s.id = NEW.use_route_settlement_id;
    use_location := inrp2p_funding_use_location(NULL, NEW.use_route_settlement_id);
  END IF;
  IF use_trade IS DISTINCT FROM NEW.trade_id OR use_asset IS DISTINCT FROM NEW.asset OR NOT coalesce(use_ok, false) OR use_location IS DISTINCT FROM NEW.location THEN
    RAISE EXCEPTION 'funding use does not match: trade %, asset %, place % (allocation % at %)', use_trade, use_asset, use_location, NEW.asset, NEW.location
      USING ERRCODE = 'IX084';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION inrp2p_check_funding_coverage() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  u_leg uuid;
  u_rs uuid;
  u_send uuid;
  u_trade uuid;
  u_amount bigint;
  u_state text;
  needs boolean;
  active_total bigint;
  consumed_total bigint;
BEGIN
  IF TG_TABLE_NAME = 'funding_allocation' THEN
    u_leg := NEW.use_leg_id;
    u_rs := NEW.use_route_settlement_id;
    u_send := NEW.use_chain_send_id;
  ELSIF TG_TABLE_NAME = 'settlement_leg' THEN
    u_leg := NEW.id;
  ELSIF TG_TABLE_NAME = 'chain_send' THEN
    IF NEW.purpose NOT IN ('ROUTE_PAYMENT', 'ESCROW_RETURN') THEN RETURN NULL; END IF;
    u_send := NEW.id;
  ELSE
    u_rs := NEW.id;
    u_send := NEW.chain_send_id;
  END IF;

  IF u_leg IS NOT NULL THEN
    SELECT l.trade_id, l.amount_minor,
           CASE WHEN l.status IN ('PENDING', 'PROCESSING') THEN 'LIVE' WHEN l.status = 'COMPLETED' THEN 'DONE' ELSE 'DEAD' END,
           (l.side = 'EXCHANGE_TO_CLIENT' AND l.payer = 'EXCHANGE_ACCOUNT') OR l.side = 'REFUND_TO_CLIENT'
      INTO u_trade, u_amount, u_state, needs
      FROM settlement_leg l WHERE l.id = u_leg;
  ELSIF u_rs IS NOT NULL THEN
    SELECT o.trade_id, s.amount_minor,
           CASE WHEN s.status = 'RECORDED' THEN 'LIVE' WHEN s.status = 'CONFIRMED' THEN 'DONE' ELSE 'DEAD' END,
           s.flow = 'TO_ROUTE', s.chain_send_id
      INTO u_trade, u_amount, u_state, needs, u_send
      FROM route_settlement s JOIN route_obligation o ON o.id = s.route_obligation_id WHERE s.id = u_rs;
  ELSE
    SELECT s.trade_id, s.amount_minor,
           CASE WHEN s.status = 'CONFIRMED' THEN 'DONE' WHEN s.status = 'CANCELLED' THEN 'DEAD' ELSE 'LIVE' END,
           s.purpose IN ('ROUTE_PAYMENT', 'ESCROW_RETURN')
      INTO u_trade, u_amount, u_state, needs
      FROM chain_send s WHERE s.id = u_send;
  END IF;
  IF NOT coalesce(needs, false) OR u_trade IS NULL OR NOT inrp2p_trade_is_counterparty_funded(u_trade) THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(sum(amount_minor) FILTER (WHERE status = 'ACTIVE'), 0),
         coalesce(sum(amount_minor) FILTER (WHERE status = 'CONSUMED'), 0)
    INTO active_total, consumed_total
    FROM funding_allocation
   WHERE (u_leg IS NOT NULL AND use_leg_id = u_leg)
      OR (u_send IS NOT NULL AND use_chain_send_id = u_send)
      OR (u_send IS NULL AND u_rs IS NOT NULL AND use_route_settlement_id = u_rs);

  IF u_state = 'LIVE' AND (active_total <> u_amount OR consumed_total <> 0) THEN
    RAISE EXCEPTION 'outgoing % of trade % is not funded: % earmarked of %', coalesce(u_leg, u_send, u_rs), u_trade, active_total, u_amount USING ERRCODE = 'IX086';
  END IF;
  IF u_state = 'DONE' AND (consumed_total <> u_amount OR active_total <> 0) THEN
    RAISE EXCEPTION 'confirmed outgoing % of trade % consumed % of %', coalesce(u_leg, u_send, u_rs), u_trade, consumed_total, u_amount USING ERRCODE = 'IX086';
  END IF;
  IF u_state = 'DEAD' AND (active_total <> 0 OR consumed_total <> 0) THEN
    RAISE EXCEPTION 'cancelled or failed outgoing % of trade % still holds its earmark', coalesce(u_leg, u_send, u_rs), u_trade USING ERRCODE = 'IX086';
  END IF;
  RETURN NULL;
END
$$;

-- 8. What "the counterparty delivered" means on a P2P route: on a client's BUY, its USDT in the escrow (allocated to the
-- obligation, as through the exchange); on a SELL, its rupees confirmed by the client (the route-paid payout legs, as
-- straight to the client).
CREATE OR REPLACE FUNCTION inrp2p_counterparty_delivered(p_obligation uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN o.execution_mode = 'TO_EXCHANGE' OR (o.execution_mode = 'P2P' AND o.route_delivers_asset = 'USDT')
              THEN inrp2p_route_obligation_side(o.id, 'ROUTE_DELIVERS')
                   <= (SELECT coalesce(sum(a.amount_minor), 0) FROM route_settlement_allocation a WHERE a.route_obligation_id = o.id AND a.side = 'ROUTE_DELIVERS')
              ELSE inrp2p_trade_payout_obligation(o.trade_id)
                   <= (SELECT coalesce(sum(l.amount_minor), 0) FROM settlement_leg l WHERE l.trade_id = o.trade_id AND l.side = 'EXCHANGE_TO_CLIENT' AND l.status = 'COMPLETED')
         END
    FROM route_obligation o WHERE o.id = p_obligation
$$;
