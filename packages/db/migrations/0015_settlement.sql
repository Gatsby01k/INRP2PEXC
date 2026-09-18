-- 0015 trade lifecycle T2–T10, settlement legs, movements (fiat/crypto), allocations, route settlements,
-- financial adjustments and exception cases
-- (DOMAIN_MODEL §2.6, §2.7, §3; STATE_MACHINES §3–§10; FI-12, FI-20..FI-28, FI-31, FI-40..FI-43, FI-60..FI-65).

-- ---------------------------------------------------------------------------
-- Exception cases (DOMAIN_MODEL §3, STATE_MACHINES §7). `hold` on the trade is the overlay (D-04).
-- ---------------------------------------------------------------------------
CREATE SEQUENCE exception_case_ref_seq;
CREATE TABLE exception_case (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  ref                     text NOT NULL UNIQUE DEFAULT ('EX-' || lpad(nextval('exception_case_ref_seq')::text, 6, '0')),
  trade_id                uuid REFERENCES trade (id),
  type                    text NOT NULL CHECK (type IN (
                            'USDT_WRONG_AMOUNT', 'USDT_OVERPAYMENT', 'USDT_UNEXPECTED_SENDER', 'WRONG_NETWORK', 'TX_NOT_FINAL',
                            'ROUTE_DIRECT_PAYOUT_MISMATCH', 'FUNDS_AFTER_TRADE_CLOSED', 'UNALLOCATED_DEPOSIT', 'DEPOSIT_POOL_LOW',
                            'ROUTE_SETTLEMENT_MISMATCH', 'ROUTE_OBLIGATION_OVERDUE', 'DUPLICATE_TX_HASH', 'DUPLICATE_UTR',
                            'PARTIAL_INR_PAYOUT', 'INR_PAYOUT_DELAYED', 'BANK_TRANSFER_FAILED', 'CLIENT_BANK_CHANGED',
                            'ROUTE_CAPACITY_CHANGED', 'TRADE_CANCELLATION', 'OPERATOR_MISTAKE', 'RECONCILIATION_MISMATCH')),
  severity                text NOT NULL CHECK (severity IN ('BLOCKING', 'WARNING')),
  status                  text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'VOID')),
  subject_type            text NOT NULL CHECK (subject_type IN ('TRADE', 'SETTLEMENT_LEG', 'FIAT_TRANSFER', 'CRYPTO_TRANSFER', 'DEPOSIT_ADDRESS', 'ROUTE_OBLIGATION', 'ROUTE_SETTLEMENT', 'INR_ACCOUNT', 'CLIENT')),
  subject_id              uuid NOT NULL,
  detected_by             text NOT NULL CHECK (detected_by IN ('SYSTEM', 'OPERATOR')),
  details                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  opened_by               text NOT NULL,
  opened_at               timestamptz NOT NULL DEFAULT inrp2p_now(),
  taken_by                text,
  taken_at                timestamptz,
  resolution_command      text CHECK (length(resolution_command) <= 60),
  resolution_notes        text CHECK (length(resolution_notes) <= 2000),
  financial_adjustment_id uuid,
  resolved_by             text,
  resolved_at             timestamptz,
  CHECK ((status IN ('RESOLVED', 'VOID')) = (resolved_at IS NOT NULL AND resolved_by IS NOT NULL)),
  CHECK (status <> 'RESOLVED' OR resolution_command IS NOT NULL),
  CHECK ((taken_by IS NULL) = (taken_at IS NULL))
);
-- One open case per subject and type (DOMAIN_MODEL §2.6).
CREATE UNIQUE INDEX exception_case_open_unique ON exception_case (type, subject_type, subject_id) WHERE status IN ('OPEN', 'IN_PROGRESS');
CREATE INDEX exception_case_trade_idx ON exception_case (trade_id) WHERE status IN ('OPEN', 'IN_PROGRESS');
CREATE TRIGGER exception_case_status BEFORE UPDATE ON exception_case
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'OPEN>IN_PROGRESS,OPEN>RESOLVED,IN_PROGRESS>RESOLVED,OPEN>VOID,IN_PROGRESS>VOID');
CREATE TRIGGER exception_case_immutable BEFORE UPDATE ON exception_case
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'details', 'taken_by', 'taken_at', 'resolution_command', 'resolution_notes', 'financial_adjustment_id', 'resolved_by', 'resolved_at');
CREATE TRIGGER exception_case_no_delete BEFORE DELETE OR TRUNCATE ON exception_case
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- H1/H2: `trade.hold` is exactly "this trade has an open BLOCKING case". Checked at commit, both directions.
CREATE FUNCTION inrp2p_check_trade_hold() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t_id uuid;
  should_hold boolean;
  actual boolean;
BEGIN
  IF TG_TABLE_NAME = 'trade' THEN
    t_id := NEW.id;
  ELSE
    t_id := NEW.trade_id;
  END IF;
  IF t_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT EXISTS (SELECT 1 FROM exception_case WHERE trade_id = t_id AND severity = 'BLOCKING' AND status IN ('OPEN', 'IN_PROGRESS')) INTO should_hold;
  SELECT hold INTO actual FROM trade WHERE id = t_id;
  IF actual IS DISTINCT FROM should_hold THEN
    RAISE EXCEPTION 'trade % hold=% does not match its open blocking exceptions (%)', t_id, actual, should_hold USING ERRCODE = 'IX046';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER exception_case_hold_consistent AFTER INSERT OR UPDATE ON exception_case
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inrp2p_check_trade_hold();
CREATE CONSTRAINT TRIGGER trade_hold_consistent AFTER UPDATE OF hold ON trade
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inrp2p_check_trade_hold();

