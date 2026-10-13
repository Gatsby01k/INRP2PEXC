-- 0037 USDT TRC20 rails (ADR 0017): deposit addresses derived per trade from the exchange's own HD wallet, an
-- automatic signer that sends USDT exactly once, and a TRX network budget the participants prefund.
--
-- 1. Custody. `custody_hd_account` records the one extended public key (BIP-44, TRON coin type 195) every DERIVED
--    deposit address comes from, and the budget wallet's derivation path. The web app derives addresses from that
--    public key alone; only the worker's signer holds the seed. `custody_derivation_index_seq` hands out indexes that
--    are never reused, whatever rolls back.
-- 2. Network fees. A network transaction costs TRX (energy, bandwidth, account activation), never USDT: holding back
--    USDT does not pay for it. `network_fee_snapshot` is what the chain charges now, `network_trx_rate` what a TRX is
--    worth in USDT, and `network_fee_policy` how much is priced, reserved and topped up. A quote freezes its network
--    fee, the trader's reward and the net margin in `quote_network_fee`; a quote that would not make money is never
--    sent or accepted.
-- 3. The budget. TRX is prefunded: a trader's own network deposit pays for the transfers of its orders, and the
--    platform's budget only for desk routes and the platform's own mistakes. `network_budget_entry` is its append-only
--    sub-ledger, apart from trading money (the ledger) and from the Security Reserve; `network_budget_hold` holds the
--    worst case of a trade (its transfer and a possible refund) from acceptance on. Nothing is spent that is not
--    covered: a hold, a top-up and a withdrawal are refused at commit when the funder's budget would go negative.
-- 4. Sends. `chain_send` is one intended on-chain transfer; `chain_send_attempt` one signed transaction of it, stored
--    with its txid before it is broadcast. At most one attempt of a send may be live or confirmed, and another is
--    signed only once every earlier one provably can no longer land (expired past the solidified head, or failed on
--    chain): a retried job or a timeout re-broadcasts the same bytes and never makes a second transfer.
-- 5. A payment to the route that the signer makes is earmarked against the client's funds when it is planned
--    (`funding_allocation.use_chain_send_id`), and becomes a route settlement when the chain makes it final
--    (`route_settlement.chain_send_id`) — the same earmark, consumed once.
--
-- Error codes IX103–IX112 belong to this migration. 0001–0036 are not edited.


-- ---------------------------------------------------------------------------------------------------------------
-- 1. Custody
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE custody_hd_account (
  provider            text PRIMARY KEY CHECK (provider ~ '^[a-z0-9][a-z0-9_-]{1,40}$'),
  network             text NOT NULL CHECK (network = 'TRON'),
  -- m/44'/195'/0' — deposit addresses are its external chain, m/44'/195'/0'/0/{index}.
  account_xpub        text NOT NULL UNIQUE CHECK (account_xpub ~ '^xpub[1-9A-HJ-NP-Za-km-z]{100,112}$'),
  deposit_path_prefix text NOT NULL CHECK (deposit_path_prefix ~ '^m(/[0-9]+''?){4}$'),
  fee_wallet_path     text NOT NULL CHECK (fee_wallet_path ~ '^m(/[0-9]+''?){5}$'),
  fee_wallet_address  inrp2p_tron_address NOT NULL UNIQUE,
  recorded_by         text NOT NULL,
  recorded_at         timestamptz NOT NULL DEFAULT inrp2p_now()
);
CREATE TRIGGER custody_hd_account_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON custody_hd_account
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

CREATE SEQUENCE custody_derivation_index_seq MINVALUE 0 START 0 NO CYCLE;

-- The budget wallet is an exchange wallet whose key the signer holds.
ALTER TABLE treasury_wallet DROP CONSTRAINT treasury_wallet_role_check;
ALTER TABLE treasury_wallet ADD CONSTRAINT treasury_wallet_role_check CHECK (role IN ('HOT', 'COLD', 'DEPOSIT_POOL', 'TRADER_RESERVE', 'NETWORK_BUDGET'));
ALTER TABLE treasury_wallet DROP CONSTRAINT treasury_wallet_custody_check;
ALTER TABLE treasury_wallet ADD CONSTRAINT treasury_wallet_custody_check CHECK (custody IN ('EXTERNAL', 'HD_SIGNER'));
CREATE UNIQUE INDEX treasury_wallet_one_network_budget ON treasury_wallet (role) WHERE role = 'NETWORK_BUDGET' AND status = 'ACTIVE';

ALTER TABLE crypto_transfer DROP CONSTRAINT crypto_transfer_source_check;
ALTER TABLE crypto_transfer ADD CONSTRAINT crypto_transfer_source_check CHECK (source IN ('SCANNER', 'OPERATOR_SUBMITTED', 'CLIENT_SUBMITTED', 'CUSTODY_SIGNER'));

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Network fees
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE network_fee_policy (
  id                        uuid PRIMARY KEY DEFAULT uuidv7(),
  -- Energy of one USDT transfer the client's price assumes (a recipient with no USDT yet costs about twice a holder).
  quote_energy              integer NOT NULL CHECK (quote_energy BETWEEN 10000 AND 1000000),
  -- Energy the budget holds per transfer: the worst case the trade may need.
  reserve_energy            integer NOT NULL CHECK (reserve_energy BETWEEN 10000 AND 2000000),
  -- TRX left on a deal address for its transfer's bandwidth (free daily bandwidth usually covers it).
  bandwidth_buffer_sun      bigint NOT NULL CHECK (bandwidth_buffer_sun BETWEEN 0 AND 10000000),
  -- Bytes of a TRX top-up transfer, for its bandwidth when the budget wallet has no free bandwidth left.
  topup_bytes               integer NOT NULL CHECK (topup_bytes BETWEEN 100 AND 2000),
  -- Above the energy estimated for a transfer, sent to the deal address and allowed as its fee limit.
  topup_buffer_bps          integer NOT NULL CHECK (topup_buffer_bps BETWEEN 0 AND 5000),
  -- Above the TRX estimate, in the client's price.
  price_buffer_bps          integer NOT NULL CHECK (price_buffer_bps BETWEEN 0 AND 10000),
  -- Transfers held beyond the main one for a client selling USDT (its USDT may have to go back).
  refund_sends_sell         smallint NOT NULL CHECK (refund_sends_sell BETWEEN 0 AND 3),
  -- A quote must leave at least this much after the trader's reward and the network fee.
  min_net_margin_inr_minor  bigint NOT NULL CHECK (min_net_margin_inr_minor >= 0),
  max_snapshot_age_seconds  integer NOT NULL CHECK (max_snapshot_age_seconds BETWEEN 60 AND 604800),
  max_trx_rate_age_seconds  integer NOT NULL CHECK (max_trx_rate_age_seconds BETWEEN 60 AND 2592000),
  -- The signer's switch: off, nothing is signed (what is already broadcast is still followed to its end).
  auto_send_enabled         boolean NOT NULL,
  reason                    text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  set_by                    text NOT NULL,
  set_at                    timestamptz NOT NULL DEFAULT inrp2p_now(),
  CHECK (reserve_energy >= quote_energy)
);
CREATE INDEX network_fee_policy_current_idx ON network_fee_policy (set_at DESC, id DESC);
CREATE TRIGGER network_fee_policy_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON network_fee_policy
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();
INSERT INTO network_fee_policy (quote_energy, reserve_energy, bandwidth_buffer_sun, topup_bytes, topup_buffer_bps, price_buffer_bps, refund_sends_sell,
                                min_net_margin_inr_minor, max_snapshot_age_seconds, max_trx_rate_age_seconds, auto_send_enabled, reason, set_by)