-- ---------------------------------------------------------------------------
-- Settlement legs (DOMAIN_MODEL §2.7, STATE_MACHINES §4).
-- ---------------------------------------------------------------------------
CREATE TABLE settlement_leg (
  id                          uuid PRIMARY KEY DEFAULT uuidv7(),
  trade_id                    uuid NOT NULL REFERENCES trade (id),
  seq                         integer NOT NULL CHECK (seq > 0),
  ref                         text NOT NULL UNIQUE,
  side                        text NOT NULL CHECK (side IN ('CLIENT_TO_EXCHANGE', 'EXCHANGE_TO_CLIENT', 'REFUND_TO_CLIENT')),
  asset                       text NOT NULL CHECK (asset IN ('INR', 'USDT')),
  amount_minor                bigint NOT NULL CHECK (amount_minor > 0),
  status                      text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  payer                       text NOT NULL CHECK (payer IN ('CLIENT', 'EXCHANGE_ACCOUNT', 'ROUTE')),
  route_id                    uuid REFERENCES liquidity_route (id),
  inr_account_id              uuid REFERENCES inr_settlement_account (id),
  capacity_reservation_id     uuid REFERENCES capacity_reservation (id),
  treasury_wallet_id          uuid REFERENCES treasury_wallet (id),
  destination_bank_account_id uuid REFERENCES bank_account (id),
  destination_wallet_id       uuid REFERENCES crypto_wallet (id),
  notes                       text CHECK (length(notes) <= 2000),
  created_by                  text NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT inrp2p_now(),
  sent_at                     timestamptz,
  confirmed_at                timestamptz,
  failed_at                   timestamptz,
  cancelled_at                timestamptz,
  failure_reason              text CHECK (length(failure_reason) <= 500),
  UNIQUE (trade_id, seq),
  -- The client pays only the first leg; the route pays only a direct payout (FI-65).
  CHECK ((payer = 'CLIENT') = (side = 'CLIENT_TO_EXCHANGE')),
  CHECK ((payer = 'ROUTE') = (route_id IS NOT NULL)),
  CHECK (payer <> 'ROUTE' OR side = 'EXCHANGE_TO_CLIENT'),
  CHECK ((inr_account_id IS NOT NULL) = (payer = 'EXCHANGE_ACCOUNT' AND asset = 'INR')),
  CHECK (capacity_reservation_id IS NULL OR (payer = 'EXCHANGE_ACCOUNT' AND asset = 'INR')),
  CHECK (treasury_wallet_id IS NULL OR (payer = 'EXCHANGE_ACCOUNT' AND asset = 'USDT')),
  CHECK ((status = 'COMPLETED') = (confirmed_at IS NOT NULL)),
  CHECK ((status = 'FAILED') = (failed_at IS NOT NULL AND failure_reason IS NOT NULL)),
  CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL))
);
CREATE INDEX settlement_leg_trade_idx ON settlement_leg (trade_id, seq);
CREATE INDEX settlement_leg_open_idx ON settlement_leg (status) WHERE status IN ('PENDING', 'PROCESSING');

CREATE FUNCTION inrp2p_guard_settlement_leg_insert() RETURNS trigger
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
  -- FI-65: only a DIRECT_TO_CLIENT trade may have a route-paid leg, and only on its own route.
  IF NEW.payer = 'ROUTE' AND (e.route_execution_mode <> 'DIRECT_TO_CLIENT' OR NEW.route_id <> e.route_id) THEN
    RAISE EXCEPTION 'a route-paid leg requires the trade route in DIRECT_TO_CLIENT mode' USING ERRCODE = 'IX065';
  END IF;
  -- D-12: no payout before the client leg is confirmed.
  IF NEW.side = 'EXCHANGE_TO_CLIENT' AND t.lifecycle_state NOT IN ('FIRST_LEG_CONFIRMED', 'SETTLING', 'PARTIALLY_SETTLED') THEN
    RAISE EXCEPTION 'payout legs require a confirmed client leg (trade is %)', t.lifecycle_state USING ERRCODE = 'IX048';
  END IF;
  NEW.ref := t.ref || '-L' || NEW.seq;
  RETURN NEW;
END
$$;
CREATE TRIGGER settlement_leg_insert BEFORE INSERT ON settlement_leg
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_settlement_leg_insert();
CREATE TRIGGER settlement_leg_status BEFORE UPDATE ON settlement_leg
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'PENDING>PROCESSING,PENDING>CANCELLED,PENDING>FAILED,PROCESSING>COMPLETED,PROCESSING>FAILED');
CREATE TRIGGER settlement_leg_immutable BEFORE UPDATE ON settlement_leg
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'capacity_reservation_id', 'notes', 'sent_at', 'confirmed_at', 'failed_at', 'cancelled_at', 'failure_reason');
CREATE TRIGGER settlement_leg_no_delete BEFORE DELETE OR TRUNCATE ON settlement_leg
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- FI-20: committed payout legs never exceed the effective payout obligation.
CREATE FUNCTION inrp2p_check_leg_total() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t_id uuid := NEW.trade_id;
  committed bigint;
  obligation bigint;
BEGIN
  SELECT coalesce(sum(amount_minor), 0) INTO committed FROM settlement_leg
   WHERE trade_id = t_id AND side = 'EXCHANGE_TO_CLIENT' AND status IN ('PENDING', 'PROCESSING', 'COMPLETED');
  obligation := inrp2p_trade_payout_obligation(t_id);
  IF committed > obligation THEN
    RAISE EXCEPTION 'payout legs of trade % total % over an obligation of %', t_id, committed, obligation USING ERRCODE = 'IX020';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER settlement_leg_total_within_obligation AFTER INSERT OR UPDATE ON settlement_leg
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inrp2p_check_leg_total();

-- ---------------------------------------------------------------------------
-- Movements: one real transfer = one evidence row = one journal (FI-27).
-- ---------------------------------------------------------------------------
CREATE TABLE fiat_transfer (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  rail               text NOT NULL CHECK (rail IN ('IMPS', 'NEFT', 'RTGS', 'UPI')),
  utr                text NOT NULL CHECK (length(btrim(utr)) BETWEEN 6 AND 40),
  amount_minor       bigint NOT NULL CHECK (amount_minor > 0),
  payer_type         text NOT NULL CHECK (payer_type IN ('CLIENT', 'EXCHANGE_ACCOUNT', 'ROUTE')),
  payer_id           uuid NOT NULL,
  payee_type         text NOT NULL CHECK (payee_type IN ('CLIENT_BANK', 'EXCHANGE_ACCOUNT', 'ROUTE')),
  payee_id           uuid NOT NULL,
  destination_masked text NOT NULL CHECK (length(destination_masked) BETWEEN 3 AND 200),
  value_date         date,
  status             text NOT NULL DEFAULT 'RECORDED' CHECK (status IN ('RECORDED', 'CONFIRMED', 'FAILED')),
  recorded_by        text NOT NULL,
  recorded_at        timestamptz NOT NULL DEFAULT inrp2p_now(),
  confirmed_at       timestamptz,
  failed_at          timestamptz,
  failure_reason     text CHECK (length(failure_reason) <= 500),
  CHECK ((status = 'CONFIRMED') = (confirmed_at IS NOT NULL)),
  CHECK ((status = 'FAILED') = (failed_at IS NOT NULL AND failure_reason IS NOT NULL))
);
-- FI-22: a UTR identifies at most one movement per rail, however it was typed.
CREATE UNIQUE INDEX fiat_transfer_rail_utr ON fiat_transfer (rail, upper(btrim(utr)));
CREATE TRIGGER fiat_transfer_status BEFORE UPDATE ON fiat_transfer
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'RECORDED>CONFIRMED,RECORDED>FAILED');
CREATE TRIGGER fiat_transfer_immutable BEFORE UPDATE ON fiat_transfer
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'confirmed_at', 'failed_at', 'failure_reason', 'value_date');
CREATE TRIGGER fiat_transfer_no_delete BEFORE DELETE OR TRUNCATE ON fiat_transfer
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