VALUES (131000, 160000, 400000, 300, 1000, 1000, 1, 1, 86400, 259200, true, 'defaults of migration 0037 (ADR 0017)', 'migration 0037');

-- What the chain charges, read from its parameters by the worker (append-only; the latest within its age is used).
CREATE TABLE network_fee_snapshot (
  id                         uuid PRIMARY KEY DEFAULT uuidv7(),
  network                    text NOT NULL DEFAULT 'TRON' CHECK (network = 'TRON'),
  energy_price_sun           bigint NOT NULL CHECK (energy_price_sun BETWEEN 1 AND 100000),
  bandwidth_price_sun        bigint NOT NULL CHECK (bandwidth_price_sun BETWEEN 1 AND 100000),
  create_account_fee_sun     bigint NOT NULL CHECK (create_account_fee_sun BETWEEN 0 AND 100000000),
  create_new_account_fee_sun bigint NOT NULL CHECK (create_new_account_fee_sun BETWEEN 0 AND 100000000),
  free_net_limit             integer NOT NULL CHECK (free_net_limit >= 0),
  providers                  text NOT NULL CHECK (length(providers) BETWEEN 1 AND 300),
  observed_by                text NOT NULL,
  observed_at                timestamptz NOT NULL DEFAULT inrp2p_now()
);
CREATE INDEX network_fee_snapshot_current_idx ON network_fee_snapshot (observed_at DESC, id DESC);
CREATE TRIGGER network_fee_snapshot_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON network_fee_snapshot
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- What one TRX is worth in USDT (6 decimals), published by the desk (append-only).
CREATE TABLE network_trx_rate (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  usdt_per_trx_micro bigint NOT NULL CHECK (usdt_per_trx_micro BETWEEN 1 AND 1000000000),
  source             text NOT NULL CHECK (length(btrim(source)) BETWEEN 2 AND 200),
  published_by       text NOT NULL,
  effective_at       timestamptz NOT NULL DEFAULT inrp2p_now()
);
CREATE INDEX network_trx_rate_current_idx ON network_trx_rate (effective_at DESC, id DESC);
CREATE TRIGGER network_trx_rate_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON network_trx_rate
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- A quote's network fee, the reward it carries and what is left, frozen when the quote is created (FI-90).
CREATE TABLE quote_network_fee (
  quote_id               uuid PRIMARY KEY REFERENCES quote (id),
  -- Whose TRX budget the trade will draw on: the trader of the route, or the platform (NULL).
  funder_trader_id       uuid REFERENCES trader_profile (id),
  snapshot_id            uuid NOT NULL REFERENCES network_fee_snapshot (id),
  trx_rate_id            uuid NOT NULL REFERENCES network_trx_rate (id),
  usdt_per_trx_micro     bigint NOT NULL CHECK (usdt_per_trx_micro > 0),
  energy_price_sun       bigint NOT NULL CHECK (energy_price_sun > 0),
  sends_priced           smallint NOT NULL CHECK (sends_priced BETWEEN 0 AND 3),
  -- The TRX the client's price covers, with its buffer, and its INR value at the quote's own rate (rounded up).
  fee_sun                bigint NOT NULL CHECK (fee_sun >= 0),
  fee_inr_minor          bigint NOT NULL CHECK (fee_inr_minor >= 0),
  reward_inr_minor       bigint NOT NULL CHECK (reward_inr_minor >= 0),
  net_margin_inr_minor   bigint NOT NULL,
  -- What the trade holds of its funder's budget from acceptance on.
  reserve_sends          smallint NOT NULL CHECK (reserve_sends BETWEEN 1 AND 5),
  reserve_sun            bigint NOT NULL CHECK (reserve_sun > 0),
  min_net_margin_inr_minor bigint NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT inrp2p_now()
);
CREATE TRIGGER quote_network_fee_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON quote_network_fee
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- FI-90: the net margin is derived, never input — the quote's gross margin less the reward and the network fee.
CREATE FUNCTION inrp2p_guard_quote_network_fee() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  q record;
BEGIN
  SELECT status, gross_margin_inr_minor INTO q FROM quote WHERE id = NEW.quote_id;
  IF q.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'the network fee of quote % is fixed when it is created', NEW.quote_id USING ERRCODE = 'IX103';
  END IF;
  IF NEW.net_margin_inr_minor <> q.gross_margin_inr_minor - NEW.reward_inr_minor - NEW.fee_inr_minor THEN
    RAISE EXCEPTION 'net margin of quote % must equal gross margin less reward less network fee', NEW.quote_id USING ERRCODE = 'IX103';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER quote_network_fee_insert BEFORE INSERT ON quote_network_fee
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_quote_network_fee();