CREATE TABLE crypto_transfer (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  network          text NOT NULL CHECK (network IN ('TRON')),
  tx_hash          text NOT NULL CHECK (tx_hash ~ '^[0-9a-f]{64}$'),
  log_index        integer NOT NULL CHECK (log_index >= 0),
  token_contract   inrp2p_tron_address NOT NULL,
  from_address     inrp2p_tron_address NOT NULL,
  to_address       inrp2p_tron_address NOT NULL,
  amount_minor     bigint NOT NULL CHECK (amount_minor > 0),
  payer_type       text NOT NULL CHECK (payer_type IN ('CLIENT', 'EXCHANGE_TREASURY', 'ROUTE', 'UNKNOWN')),
  payer_id         uuid,
  payee_type       text NOT NULL CHECK (payee_type IN ('CLIENT_WALLET', 'EXCHANGE_TREASURY', 'ROUTE', 'UNKNOWN')),
  payee_id         uuid,
  block_number     bigint CHECK (block_number > 0),
  block_time       timestamptz,
  receipt_status   text CHECK (receipt_status IN ('SUCCESS', 'FAILED')),
  solidified_block bigint CHECK (solidified_block > 0),
  state            text NOT NULL DEFAULT 'DETECTED' CHECK (state IN ('DETECTED', 'CONFIRMED', 'FAILED', 'ORPHANED')),
  verified_by      text CHECK (length(verified_by) <= 200),
  source           text NOT NULL CHECK (source IN ('SCANNER', 'OPERATOR_SUBMITTED')),
  detected_at      timestamptz NOT NULL DEFAULT inrp2p_now(),
  confirmed_at     timestamptz,
  failed_at        timestamptz,
  created_by       text NOT NULL,
  -- FI-24: confirmation requires a successful receipt in a solidified block, verified by the configured providers.
  CHECK ((state = 'CONFIRMED') = (confirmed_at IS NOT NULL AND receipt_status = 'SUCCESS' AND block_number IS NOT NULL
                                  AND solidified_block IS NOT NULL AND solidified_block >= block_number AND verified_by IS NOT NULL)),
  CHECK ((state IN ('FAILED', 'ORPHANED')) = (failed_at IS NOT NULL))
);
-- FI-23: one row per on-chain transfer event.
CREATE UNIQUE INDEX crypto_transfer_identity ON crypto_transfer (network, tx_hash, log_index);
CREATE INDEX crypto_transfer_to_idx ON crypto_transfer (to_address, state);
CREATE TRIGGER crypto_transfer_state BEFORE UPDATE ON crypto_transfer
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('state', 'DETECTED>CONFIRMED,DETECTED>FAILED,DETECTED>ORPHANED,CONFIRMED>ORPHANED');
CREATE TRIGGER crypto_transfer_immutable BEFORE UPDATE ON crypto_transfer
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('state', 'block_number', 'block_time', 'receipt_status', 'solidified_block', 'verified_by', 'confirmed_at', 'failed_at', 'payer_type', 'payer_id', 'payee_type', 'payee_id');
CREATE TRIGGER crypto_transfer_no_delete BEFORE DELETE OR TRUNCATE ON crypto_transfer
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- ---------------------------------------------------------------------------
-- Route settlements (STATE_MACHINES §10). Each references exactly one movement.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE route_settlement_ref_seq;
CREATE TABLE route_settlement (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  ref                     text NOT NULL UNIQUE DEFAULT ('RS-' || lpad(nextval('route_settlement_ref_seq')::text, 6, '0')),
  route_id                uuid NOT NULL REFERENCES liquidity_route (id),
  -- V1 obligations are PER_TRADE, so every settlement targets one obligation side from the moment it is recorded.
  route_obligation_id     uuid NOT NULL REFERENCES route_obligation (id),
  obligation_side         text NOT NULL CHECK (obligation_side IN ('ROUTE_DELIVERS', 'EXCHANGE_DELIVERS')),
  flow                    text NOT NULL CHECK (flow IN ('FROM_ROUTE_TO_EXCHANGE', 'TO_ROUTE', 'DIRECT_TO_CLIENT')),
  asset                   text NOT NULL CHECK (asset IN ('INR', 'USDT')),
  amount_minor            bigint NOT NULL CHECK (amount_minor > 0),
  transfer_kind           text NOT NULL CHECK (transfer_kind IN ('FIAT', 'CRYPTO')),
  fiat_transfer_id        uuid REFERENCES fiat_transfer (id),
  crypto_transfer_id      uuid REFERENCES crypto_transfer (id),
  capacity_reservation_id uuid REFERENCES capacity_reservation (id),
  status                  text NOT NULL DEFAULT 'RECORDED' CHECK (status IN ('RECORDED', 'CONFIRMED', 'FAILED')),
  created_by              text NOT NULL,
  recorded_at             timestamptz NOT NULL DEFAULT inrp2p_now(),
  confirmed_at            timestamptz,
  failed_at               timestamptz,
  failure_reason          text CHECK (length(failure_reason) <= 500),
  CHECK ((transfer_kind = 'FIAT') = (fiat_transfer_id IS NOT NULL AND crypto_transfer_id IS NULL)),
  CHECK ((transfer_kind = 'CRYPTO') = (crypto_transfer_id IS NOT NULL AND fiat_transfer_id IS NULL)),
  CHECK ((transfer_kind = 'FIAT') = (asset = 'INR')),
  CHECK (capacity_reservation_id IS NULL OR flow = 'TO_ROUTE'),
  CHECK ((flow = 'TO_ROUTE') = (obligation_side = 'EXCHANGE_DELIVERS')),
  CHECK ((status = 'CONFIRMED') = (confirmed_at IS NOT NULL)),
  CHECK ((status = 'FAILED') = (failed_at IS NOT NULL AND failure_reason IS NOT NULL))
);
CREATE UNIQUE INDEX route_settlement_fiat_unique ON route_settlement (fiat_transfer_id) WHERE fiat_transfer_id IS NOT NULL;
CREATE UNIQUE INDEX route_settlement_crypto_unique ON route_settlement (crypto_transfer_id) WHERE crypto_transfer_id IS NOT NULL;
CREATE INDEX route_settlement_route_idx ON route_settlement (route_id, status);
CREATE FUNCTION inrp2p_guard_route_settlement_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  movement_amount bigint;
  route_to_client boolean;