-- ---------------------------------------------------------------------------------------------------------------
-- 3. The budget
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE network_budget_hold (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  trade_id     uuid NOT NULL UNIQUE REFERENCES trade (id),
  trader_id    uuid REFERENCES trader_profile (id),
  amount_sun   bigint NOT NULL CHECK (amount_sun > 0),
  sends        smallint NOT NULL CHECK (sends BETWEEN 1 AND 5),
  per_send_sun bigint NOT NULL CHECK (per_send_sun > 0),
  snapshot_id  uuid NOT NULL REFERENCES network_fee_snapshot (id),
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED')),
  created_at   timestamptz NOT NULL DEFAULT inrp2p_now(),
  closed_at    timestamptz,
  close_reason text CHECK (length(close_reason) <= 500),
  -- On closing: what the trade spent of the funder's TRX, what of it the trader is paid back and in INR.
  spent_sun          bigint CHECK (spent_sun >= 0),
  reimbursed_sun     bigint CHECK (reimbursed_sun >= 0),
  reimbursed_inr_minor bigint CHECK (reimbursed_inr_minor >= 0),
  CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL AND spent_sun IS NOT NULL)),
  CHECK (trader_id IS NOT NULL OR coalesce(reimbursed_sun, 0) = 0)
);
CREATE INDEX network_budget_hold_funder_idx ON network_budget_hold (trader_id) WHERE status = 'ACTIVE';
CREATE TRIGGER network_budget_hold_status BEFORE UPDATE ON network_budget_hold
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'ACTIVE>CLOSED');
CREATE TRIGGER network_budget_hold_immutable BEFORE UPDATE ON network_budget_hold
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'closed_at', 'close_reason', 'spent_sun', 'reimbursed_sun', 'reimbursed_inr_minor');
CREATE TRIGGER network_budget_hold_no_delete BEFORE DELETE OR TRUNCATE ON network_budget_hold
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

CREATE SEQUENCE network_deposit_withdrawal_ref_seq;
CREATE TABLE network_deposit_withdrawal (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  ref              text NOT NULL UNIQUE DEFAULT ('NW-' || inrp2p_ref_number(nextval('network_deposit_withdrawal_ref_seq'), 6)),
  trader_id        uuid NOT NULL REFERENCES trader_profile (id),
  amount_sun       bigint NOT NULL CHECK (amount_sun > 0),
  -- The withdrawal's own transaction fee, paid from the trader's deposit.
  fee_estimate_sun bigint NOT NULL CHECK (fee_estimate_sun >= 0),
  to_address       inrp2p_tron_address NOT NULL,
  status           text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'APPROVED', 'COMPLETED', 'REJECTED', 'CANCELLED')),
  requested_by     uuid NOT NULL REFERENCES auth_user (id),
  requested_at     timestamptz NOT NULL DEFAULT inrp2p_now(),
  decided_by       text,
  decided_at       timestamptz,
  closed_at        timestamptz,
  close_reason     text CHECK (length(close_reason) <= 500),
  CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
  CHECK (status IN ('REQUESTED', 'CANCELLED') OR decided_by IS NOT NULL),
  CHECK ((status IN ('COMPLETED', 'REJECTED', 'CANCELLED')) = (closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX network_deposit_withdrawal_one_open ON network_deposit_withdrawal (trader_id) WHERE status IN ('REQUESTED', 'APPROVED');
CREATE TRIGGER network_deposit_withdrawal_status BEFORE UPDATE ON network_deposit_withdrawal
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'REQUESTED>APPROVED,REQUESTED>REJECTED,REQUESTED>CANCELLED,APPROVED>COMPLETED,APPROVED>CANCELLED');
CREATE TRIGGER network_deposit_withdrawal_immutable BEFORE UPDATE ON network_deposit_withdrawal
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'decided_by', 'decided_at', 'closed_at', 'close_reason');
CREATE TRIGGER network_deposit_withdrawal_no_delete BEFORE DELETE OR TRUNCATE ON network_deposit_withdrawal
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Sends
-- ---------------------------------------------------------------------------------------------------------------
CREATE SEQUENCE chain_send_ref_seq;
CREATE TABLE chain_send (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  ref                 text NOT NULL UNIQUE DEFAULT ('CS-' || inrp2p_ref_number(nextval('chain_send_ref_seq'), 6)),
  network             text NOT NULL DEFAULT 'TRON' CHECK (network = 'TRON'),
  asset               text NOT NULL CHECK (asset IN ('USDT', 'TRX')),
  purpose             text NOT NULL CHECK (purpose IN ('CLIENT_PAYOUT', 'REFUND', 'ROUTE_PAYMENT', 'TOPUP', 'DEPOSIT_WITHDRAWAL')),
  trade_id            uuid REFERENCES trade (id),
  settlement_leg_id   uuid REFERENCES settlement_leg (id),
  route_obligation_id uuid REFERENCES route_obligation (id),
  parent_send_id      uuid REFERENCES chain_send (id),
  withdrawal_id       uuid REFERENCES network_deposit_withdrawal (id),
  from_address        inrp2p_tron_address NOT NULL,
  -- Where the signer finds the key: a BIP-44 path of the custody HD account. Never key material.
  from_path           text NOT NULL CHECK (from_path ~ '^m(/[0-9]+''?){5}$'),
  to_address          inrp2p_tron_address NOT NULL,
  -- USDT micro-units or TRX sun.
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  -- A TRX transfer's own fee, at most (top-ups and withdrawals): what the budget holds for it until it is final.
  fee_estimate_sun    bigint NOT NULL DEFAULT 0 CHECK (fee_estimate_sun >= 0),
  -- Whose TRX pays the network (NULL: the platform's), and who bears the cost in the end.
  funder_trader_id    uuid REFERENCES trader_profile (id),
  bearer              text NOT NULL CHECK (bearer IN ('CLIENT', 'TRADER', 'PLATFORM')),
  status              text NOT NULL CHECK (status IN ('AWAITING_APPROVAL', 'PLANNED', 'AWAITING_RESOURCES', 'BLOCKED', 'SENDING', 'CONFIRMED', 'CANCELLED')),
  needs_approval      boolean NOT NULL,
  requested_by        text NOT NULL,
  approved_by         text,
  approved_at         timestamptz,
  blocked_reason      text CHECK (length(blocked_reason) <= 500),
  last_error          text CHECK (length(last_error) <= 500),
  last_error_at       timestamptz,
  failed_attempts     smallint NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  crypto_transfer_id  uuid REFERENCES crypto_transfer (id),
  created_at          timestamptz NOT NULL DEFAULT inrp2p_now(),
  updated_at          timestamptz NOT NULL DEFAULT inrp2p_now(),
  closed_at           timestamptz,
  close_reason        text CHECK (length(close_reason) <= 500),
  CHECK ((purpose IN ('CLIENT_PAYOUT', 'REFUND')) = (settlement_leg_id IS NOT NULL)),
  CHECK ((purpose = 'ROUTE_PAYMENT') = (route_obligation_id IS NOT NULL)),
  CHECK ((purpose = 'TOPUP') = (parent_send_id IS NOT NULL)),
  CHECK ((purpose = 'DEPOSIT_WITHDRAWAL') = (withdrawal_id IS NOT NULL)),
  CHECK ((purpose IN ('TOPUP', 'DEPOSIT_WITHDRAWAL')) = (asset = 'TRX')),
  CHECK (purpose = 'DEPOSIT_WITHDRAWAL' OR trade_id IS NOT NULL),
  CHECK (asset = 'USDT' OR crypto_transfer_id IS NULL),
  CHECK ((status IN ('CONFIRMED', 'CANCELLED')) = (closed_at IS NOT NULL)),
  CHECK ((status = 'CANCELLED') = (close_reason IS NOT NULL)),
  CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CHECK (NOT needs_approval OR status IN ('AWAITING_APPROVAL', 'CANCELLED') OR approved_by IS NOT NULL),
  CHECK ((status = 'BLOCKED') = (blocked_reason IS NOT NULL))
);
-- A leg is paid by one send; one live route payment per obligation; one live top-up per send; one send per withdrawal.
CREATE UNIQUE INDEX chain_send_one_per_leg ON chain_send (settlement_leg_id) WHERE settlement_leg_id IS NOT NULL AND status <> 'CANCELLED';
CREATE UNIQUE INDEX chain_send_one_live_route_payment ON chain_send (route_obligation_id) WHERE purpose = 'ROUTE_PAYMENT' AND status NOT IN ('CONFIRMED', 'CANCELLED');
CREATE UNIQUE INDEX chain_send_one_live_topup ON chain_send (parent_send_id) WHERE purpose = 'TOPUP' AND status NOT IN ('CONFIRMED', 'CANCELLED');
CREATE UNIQUE INDEX chain_send_one_per_withdrawal ON chain_send (withdrawal_id) WHERE withdrawal_id IS NOT NULL AND status <> 'CANCELLED';
CREATE INDEX chain_send_open_idx ON chain_send (status, updated_at) WHERE status NOT IN ('CONFIRMED', 'CANCELLED');
CREATE INDEX chain_send_trade_idx ON chain_send (trade_id);
CREATE INDEX chain_send_from_idx ON chain_send (from_address) WHERE status NOT IN ('CONFIRMED', 'CANCELLED');
CREATE TRIGGER chain_send_status BEFORE UPDATE ON chain_send
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status',
    'AWAITING_APPROVAL>PLANNED,AWAITING_APPROVAL>CANCELLED,PLANNED>AWAITING_RESOURCES,PLANNED>SENDING,PLANNED>BLOCKED,PLANNED>CANCELLED,'
    'AWAITING_RESOURCES>PLANNED,AWAITING_RESOURCES>BLOCKED,AWAITING_RESOURCES>CANCELLED,BLOCKED>PLANNED,BLOCKED>CANCELLED,'
    'SENDING>CONFIRMED,SENDING>PLANNED,SENDING>BLOCKED');