BEGIN
  IF NEW.transfer_kind = 'FIAT' THEN
    SELECT amount_minor INTO movement_amount FROM fiat_transfer WHERE id = NEW.fiat_transfer_id;
  ELSE
    SELECT amount_minor INTO movement_amount FROM crypto_transfer WHERE id = NEW.crypto_transfer_id;
  END IF;
  IF movement_amount IS DISTINCT FROM NEW.amount_minor THEN
    RAISE EXCEPTION 'a route settlement amount must equal its movement amount' USING ERRCODE = 'IX061';
  END IF;
  -- DIRECT_TO_CLIENT settlements exist only as the route side of a confirmed direct payout (§4), which means
  -- their movement really was paid by the route to the client.
  IF NEW.flow = 'DIRECT_TO_CLIENT' THEN
    IF NEW.status <> 'CONFIRMED' THEN
      RAISE EXCEPTION 'a DIRECT_TO_CLIENT route settlement is created confirmed by the payout confirm' USING ERRCODE = 'IX065';
    END IF;
    IF NEW.transfer_kind = 'FIAT' THEN
      SELECT payer_type = 'ROUTE' AND payee_type = 'CLIENT_BANK' INTO route_to_client FROM fiat_transfer WHERE id = NEW.fiat_transfer_id;
    ELSE
      SELECT payer_type = 'ROUTE' AND payee_type = 'CLIENT_WALLET' INTO route_to_client FROM crypto_transfer WHERE id = NEW.crypto_transfer_id;
    END IF;
    IF NOT coalesce(route_to_client, false) THEN
      RAISE EXCEPTION 'a DIRECT_TO_CLIENT route settlement needs a route→client movement' USING ERRCODE = 'IX065';
    END IF;
  END IF;
  IF NEW.flow <> 'DIRECT_TO_CLIENT' AND NEW.status <> 'RECORDED' THEN
    RAISE EXCEPTION 'a route settlement starts RECORDED' USING ERRCODE = 'IX040';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER route_settlement_insert BEFORE INSERT ON route_settlement
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_route_settlement_insert();
CREATE TRIGGER route_settlement_status BEFORE UPDATE ON route_settlement
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'RECORDED>CONFIRMED,RECORDED>FAILED');
CREATE TRIGGER route_settlement_immutable BEFORE UPDATE ON route_settlement
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'capacity_reservation_id', 'confirmed_at', 'failed_at', 'failure_reason');
-- Deferred in Phase 2: a ROUTE_SETTLEMENT reservation now points at a real route settlement.
ALTER TABLE capacity_reservation ADD CONSTRAINT capacity_reservation_route_settlement_fk FOREIGN KEY (route_settlement_id) REFERENCES route_settlement (id);
CREATE TRIGGER route_settlement_no_delete BEFORE DELETE OR TRUNCATE ON route_settlement
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- ---------------------------------------------------------------------------
-- Allocations: what a movement satisfied (FI-28). Append-only; corrections are adjustments.
-- ---------------------------------------------------------------------------
CREATE TABLE transfer_allocation (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  transfer_kind      text NOT NULL CHECK (transfer_kind IN ('FIAT', 'CRYPTO')),
  fiat_transfer_id   uuid REFERENCES fiat_transfer (id),
  crypto_transfer_id uuid REFERENCES crypto_transfer (id),
  dimension          text NOT NULL CHECK (dimension IN ('CLIENT', 'ROUTE')),
  settlement_leg_id  uuid REFERENCES settlement_leg (id),
  exception_case_id  uuid REFERENCES exception_case (id),
  route_settlement_id uuid REFERENCES route_settlement (id),
  amount_minor       bigint NOT NULL CHECK (amount_minor > 0),
  allocated_by       text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT inrp2p_now(),
  -- An allocation is never edited or deleted; a mis-entered UTR is voided (audited) and replaced.
  voided_at          timestamptz,
  voided_by          text,
  void_reason        text CHECK (length(void_reason) <= 500),
  CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL)),
  CHECK ((transfer_kind = 'FIAT') = (fiat_transfer_id IS NOT NULL AND crypto_transfer_id IS NULL)),
  CHECK ((transfer_kind = 'CRYPTO') = (crypto_transfer_id IS NOT NULL AND fiat_transfer_id IS NULL)),
  CHECK ((dimension = 'CLIENT' AND route_settlement_id IS NULL AND ((settlement_leg_id IS NOT NULL) <> (exception_case_id IS NOT NULL)))
      OR (dimension = 'ROUTE' AND route_settlement_id IS NOT NULL AND settlement_leg_id IS NULL AND exception_case_id IS NULL))
);
-- FI-28: at most one CLIENT and one ROUTE link per movement, and one evidence per leg.
CREATE UNIQUE INDEX transfer_allocation_fiat_dimension ON transfer_allocation (fiat_transfer_id, dimension) WHERE fiat_transfer_id IS NOT NULL AND voided_at IS NULL;
CREATE UNIQUE INDEX transfer_allocation_crypto_dimension ON transfer_allocation (crypto_transfer_id, dimension) WHERE crypto_transfer_id IS NOT NULL AND voided_at IS NULL;
CREATE UNIQUE INDEX transfer_allocation_leg_unique ON transfer_allocation (settlement_leg_id) WHERE settlement_leg_id IS NOT NULL AND voided_at IS NULL;
CREATE UNIQUE INDEX transfer_allocation_route_settlement_unique ON transfer_allocation (route_settlement_id) WHERE route_settlement_id IS NOT NULL AND voided_at IS NULL;

CREATE FUNCTION inrp2p_guard_transfer_allocation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  movement_amount bigint;
  m_payer text;
  m_payee text;
  other_dimension boolean;
  leg settlement_leg%ROWTYPE;