CREATE TRIGGER chain_send_immutable BEFORE UPDATE ON chain_send
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'approved_by', 'approved_at', 'blocked_reason', 'last_error', 'last_error_at',
    'failed_attempts', 'crypto_transfer_id', 'updated_at', 'closed_at', 'close_reason');
CREATE TRIGGER chain_send_no_delete BEFORE DELETE OR TRUNCATE ON chain_send
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

CREATE TABLE chain_send_attempt (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  send_id               uuid NOT NULL REFERENCES chain_send (id),
  seq                   smallint NOT NULL CHECK (seq > 0),
  txid                  text NOT NULL UNIQUE CHECK (txid ~ '^[0-9a-f]{64}$'),
  -- The signed transaction, kept before it is broadcast: a retry sends exactly these bytes again.
  raw_data_hex          text NOT NULL CHECK (raw_data_hex ~ '^([0-9a-f][0-9a-f])+$' AND length(raw_data_hex) BETWEEN 40 AND 8000),
  signature_hex         text NOT NULL CHECK (signature_hex ~ '^[0-9a-f]{130}$'),
  ref_block_num         bigint NOT NULL CHECK (ref_block_num > 0),
  expiration            timestamptz NOT NULL,
  fee_limit_sun         bigint CHECK (fee_limit_sun > 0),
  status                text NOT NULL DEFAULT 'SIGNED' CHECK (status IN ('SIGNED', 'BROADCAST', 'CONFIRMED', 'FAILED', 'EXPIRED')),
  broadcasts            integer NOT NULL DEFAULT 0 CHECK (broadcasts >= 0),
  last_broadcast_at     timestamptz,
  last_broadcast_result text CHECK (length(last_broadcast_result) <= 500),
  block_number          bigint CHECK (block_number > 0),
  block_time            timestamptz,
  -- From the solidified receipt: TRX burned in all, and its parts.
  fee_sun               bigint CHECK (fee_sun >= 0),
  energy_used           bigint CHECK (energy_used >= 0),
  energy_fee_sun        bigint CHECK (energy_fee_sun >= 0),
  net_fee_sun           bigint CHECK (net_fee_sun >= 0),
  result                text CHECK (length(result) <= 60),
  signed_at             timestamptz NOT NULL DEFAULT inrp2p_now(),
  decided_at            timestamptz,
  decided_by            text CHECK (length(decided_by) <= 300),
  UNIQUE (send_id, seq),
  CHECK ((status IN ('CONFIRMED', 'FAILED', 'EXPIRED')) = (decided_at IS NOT NULL AND decided_by IS NOT NULL)),
  CHECK ((status IN ('CONFIRMED', 'FAILED')) = (block_number IS NOT NULL AND fee_sun IS NOT NULL AND result IS NOT NULL))
);
-- The exactly-once rule: at most one attempt of a send that could still land, or did.
CREATE UNIQUE INDEX chain_send_attempt_one_live ON chain_send_attempt (send_id) WHERE status IN ('SIGNED', 'BROADCAST', 'CONFIRMED');
CREATE INDEX chain_send_attempt_open_idx ON chain_send_attempt (status) WHERE status IN ('SIGNED', 'BROADCAST');
CREATE TRIGGER chain_send_attempt_status BEFORE UPDATE ON chain_send_attempt
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status',
    'SIGNED>BROADCAST,SIGNED>CONFIRMED,SIGNED>FAILED,SIGNED>EXPIRED,BROADCAST>CONFIRMED,BROADCAST>FAILED,BROADCAST>EXPIRED');