BEGIN
  IF NEW.transfer_kind = 'FIAT' THEN
    SELECT amount_minor, payer_type, payee_type INTO movement_amount, m_payer, m_payee FROM fiat_transfer WHERE id = NEW.fiat_transfer_id;
    SELECT EXISTS (SELECT 1 FROM transfer_allocation WHERE fiat_transfer_id = NEW.fiat_transfer_id AND dimension <> NEW.dimension AND voided_at IS NULL) INTO other_dimension;
  ELSE
    SELECT amount_minor, payer_type, payee_type INTO movement_amount, m_payer, m_payee FROM crypto_transfer WHERE id = NEW.crypto_transfer_id;
    SELECT EXISTS (SELECT 1 FROM transfer_allocation WHERE crypto_transfer_id = NEW.crypto_transfer_id AND dimension <> NEW.dimension AND voided_at IS NULL) INTO other_dimension;
  END IF;
  -- The whole movement is allocated, never a part of it (over/short payments are exceptions).
  IF movement_amount IS DISTINCT FROM NEW.amount_minor THEN
    RAISE EXCEPTION 'an allocation must cover the whole movement (% vs %)', NEW.amount_minor, movement_amount USING ERRCODE = 'IX028';
  END IF;
  -- Both dimensions only for a route→client movement (FI-28).
  IF other_dimension AND NOT (m_payer = 'ROUTE' AND m_payee IN ('CLIENT_BANK', 'CLIENT_WALLET')) THEN
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
CREATE TRIGGER transfer_allocation_guard BEFORE INSERT ON transfer_allocation
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_transfer_allocation();
-- The only permitted update is the one-way void; nothing else about an allocation can change.
CREATE FUNCTION inrp2p_guard_allocation_void() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'allocation % is already void', OLD.id USING ERRCODE = 'IX041';
  END IF;
  IF NEW.voided_at IS NULL OR NEW.transfer_kind <> OLD.transfer_kind OR NEW.dimension <> OLD.dimension
     OR NEW.amount_minor <> OLD.amount_minor OR NEW.settlement_leg_id IS DISTINCT FROM OLD.settlement_leg_id
     OR NEW.route_settlement_id IS DISTINCT FROM OLD.route_settlement_id OR NEW.exception_case_id IS DISTINCT FROM OLD.exception_case_id
     OR NEW.fiat_transfer_id IS DISTINCT FROM OLD.fiat_transfer_id OR NEW.crypto_transfer_id IS DISTINCT FROM OLD.crypto_transfer_id THEN
    RAISE EXCEPTION 'an allocation can only be voided' USING ERRCODE = 'IX041';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER transfer_allocation_void BEFORE UPDATE ON transfer_allocation
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_allocation_void();
CREATE TRIGGER transfer_allocation_no_delete BEFORE DELETE OR TRUNCATE ON transfer_allocation
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

CREATE TABLE route_settlement_allocation (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  route_settlement_id uuid NOT NULL REFERENCES route_settlement (id),
  route_obligation_id uuid NOT NULL REFERENCES route_obligation (id),
  side                text NOT NULL CHECK (side IN ('ROUTE_DELIVERS', 'EXCHANGE_DELIVERS')),
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  allocated_by        text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT inrp2p_now(),
  UNIQUE (route_settlement_id, route_obligation_id, side)
);
CREATE INDEX route_settlement_allocation_obligation_idx ON route_settlement_allocation (route_obligation_id, side);
CREATE FUNCTION inrp2p_guard_route_settlement_allocation() RETURNS trigger
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
  -- FI-65: which flows may satisfy which side, and which modes allow route→client at all.
  IF (s.flow = 'TO_ROUTE') <> (NEW.side = 'EXCHANGE_DELIVERS') THEN
    RAISE EXCEPTION 'flow % cannot satisfy the % side', s.flow, NEW.side USING ERRCODE = 'IX065';
  END IF;
  IF s.flow = 'DIRECT_TO_CLIENT' AND o.execution_mode <> 'DIRECT_TO_CLIENT' THEN
    RAISE EXCEPTION 'a direct-to-client movement cannot satisfy a TO_EXCHANGE obligation' USING ERRCODE = 'IX065';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER route_settlement_allocation_guard BEFORE INSERT ON route_settlement_allocation
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_route_settlement_allocation();
CREATE TRIGGER route_settlement_allocation_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON route_settlement_allocation
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- FI-61: allocations never exceed the settlement amount or an obligation side.
CREATE FUNCTION inrp2p_check_route_allocation_totals() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s_total bigint;
  s_amount bigint;
  side_total bigint;
  side_amount bigint;
BEGIN
  SELECT coalesce(sum(amount_minor), 0) INTO s_total FROM route_settlement_allocation WHERE route_settlement_id = NEW.route_settlement_id;
  SELECT amount_minor INTO s_amount FROM route_settlement WHERE id = NEW.route_settlement_id;
  IF s_total > s_amount THEN
    RAISE EXCEPTION 'route settlement % allocated % over its amount %', NEW.route_settlement_id, s_total, s_amount USING ERRCODE = 'IX061';
  END IF;
  SELECT coalesce(sum(amount_minor), 0) INTO side_total FROM route_settlement_allocation
   WHERE route_obligation_id = NEW.route_obligation_id AND side = NEW.side;
  side_amount := inrp2p_route_obligation_side(NEW.route_obligation_id, NEW.side);
  IF side_total > side_amount THEN
    RAISE EXCEPTION 'obligation % side % allocated % over %', NEW.route_obligation_id, NEW.side, side_total, side_amount USING ERRCODE = 'IX061';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER route_settlement_allocation_totals AFTER INSERT ON route_settlement_allocation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inrp2p_check_route_allocation_totals();

-- ---------------------------------------------------------------------------
-- Financial adjustments (STATE_MACHINES §8, FI-12, SECURITY §4 two-person rule).
-- ---------------------------------------------------------------------------
CREATE SEQUENCE financial_adjustment_ref_seq;
CREATE TABLE financial_adjustment (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  ref                    text NOT NULL UNIQUE DEFAULT ('AJ-' || lpad(nextval('financial_adjustment_ref_seq')::text, 6, '0')),
  trade_id               uuid NOT NULL REFERENCES trade (id),
  type                   text NOT NULL CHECK (type IN ('AMOUNT_CORRECTION', 'RATE_CORRECTION', 'FEE', 'WRITE_OFF', 'REFUND')),
  delta_base_minor       bigint NOT NULL DEFAULT 0,
  delta_quote_inr_minor  bigint NOT NULL DEFAULT 0,
  delta_route_inr_minor  bigint NOT NULL DEFAULT 0,
  delta_margin_inr_minor bigint NOT NULL DEFAULT 0,
  reason                 text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 2000),
  evidence_note          text CHECK (length(evidence_note) <= 2000),
  exception_case_id      uuid REFERENCES exception_case (id),
  status                 text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'POSTED', 'REJECTED')),
  requested_by           text NOT NULL,
  requested_at           timestamptz NOT NULL DEFAULT inrp2p_now(),
  approved_by            text,
  approved_at            timestamptz,
  rejected_by            text,
  rejected_at            timestamptz,
  reject_reason          text CHECK (length(reject_reason) <= 500),
  ledger_journal_id      uuid REFERENCES ledger_journal (id),
  -- SECURITY §4: the approver is never the requester.
  CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CHECK ((status = 'POSTED') = (approved_by IS NOT NULL AND approved_at IS NOT NULL AND ledger_journal_id IS NOT NULL)),
  CHECK ((status = 'REJECTED') = (rejected_by IS NOT NULL AND rejected_at IS NOT NULL AND reject_reason IS NOT NULL)),
  CHECK (NOT (delta_base_minor = 0 AND delta_quote_inr_minor = 0 AND delta_route_inr_minor = 0 AND delta_margin_inr_minor = 0))
);
CREATE INDEX financial_adjustment_trade_idx ON financial_adjustment (trade_id, requested_at);
ALTER TABLE exception_case ADD CONSTRAINT exception_case_adjustment_fk FOREIGN KEY (financial_adjustment_id) REFERENCES financial_adjustment (id);
-- FI-02 for deltas: the margin delta is derived from the client and route deltas, per direction.
CREATE FUNCTION inrp2p_guard_adjustment_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d text;
  expected bigint;
BEGIN
  SELECT direction INTO d FROM trade_economics WHERE trade_id = NEW.trade_id;
  expected := CASE WHEN d = 'SELL_USDT' THEN NEW.delta_route_inr_minor - NEW.delta_quote_inr_minor
                   ELSE NEW.delta_quote_inr_minor - NEW.delta_route_inr_minor END;
  IF NEW.delta_margin_inr_minor <> expected THEN
    RAISE EXCEPTION 'adjustment margin delta % is not derived from the client and route deltas (%)', NEW.delta_margin_inr_minor, expected USING ERRCODE = 'IX002';
  END IF;
  IF NEW.status <> 'REQUESTED' THEN
    RAISE EXCEPTION 'an adjustment starts REQUESTED' USING ERRCODE = 'IX040';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER financial_adjustment_insert BEFORE INSERT ON financial_adjustment
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_adjustment_insert();
CREATE TRIGGER financial_adjustment_status BEFORE UPDATE ON financial_adjustment
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'REQUESTED>POSTED,REQUESTED>REJECTED');
CREATE TRIGGER financial_adjustment_immutable BEFORE UPDATE ON financial_adjustment
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'approved_by', 'approved_at', 'rejected_by', 'rejected_at', 'reject_reason', 'ledger_journal_id', 'exception_case_id');
CREATE TRIGGER financial_adjustment_no_delete BEFORE DELETE OR TRUNCATE ON financial_adjustment
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- ---------------------------------------------------------------------------
-- Effective obligations: frozen economics ⊕ posted adjustments (FI-12, FI-20, FI-21).
-- ---------------------------------------------------------------------------
CREATE FUNCTION inrp2p_trade_payout_obligation(p_trade uuid) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN e.direction = 'SELL_USDT' THEN e.quote_inr_minor ELSE e.base_minor END
       + coalesce((SELECT sum(CASE WHEN e.direction = 'SELL_USDT' THEN a.delta_quote_inr_minor ELSE a.delta_base_minor END)
                   FROM financial_adjustment a WHERE a.trade_id = p_trade AND a.status = 'POSTED'), 0)
  FROM trade_economics e WHERE e.trade_id = p_trade
$$;

-- The effective amount of one obligation side: the frozen route economics ⊕ posted adjustments (FI-60, FI-64).
-- The row itself never changes; adjustments move the number the ledger and the allocations are measured against.
CREATE FUNCTION inrp2p_route_obligation_side(p_obligation uuid, p_side text) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_side = 'ROUTE_DELIVERS' THEN o.route_delivers_minor ELSE o.exchange_delivers_minor END
       + coalesce((SELECT sum(CASE WHEN (CASE WHEN p_side = 'ROUTE_DELIVERS' THEN o.route_delivers_asset ELSE o.exchange_delivers_asset END) = 'INR'
                                   THEN a.delta_route_inr_minor ELSE a.delta_base_minor END)
                   FROM financial_adjustment a WHERE a.trade_id = o.trade_id AND a.status = 'POSTED'), 0)
  FROM route_obligation o WHERE o.id = p_obligation
$$;