CREATE TRIGGER chain_send_attempt_immutable BEFORE UPDATE ON chain_send_attempt
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'broadcasts', 'last_broadcast_at', 'last_broadcast_result', 'block_number', 'block_time',
    'fee_sun', 'energy_used', 'energy_fee_sun', 'net_fee_sun', 'result', 'decided_at', 'decided_by');
CREATE TRIGGER chain_send_attempt_no_delete BEFORE DELETE OR TRUNCATE ON chain_send_attempt
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- IX104: an attempt is signed only for a send that is sending, after every earlier one is provably dead.
CREATE FUNCTION inrp2p_guard_chain_send_attempt_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s record;
BEGIN
  SELECT status, network FROM chain_send WHERE id = NEW.send_id FOR UPDATE INTO s;
  IF NOT FOUND OR s.status <> 'SENDING' THEN
    RAISE EXCEPTION 'send % is not sending (%): no transaction is signed for it', NEW.send_id, s.status USING ERRCODE = 'IX104';
  END IF;
  IF NEW.status <> 'SIGNED' THEN
    RAISE EXCEPTION 'an attempt starts SIGNED' USING ERRCODE = 'IX104';
  END IF;
  IF EXISTS (SELECT 1 FROM chain_send_attempt WHERE send_id = NEW.send_id AND status NOT IN ('EXPIRED', 'FAILED')) THEN
    RAISE EXCEPTION 'send % already has a transaction that may land; a second one is never signed', NEW.send_id USING ERRCODE = 'IX104';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER chain_send_attempt_insert BEFORE INSERT ON chain_send_attempt
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_chain_send_attempt_insert();

-- IX105: a send leaves SENDING only by its attempt's outcome — confirmed by a confirmed attempt, back to planning
-- (or blocked) only when no attempt of it can still land. CANCELLED is reachable only from a state with no attempt.
CREATE FUNCTION inrp2p_guard_chain_send_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  live integer;
  confirmed integer;
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  SELECT count(*) FILTER (WHERE status IN ('SIGNED', 'BROADCAST')), count(*) FILTER (WHERE status = 'CONFIRMED')
    INTO live, confirmed FROM chain_send_attempt WHERE send_id = NEW.id;
  IF NEW.status = 'CONFIRMED' AND confirmed <> 1 THEN
    RAISE EXCEPTION 'send % is confirmed only by its confirmed transaction', NEW.id USING ERRCODE = 'IX105';
  END IF;
  IF NEW.status IN ('PLANNED', 'BLOCKED', 'CANCELLED') AND (live > 0 OR confirmed > 0) THEN
    RAISE EXCEPTION 'send % has a transaction that may still land (or did): it cannot be % until that is decided', NEW.id, NEW.status USING ERRCODE = 'IX105';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER chain_send_update BEFORE UPDATE ON chain_send
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_chain_send_update();

-- IX106: a send pays only its own business — a payout leg's own destination, a refund leg's own, the trader's
-- registered wallet (or the desk route's address) for a route payment — from the place the leg or the money is.
CREATE FUNCTION inrp2p_guard_chain_send_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  l record;
  o record;
  parent record;
  expected_to text;
  expected_from text;
  expected_path text;
BEGIN
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
  ELSIF NEW.purpose = 'TOPUP' THEN
    SELECT from_address, trade_id, asset INTO parent FROM chain_send WHERE id = NEW.parent_send_id;
    IF parent.asset <> 'USDT' OR parent.trade_id IS DISTINCT FROM NEW.trade_id THEN
      RAISE EXCEPTION 'a top-up fuels a USDT send of its own trade' USING ERRCODE = 'IX106';
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
  RETURN NEW;
END
$$;
CREATE TRIGGER chain_send_insert BEFORE INSERT ON chain_send
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_chain_send_insert();

-- ---------------------------------------------------------------------------------------------------------------
-- 3b. The budget's ledger and what is free in it
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE network_budget_entry (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  -- The funder: a trader's network deposit, or the platform's own budget (NULL).
  trader_id             uuid REFERENCES trader_profile (id),
  kind                  text NOT NULL CHECK (kind IN ('DEPOSIT', 'WITHDRAWAL', 'SPENT', 'ADJUSTMENT')),
  -- TRX sun, signed: what the funder's budget gains (+) or loses (−).
  amount_sun            bigint NOT NULL CHECK (amount_sun <> 0),
  trade_id              uuid REFERENCES trade (id),
  chain_send_attempt_id uuid REFERENCES chain_send_attempt (id),
  withdrawal_id         uuid REFERENCES network_deposit_withdrawal (id),
  -- DEPOSIT: the incoming transaction and who sent it.
  tx_hash               text CHECK (tx_hash ~ '^[0-9a-f]{64}$'),
  from_address          inrp2p_tron_address,
  -- One entry per fact: `trx_deposit:{txid}`, `send_fee:{attempt}`, `withdrawal:{id}`, …
  posting_key           text NOT NULL UNIQUE CHECK (posting_key ~ '^[a-z][a-z_]*:[0-9a-z-]+$'),
  note                  text CHECK (length(note) <= 500),
  created_by            text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT inrp2p_now(),
  CHECK (kind <> 'DEPOSIT' OR (amount_sun > 0 AND tx_hash IS NOT NULL AND from_address IS NOT NULL)),
  CHECK (kind NOT IN ('WITHDRAWAL', 'SPENT') OR amount_sun < 0),
  CHECK (kind <> 'SPENT' OR (trade_id IS NOT NULL AND chain_send_attempt_id IS NOT NULL)),
  CHECK (kind <> 'WITHDRAWAL' OR (withdrawal_id IS NOT NULL AND chain_send_attempt_id IS NOT NULL AND trader_id IS NOT NULL)),
  CHECK (kind <> 'ADJUSTMENT' OR note IS NOT NULL)
);
CREATE UNIQUE INDEX network_budget_entry_one_deposit ON network_budget_entry (tx_hash) WHERE kind = 'DEPOSIT';
CREATE INDEX network_budget_entry_funder_idx ON network_budget_entry (trader_id);
CREATE INDEX network_budget_entry_trade_idx ON network_budget_entry (trade_id) WHERE trade_id IS NOT NULL;
CREATE TRIGGER network_budget_entry_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON network_budget_entry
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- IX107: a trader's deposit is the trader's only when its registered wallet sent it (the rule of D-17).
CREATE FUNCTION inrp2p_guard_network_budget_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'DEPOSIT' AND NEW.trader_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM trader_profile t JOIN crypto_wallet w ON w.id = t.wallet_id
     WHERE t.id = NEW.trader_id AND w.network = 'TRON' AND w.address = NEW.from_address AND w.status IN ('ACTIVE', 'PENDING_REVIEW')
  ) THEN
    RAISE EXCEPTION 'TRX deposit %: credited only to a trader whose registered wallet sent it', NEW.tx_hash USING ERRCODE = 'IX107';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER network_budget_entry_insert BEFORE INSERT ON network_budget_entry
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_network_budget_entry();

-- What a funder can still commit: its balance, less what its open trades still hold, less top-ups and withdrawals
-- under way (FI-91). A top-up for a trade first uses that trade's hold; beyond it, the funder's free TRX.
CREATE FUNCTION inrp2p_network_available(p_trader uuid) RETURNS bigint
LANGUAGE sql STABLE AS $$
  WITH spent AS (
    SELECT trade_id, -sum(amount_sun) AS amt FROM network_budget_entry
     WHERE kind = 'SPENT' AND trader_id IS NOT DISTINCT FROM p_trader GROUP BY trade_id
  ), pending AS (
    SELECT trade_id, sum(amount_minor + fee_estimate_sun) AS amt FROM chain_send
     WHERE purpose = 'TOPUP' AND status NOT IN ('CONFIRMED', 'CANCELLED') AND funder_trader_id IS NOT DISTINCT FROM p_trader GROUP BY trade_id
  )
  SELECT coalesce((SELECT sum(amount_sun) FROM network_budget_entry WHERE trader_id IS NOT DISTINCT FROM p_trader), 0)
       - coalesce((SELECT sum(greatest(h.amount_sun - coalesce(s.amt, 0) - coalesce(p.amt, 0), 0))
                     FROM network_budget_hold h LEFT JOIN spent s ON s.trade_id = h.trade_id LEFT JOIN pending p ON p.trade_id = h.trade_id
                    WHERE h.status = 'ACTIVE' AND h.trader_id IS NOT DISTINCT FROM p_trader), 0)
       - coalesce((SELECT sum(amt) FROM pending), 0)
       - coalesce((SELECT sum(amount_sun + fee_estimate_sun) FROM network_deposit_withdrawal
                    WHERE p_trader IS NOT NULL AND trader_id = p_trader AND status IN ('REQUESTED', 'APPROVED')), 0)
$$;

-- IX108 (FI-91): a hold, a top-up or a withdrawal never takes the funder below zero. Checked at commit under the
-- funder's lock, so two commitments racing for its last TRX are checked one after the other.
CREATE FUNCTION inrp2p_check_network_budget() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  funder uuid;
  available bigint;
BEGIN
  IF TG_TABLE_NAME = 'network_budget_hold' THEN
    IF NEW.status <> 'ACTIVE' THEN RETURN NULL; END IF;
    funder := NEW.trader_id;
  ELSIF TG_TABLE_NAME = 'chain_send' THEN
    IF NEW.purpose <> 'TOPUP' OR NEW.status IN ('CONFIRMED', 'CANCELLED') THEN RETURN NULL; END IF;
    funder := NEW.funder_trader_id;
  ELSE
    IF NEW.status NOT IN ('REQUESTED', 'APPROVED') THEN RETURN NULL; END IF;
    funder := NEW.trader_id;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('inrp2p.network_budget:' || coalesce(funder::text, 'platform')));
  SELECT inrp2p_network_available(funder) INTO available;
  IF available < 0 THEN
    RAISE EXCEPTION 'the network budget of % is short by % sun', coalesce(funder::text, 'the platform'), -available USING ERRCODE = 'IX108';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER network_budget_hold_covered AFTER INSERT ON network_budget_hold
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inrp2p_check_network_budget();
CREATE CONSTRAINT TRIGGER chain_send_topup_covered AFTER INSERT ON chain_send
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inrp2p_check_network_budget();
CREATE CONSTRAINT TRIGGER network_deposit_withdrawal_covered AFTER INSERT ON network_deposit_withdrawal
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inrp2p_check_network_budget();