CREATE FUNCTION inrp2p_trade_receivable_obligation(p_trade uuid) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN e.direction = 'SELL_USDT' THEN e.base_minor ELSE e.quote_inr_minor END
       + coalesce((SELECT sum(CASE WHEN e.direction = 'SELL_USDT' THEN a.delta_base_minor ELSE a.delta_quote_inr_minor END)
                   FROM financial_adjustment a WHERE a.trade_id = p_trade AND a.status = 'POSTED'), 0)
  FROM trade_economics e WHERE e.trade_id = p_trade
$$;

-- ---------------------------------------------------------------------------
-- Trade lifecycle: the Phase 3 placeholder whitelist is replaced by T2–T10.
-- ---------------------------------------------------------------------------
DROP TRIGGER trade_status ON trade;
CREATE TRIGGER trade_status BEFORE UPDATE ON trade
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('lifecycle_state',
    'AWAITING_FIRST_LEG>FIRST_LEG_DETECTED,FIRST_LEG_DETECTED>AWAITING_FIRST_LEG,FIRST_LEG_DETECTED>FIRST_LEG_CONFIRMED,'
    'FIRST_LEG_CONFIRMED>SETTLING,SETTLING>PARTIALLY_SETTLED,SETTLING>COMPLETED,PARTIALLY_SETTLED>COMPLETED,'
    'AWAITING_FIRST_LEG>CANCELLED,FIRST_LEG_DETECTED>CANCELLED,FIRST_LEG_CONFIRMED>CANCELLED,SETTLING>CANCELLED,PARTIALLY_SETTLED>CANCELLED');

DROP TRIGGER route_obligation_status ON route_obligation;
CREATE TRIGGER route_obligation_status BEFORE UPDATE ON route_obligation
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status',
    'OPEN>PARTIALLY_SETTLED,OPEN>SETTLED,PARTIALLY_SETTLED>SETTLED,OPEN>CANCELLED');

-- FI-21: COMPLETED means both sides are fully confirmed, in evidence, at the moment of the transition.
CREATE FUNCTION inrp2p_guard_trade_completion() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  paid bigint;
  received bigint;
  blocking integer;
BEGIN
  IF NEW.lifecycle_state = 'COMPLETED' AND OLD.lifecycle_state <> 'COMPLETED' THEN
    SELECT coalesce(sum(amount_minor), 0) INTO paid FROM settlement_leg
     WHERE trade_id = NEW.id AND side = 'EXCHANGE_TO_CLIENT' AND status = 'COMPLETED';
    SELECT coalesce(sum(amount_minor), 0) INTO received FROM settlement_leg
     WHERE trade_id = NEW.id AND side = 'CLIENT_TO_EXCHANGE' AND status = 'COMPLETED';
    IF paid <> inrp2p_trade_payout_obligation(NEW.id) OR received <> inrp2p_trade_receivable_obligation(NEW.id) THEN
      RAISE EXCEPTION 'trade % cannot complete: paid %/% received %/%', NEW.id, paid, inrp2p_trade_payout_obligation(NEW.id), received, inrp2p_trade_receivable_obligation(NEW.id) USING ERRCODE = 'IX021';
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
CREATE TRIGGER trade_completion_guard BEFORE UPDATE ON trade
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_trade_completion();

-- ---------------------------------------------------------------------------
-- Grants: append-only tables get SELECT/INSERT; lifecycle columns get column-level UPDATE. No DELETE anywhere.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SEQUENCE exception_case_ref_seq, route_settlement_ref_seq, financial_adjustment_ref_seq TO inrp2p_app;
GRANT EXECUTE ON FUNCTION inrp2p_trade_payout_obligation(uuid), inrp2p_trade_receivable_obligation(uuid), inrp2p_route_obligation_side(uuid, text) TO inrp2p_app, inrp2p_readonly;
GRANT SELECT, INSERT ON exception_case, settlement_leg, fiat_transfer, crypto_transfer, route_settlement, transfer_allocation, route_settlement_allocation, financial_adjustment TO inrp2p_app;
GRANT UPDATE (status, taken_by, taken_at, resolution_command, resolution_notes, financial_adjustment_id, resolved_by, resolved_at) ON exception_case TO inrp2p_app;
GRANT UPDATE (status, capacity_reservation_id, notes, sent_at, confirmed_at, failed_at, cancelled_at, failure_reason) ON settlement_leg TO inrp2p_app;
GRANT UPDATE (status, confirmed_at, failed_at, failure_reason, value_date) ON fiat_transfer TO inrp2p_app;
GRANT UPDATE (state, block_number, block_time, receipt_status, solidified_block, verified_by, confirmed_at, failed_at, payer_type, payer_id, payee_type, payee_id) ON crypto_transfer TO inrp2p_app;
GRANT UPDATE (status, capacity_reservation_id, confirmed_at, failed_at, failure_reason) ON route_settlement TO inrp2p_app;
GRANT UPDATE (status, approved_by, approved_at, rejected_by, rejected_at, reject_reason, ledger_journal_id) ON financial_adjustment TO inrp2p_app;
GRANT UPDATE (voided_at, voided_by, void_reason) ON transfer_allocation TO inrp2p_app;
GRANT SELECT ON exception_case, settlement_leg, fiat_transfer, crypto_transfer, route_settlement, transfer_allocation, route_settlement_allocation, financial_adjustment TO inrp2p_readonly;