-- IX109: a top-up and a withdrawal draw on their own funder (the trade's hold's, or the withdrawing trader's).
CREATE FUNCTION inrp2p_guard_chain_send_funder() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  hold_funder uuid;
  hold_found boolean;
BEGIN
  IF NEW.purpose = 'DEPOSIT_WITHDRAWAL' THEN
    IF NEW.funder_trader_id IS DISTINCT FROM (SELECT trader_id FROM network_deposit_withdrawal WHERE id = NEW.withdrawal_id) THEN
      RAISE EXCEPTION 'a withdrawal is paid from the withdrawing trader''s own deposit' USING ERRCODE = 'IX109';
    END IF;
    RETURN NEW;
  END IF;
  SELECT trader_id, true INTO hold_funder, hold_found FROM network_budget_hold WHERE trade_id = NEW.trade_id;
  IF NOT coalesce(hold_found, false) OR hold_funder IS DISTINCT FROM NEW.funder_trader_id THEN
    RAISE EXCEPTION 'send % of trade % must draw on the budget its trade holds', NEW.purpose, NEW.trade_id USING ERRCODE = 'IX109';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER chain_send_funder BEFORE INSERT ON chain_send
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_chain_send_funder();

-- ---------------------------------------------------------------------------------------------------------------
-- 5. A route payment the signer makes, earmarked when planned
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE route_settlement ADD COLUMN chain_send_id uuid UNIQUE REFERENCES chain_send (id);
ALTER TABLE funding_allocation ADD COLUMN use_chain_send_id uuid REFERENCES chain_send (id);
CREATE INDEX funding_allocation_use_send_idx ON funding_allocation (use_chain_send_id) WHERE use_chain_send_id IS NOT NULL;

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conrelid = 'funding_allocation'::regclass AND contype = 'c'
              AND (pg_get_constraintdef(oid) LIKE '%use_kind = ''ROUTE_PAYMENT''%use_route_settlement_id IS NOT NULL%'
                   OR pg_get_constraintdef(oid) LIKE '%''CLIENT_PAYOUT''%''REFUND''%use_leg_id IS NOT NULL%use_route_settlement_id IS NULL%')
  LOOP
    EXECUTE format('ALTER TABLE funding_allocation DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;
ALTER TABLE funding_allocation ADD CONSTRAINT funding_allocation_leg_use_check
  CHECK ((use_kind IN ('CLIENT_PAYOUT', 'REFUND')) = (use_leg_id IS NOT NULL AND use_route_settlement_id IS NULL AND use_chain_send_id IS NULL));
ALTER TABLE funding_allocation ADD CONSTRAINT funding_allocation_route_use_check
  CHECK ((use_kind = 'ROUTE_PAYMENT') = (use_leg_id IS NULL AND ((use_route_settlement_id IS NOT NULL) <> (use_chain_send_id IS NOT NULL))));

-- The insert guard of 0025, which also knows a planned route payment: same trade, USDT, from its sending address.
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
    SELECT s.trade_id, s.asset, s.purpose = 'ROUTE_PAYMENT', 'TRON:' || s.from_address::text
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

-- The coverage check of 0025, which also covers a planned route payment, and counts a route settlement the signer
-- made by the earmarks of its send.
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
    IF NEW.purpose <> 'ROUTE_PAYMENT' THEN RETURN NULL; END IF;
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
           s.purpose = 'ROUTE_PAYMENT'
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
CREATE CONSTRAINT TRIGGER chain_send_funding_coverage AFTER INSERT OR UPDATE ON chain_send
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inrp2p_check_funding_coverage();

-- IX110: a route settlement the signer made is that send's transfer: same obligation, amount and transaction.
CREATE FUNCTION inrp2p_guard_route_settlement_send() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s record;
BEGIN
  IF NEW.chain_send_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT purpose, route_obligation_id, amount_minor, crypto_transfer_id, status INTO s FROM chain_send WHERE id = NEW.chain_send_id;
  IF s.purpose <> 'ROUTE_PAYMENT' OR s.route_obligation_id <> NEW.route_obligation_id OR s.amount_minor <> NEW.amount_minor
     OR NEW.flow <> 'TO_ROUTE' OR s.crypto_transfer_id IS DISTINCT FROM NEW.crypto_transfer_id THEN
    RAISE EXCEPTION 'route settlement does not match send %', NEW.chain_send_id USING ERRCODE = 'IX110';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER route_settlement_chain_send BEFORE INSERT ON route_settlement
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_route_settlement_send();

-- ---------------------------------------------------------------------------------------------------------------
-- 6. Cases, and what a refund of a planned route payment's money would collide with
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE exception_case DROP CONSTRAINT exception_case_type_check;
ALTER TABLE exception_case ADD CONSTRAINT exception_case_type_check CHECK (type IN (
  'USDT_WRONG_AMOUNT', 'USDT_OVERPAYMENT', 'USDT_UNEXPECTED_SENDER', 'WRONG_NETWORK', 'TX_NOT_FINAL',
  'ROUTE_DIRECT_PAYOUT_MISMATCH', 'FUNDS_AFTER_TRADE_CLOSED', 'UNALLOCATED_DEPOSIT', 'DEPOSIT_POOL_LOW',
  'ROUTE_SETTLEMENT_MISMATCH', 'ROUTE_OBLIGATION_OVERDUE', 'DUPLICATE_TX_HASH', 'DUPLICATE_UTR',
  'PARTIAL_INR_PAYOUT', 'INR_PAYOUT_DELAYED', 'BANK_TRANSFER_FAILED', 'CLIENT_BANK_CHANGED',
  'ROUTE_CAPACITY_CHANGED', 'TRADE_CANCELLATION', 'OPERATOR_MISTAKE', 'RECONCILIATION_MISMATCH',
  'CHAIN_SEND_UNRESOLVED', 'NETWORK_BUDGET_SHORT'));
ALTER TABLE exception_case DROP CONSTRAINT exception_case_subject_type_check;
ALTER TABLE exception_case ADD CONSTRAINT exception_case_subject_type_check CHECK (subject_type IN (
  'TRADE', 'SETTLEMENT_LEG', 'FIAT_TRANSFER', 'CRYPTO_TRANSFER', 'DEPOSIT_ADDRESS', 'ROUTE_OBLIGATION', 'ROUTE_SETTLEMENT', 'INR_ACCOUNT', 'CLIENT',
  'CHAIN_SEND'));

-- IX111: a leg the signer pays is never also paid by hand — its evidence is the signer's transaction, and nobody
-- records another one against it.
CREATE FUNCTION inrp2p_guard_signed_leg_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.dimension = 'CLIENT' AND NEW.settlement_leg_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM chain_send s WHERE s.settlement_leg_id = NEW.settlement_leg_id AND s.status <> 'CANCELLED'
       AND s.crypto_transfer_id IS DISTINCT FROM NEW.crypto_transfer_id
  ) THEN
    RAISE EXCEPTION 'leg % is paid by the signer; its evidence is the signer''s own transaction', NEW.settlement_leg_id USING ERRCODE = 'IX111';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER transfer_allocation_signed_leg BEFORE INSERT ON transfer_allocation
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_signed_leg_evidence();

-- IX112: what a confirmed send recorded is its own transaction: the movement's tx is the confirmed attempt's txid.
CREATE FUNCTION inrp2p_guard_chain_send_transfer() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.crypto_transfer_id IS NOT NULL AND NEW.crypto_transfer_id IS DISTINCT FROM OLD.crypto_transfer_id AND NOT EXISTS (
    SELECT 1 FROM crypto_transfer c JOIN chain_send_attempt a ON a.txid = c.tx_hash
     WHERE c.id = NEW.crypto_transfer_id AND a.send_id = NEW.id AND a.status = 'CONFIRMED'
       AND c.from_address = NEW.from_address AND c.to_address = NEW.to_address AND c.amount_minor = NEW.amount_minor
  ) THEN
    RAISE EXCEPTION 'send % records only its own confirmed transaction', NEW.id USING ERRCODE = 'IX112';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER chain_send_transfer BEFORE UPDATE OF crypto_transfer_id ON chain_send
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_chain_send_transfer();

-- IX090 restated (0027): above the threshold the sender does not confirm a payout, and the system never does — unless
-- the payout was the signer's, approved before it was signed by someone other than its sender, and the chain made it
-- final. Then two people stood behind it (the sender and the approver) before any money moved, and the chain is the
-- only evidence that settles a USDT movement (FI-24).
CREATE OR REPLACE FUNCTION inrp2p_guard_payout_people() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  signed_by_approval boolean;
BEGIN
  IF NEW.side <> 'EXCHANGE_TO_CLIENT' THEN
    RETURN NEW;
  END IF;
  IF OLD.sent_by IS NOT NULL AND NEW.sent_by IS DISTINCT FROM OLD.sent_by THEN
    RAISE EXCEPTION 'payout % was sent by %; that does not change', NEW.ref, OLD.sent_by USING ERRCODE = 'IX090';
  END IF;
  IF OLD.confirmed_by IS NOT NULL AND NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by THEN
    RAISE EXCEPTION 'payout % was confirmed by %; that does not change', NEW.ref, OLD.confirmed_by USING ERRCODE = 'IX090';
  END IF;
  IF OLD.status = 'PENDING' AND NEW.status = 'PROCESSING' AND NEW.sent_by IS NULL THEN
    RAISE EXCEPTION 'payout % is sent by someone, and the record says who', NEW.ref USING ERRCODE = 'IX090';
  END IF;
  IF NEW.status = 'COMPLETED' AND OLD.status <> 'COMPLETED' THEN
    IF NEW.confirmed_by IS NULL THEN
      RAISE EXCEPTION 'payout % is confirmed by someone, and the record says who', NEW.ref USING ERRCODE = 'IX090';
    END IF;
    IF inrp2p_payout_needs_second_person(NEW.trade_id, NEW.asset, NEW.amount_minor) THEN
      SELECT EXISTS (
        SELECT 1 FROM chain_send s
         WHERE s.settlement_leg_id = NEW.id AND s.status = 'CONFIRMED' AND s.approved_by IS NOT NULL
           AND s.approved_by <> coalesce(NEW.sent_by, NEW.created_by) AND s.approved_by NOT LIKE 'SYSTEM%'
      ) INTO signed_by_approval;
      IF NEW.confirmed_by LIKE 'SYSTEM%' AND NOT signed_by_approval THEN
        RAISE EXCEPTION 'payout % is above the approval threshold: a person confirms it, not the system', NEW.ref USING ERRCODE = 'IX090';
      END IF;
      IF NEW.confirmed_by = coalesce(NEW.sent_by, NEW.created_by) THEN
        RAISE EXCEPTION 'payout % is above the approval threshold: the person who sent it does not confirm it', NEW.ref USING ERRCODE = 'IX090';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON custody_hd_account, network_fee_policy, network_fee_snapshot, network_trx_rate, quote_network_fee, network_budget_entry TO inrp2p_app;
GRANT SELECT, INSERT ON network_budget_hold, network_deposit_withdrawal, chain_send, chain_send_attempt TO inrp2p_app;
GRANT UPDATE (status, closed_at, close_reason, spent_sun, reimbursed_sun, reimbursed_inr_minor) ON network_budget_hold TO inrp2p_app;
GRANT UPDATE (status, decided_by, decided_at, closed_at, close_reason) ON network_deposit_withdrawal TO inrp2p_app;
GRANT UPDATE (status, approved_by, approved_at, blocked_reason, last_error, last_error_at, failed_attempts, crypto_transfer_id, updated_at, closed_at, close_reason) ON chain_send TO inrp2p_app;
GRANT UPDATE (status, broadcasts, last_broadcast_at, last_broadcast_result, block_number, block_time, fee_sun, energy_used, energy_fee_sun, net_fee_sun, result, decided_at, decided_by) ON chain_send_attempt TO inrp2p_app;
GRANT SELECT ON custody_hd_account, network_fee_policy, network_fee_snapshot, network_trx_rate, quote_network_fee, network_budget_entry,
               network_budget_hold, network_deposit_withdrawal, chain_send, chain_send_attempt TO inrp2p_readonly;
GRANT USAGE ON SEQUENCE custody_derivation_index_seq, chain_send_ref_seq, network_deposit_withdrawal_ref_seq TO inrp2p_app;
GRANT EXECUTE ON FUNCTION inrp2p_network_available(uuid) TO inrp2p_app, inrp2p_readonly;
