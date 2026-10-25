-- 0041 Network fees in USDT: deal addresses as GasFree accounts (docs/adr/0022-usdt-network-fees.md).
--
-- A new P2P deal's escrow is the GasFree account of one of the exchange's HD keys: its USDT leaves by a permit the key signs
-- (TIP-712), and the network of each transfer is paid in USDT out of that same account, in the same transaction. Nobody
-- prepays a network — no trader deposit, no platform float.
--
-- 1. The network policy says what new deals are priced and issued on: `BURN` (TRX deposits, ADR 0017 — what production
--    keeps after this migration) or `GASFREE`. A person switches; the setter refuses until GasFree's fees were read.
-- 2. `gasfree_fee_reading`: what the controller charges per transfer and per activation, read from the chain.
-- 3. A P2P quote prices its network in USDT and says who carries it (`network_fee_base_minor`, IX125 / IX045): a desk's
--    deal in the desk's USDT side, INRP2P's own deal out of its margin. `quote_network_fee` freezes the fees (IX103).
-- 4. A USDT trade's network hold is that allowance, settled at cost when the trade is done.
-- 5. `deposit_address.owner_address`: the key that owns a GasFree account issued as a deal address.
-- 6. A send from a GasFree account carries a USDT fee cap (its permits' `maxFee`); only a person raises it (IX131).
-- 7. `gasfree_permit`: one signed permit of a send, committed before GasFree ever sees it; never two live for a send or an
--    owner, never past the cap (IX131); decided once (IX132).
-- 8. The network of each GasFree send is earmarked from the trade's own USDT at the address (`NETWORK_FEE`), consumed at
--    what the controller charged (IX133).
-- 9. A cancelled buy's escrow goes back less its return's network; INRP2P sweeps a completed trade's margin less the
--    network its transfers paid.
--
-- Error codes IX131–IX133 belong to this migration. 0001–0040 are not edited.


-- 1. The network policy ----------------------------------------------------------------------------------------------

ALTER TABLE network_fee_policy
  ADD COLUMN resource_mode text NOT NULL DEFAULT 'BURN' CHECK (resource_mode IN ('BURN', 'GASFREE')),
  -- How old GasFree's fee reading may be for a quote to be priced on it.
  ADD COLUMN gasfree_fee_max_age_seconds integer NOT NULL DEFAULT 3600 CHECK (gasfree_fee_max_age_seconds BETWEEN 300 AND 86400);


-- 2. What GasFree charges --------------------------------------------------------------------------------------------

-- One reading of the controller's fees for USDT, in micro-USDT (append-only; the latest within the policy's age is used).
CREATE TABLE gasfree_fee_reading (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  controller text NOT NULL,
  token text NOT NULL,
  transfer_fee_minor bigint NOT NULL CHECK (transfer_fee_minor >= 0 AND transfer_fee_minor <= 100000000),
  activate_fee_minor bigint NOT NULL CHECK (activate_fee_minor >= 0 AND activate_fee_minor <= 100000000),
  observed_at timestamptz NOT NULL DEFAULT inrp2p_now(),
  observed_by text NOT NULL
);
CREATE INDEX gasfree_fee_reading_latest_idx ON gasfree_fee_reading (observed_at DESC, id DESC);
CREATE TRIGGER gasfree_fee_reading_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON gasfree_fee_reading
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();


-- 3. Who carries a P2P deal's network --------------------------------------------------------------------------------

-- The USDT of the deal's network allowance its escrow carries: in a desk's USDT side (`route_base` = base ± fee ± it), or
-- out of INRP2P's own USDT margin. Part of the gross USDT margin until the trade's network is settled.
ALTER TABLE quote
  ADD COLUMN network_fee_base_minor bigint CHECK (network_fee_base_minor >= 0),
  ADD CONSTRAINT quote_network_fee_base_shape CHECK (network_fee_base_minor IS NULL
    OR (gross_margin_base_minor IS NOT NULL AND network_fee_base_minor <= gross_margin_base_minor));
ALTER TABLE trade_economics
  ADD COLUMN network_fee_base_minor bigint CHECK (network_fee_base_minor >= 0),
  ADD CONSTRAINT trade_economics_network_fee_base_shape CHECK (network_fee_base_minor IS NULL
    OR (gross_margin_base_minor IS NOT NULL AND network_fee_base_minor <= gross_margin_base_minor));

-- IX125 (FI-99, FI-101): a desk deal's whole margin is the platform's fee plus the network allowance its USDT side carries.
CREATE OR REPLACE FUNCTION inrp2p_guard_desk_quote() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  req_desk uuid;
  desk_trader uuid;
  rt record;
BEGIN
  SELECT desk_id INTO req_desk FROM trade_request WHERE id = NEW.trade_request_id;
  IF req_desk IS NULL THEN
    IF NEW.platform_fee_bps IS NOT NULL THEN
      RAISE EXCEPTION 'quote % is not a desk deal: it carries no platform fee', NEW.ref USING ERRCODE = 'IX125';
    END IF;
    RETURN NEW;
  END IF;
  SELECT trader_id INTO desk_trader FROM desk WHERE id = req_desk;
  SELECT trader_id, execution_mode INTO rt FROM liquidity_route WHERE id = NEW.route_id;
  IF rt.trader_id IS DISTINCT FROM desk_trader OR rt.execution_mode IS DISTINCT FROM 'P2P' THEN
    RAISE EXCEPTION 'a desk deal runs on the desk''s own P2P route' USING ERRCODE = 'IX125';
  END IF;
  IF NEW.platform_fee_bps IS DISTINCT FROM inrp2p_platform_fee_bps() THEN
    RAISE EXCEPTION 'a desk deal is charged the current fee policy''s % bps', inrp2p_platform_fee_bps() USING ERRCODE = 'IX125';
  END IF;
  IF NEW.platform_fee_base_minor IS DISTINCT FROM (NEW.base_minor * NEW.platform_fee_bps + 9999) / 10000
     OR NEW.gross_margin_base_minor IS DISTINCT FROM NEW.platform_fee_base_minor + coalesce(NEW.network_fee_base_minor, 0)
     OR NEW.route_rate_micro <> NEW.client_rate_micro THEN
    RAISE EXCEPTION 'desk deal % must be priced at the desk''s rate with the platform''s fee and its network allowance as its whole margin', NEW.ref
      USING ERRCODE = 'IX125';
  END IF;
  RETURN NEW;
END
$$;

-- IX045: copied values equal the accepted quote exactly — the network allowance included.
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
     OR q.route_base_minor IS DISTINCT FROM NEW.route_base_minor OR q.gross_margin_base_minor IS DISTINCT FROM NEW.gross_margin_base_minor
     OR q.platform_fee_bps IS DISTINCT FROM NEW.platform_fee_bps OR q.platform_fee_base_minor IS DISTINCT FROM NEW.platform_fee_base_minor
     OR q.network_fee_base_minor IS DISTINCT FROM NEW.network_fee_base_minor THEN
    RAISE EXCEPTION 'trade economics for % do not equal the accepted quote', NEW.trade_id USING ERRCODE = 'IX045';
  END IF;
  RETURN NEW;
END
$$;

-- The network terms a quote freezes: in TRX as before (unit TRX), or GasFree's fees in USDT (unit USDT).
ALTER TABLE quote_network_fee
  ADD COLUMN unit text NOT NULL DEFAULT 'TRX' CHECK (unit IN ('TRX', 'USDT')),
  ADD COLUMN gasfree_fee_reading_id uuid REFERENCES gasfree_fee_reading (id),
  ADD COLUMN transfer_fee_usdt_minor bigint CHECK (transfer_fee_usdt_minor >= 0),
  ADD COLUMN activate_fee_usdt_minor bigint CHECK (activate_fee_usdt_minor >= 0),
  ADD CONSTRAINT quote_network_fee_usdt_terms CHECK ((unit = 'USDT') = (gasfree_fee_reading_id IS NOT NULL
    AND transfer_fee_usdt_minor IS NOT NULL AND activate_fee_usdt_minor IS NOT NULL AND fee_usdt_minor IS NOT NULL)),
  -- The deal's own path: the payout (activating the account) and the sweep of INRP2P's fee.
  ADD CONSTRAINT quote_network_fee_usdt_path CHECK (unit <> 'USDT' OR fee_usdt_minor = activate_fee_usdt_minor + 2 * transfer_fee_usdt_minor);
-- USDT terms owe nothing to TRX: no fee snapshot, no TRX price, no TRX reserve.
ALTER TABLE quote_network_fee ALTER COLUMN snapshot_id DROP NOT NULL, ALTER COLUMN trx_rate_id DROP NOT NULL, ALTER COLUMN usdt_per_trx_micro DROP NOT NULL,
  ALTER COLUMN energy_price_sun DROP NOT NULL, ALTER COLUMN reserve_sun DROP NOT NULL;
ALTER TABLE quote_network_fee ADD CONSTRAINT quote_network_fee_trx_terms CHECK ((unit = 'TRX') = (snapshot_id IS NOT NULL AND trx_rate_id IS NOT NULL
  AND usdt_per_trx_micro IS NOT NULL AND energy_price_sun IS NOT NULL AND reserve_sun IS NOT NULL));

-- IX103 (FI-90, FI-100): what a quote leaves is derived, never input. A USDT-priced P2P quote is carried by whoever owns
-- the client — a desk's deal by the desk (funder = the desk's trader), INRP2P's own deal by INRP2P (funder NULL, out of
-- its margin) — and its net margin is the gross USDT margin less the allowance.
CREATE OR REPLACE FUNCTION inrp2p_guard_quote_network_fee() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  q record;
  o record;
  desk_trader uuid;
BEGIN
  SELECT status, gross_margin_inr_minor, gross_margin_base_minor, network_fee_base_minor, route_id, trade_request_id INTO q FROM quote WHERE id = NEW.quote_id;
  IF q.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'the network fee of quote % is fixed when it is created', NEW.quote_id USING ERRCODE = 'IX103';
  END IF;
  IF NEW.unit = 'USDT' THEN
    SELECT d.trader_id INTO desk_trader FROM trade_request r JOIN desk d ON d.id = r.desk_id WHERE r.id = q.trade_request_id;
    IF q.gross_margin_base_minor IS NULL OR q.network_fee_base_minor IS DISTINCT FROM NEW.fee_usdt_minor
       OR NEW.net_margin_usdt_minor IS DISTINCT FROM q.gross_margin_base_minor - NEW.fee_usdt_minor
       OR coalesce(NEW.reward_bps, 0) <> 0 OR NEW.reward_inr_minor <> 0
       OR NEW.funder_trader_id IS DISTINCT FROM desk_trader THEN
      RAISE EXCEPTION 'USDT network terms of quote % must be carried by whoever owns the client, out of its USDT side', NEW.quote_id USING ERRCODE = 'IX103';
    END IF;
  ELSIF q.network_fee_base_minor IS NOT NULL THEN
    RAISE EXCEPTION 'quote % carries a USDT network allowance: its terms are in USDT', NEW.quote_id USING ERRCODE = 'IX103';
  ELSIF q.gross_margin_base_minor IS NOT NULL THEN
    IF NEW.fee_usdt_minor IS NULL OR NEW.net_margin_usdt_minor <> q.gross_margin_base_minor
       OR coalesce(NEW.reward_bps, 0) <> 0 OR NEW.reward_inr_minor <> 0
       OR NEW.funder_trader_id IS DISTINCT FROM (SELECT trader_id FROM liquidity_route WHERE id = q.route_id) THEN
      RAISE EXCEPTION 'P2P quote % is funded by its route''s trader: its net margin is its USDT margin, with no reward', NEW.quote_id USING ERRCODE = 'IX103';
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


-- 4. A trade's network hold in USDT -----------------------------------------------------------------------------------

ALTER TABLE network_budget_hold
  ADD COLUMN unit text NOT NULL DEFAULT 'TRX' CHECK (unit IN ('TRX', 'USDT')),
  -- The allowance the deal's escrow carries; on closing, what its transfers' network took of it and what was left.
  ADD COLUMN deal_funded_usdt_minor bigint CHECK (deal_funded_usdt_minor >= 0),
  ADD COLUMN spent_usdt_minor bigint CHECK (spent_usdt_minor >= 0),
  ADD COLUMN unused_usdt_minor bigint CHECK (unused_usdt_minor >= 0);
ALTER TABLE network_budget_hold ALTER COLUMN amount_sun DROP NOT NULL, ALTER COLUMN per_send_sun DROP NOT NULL, ALTER COLUMN snapshot_id DROP NOT NULL;
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'network_budget_hold'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%closed_at IS NOT NULL%spent_sun IS NOT NULL%'
  LOOP
    EXECUTE format('ALTER TABLE network_budget_hold DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;
ALTER TABLE network_budget_hold
  ADD CONSTRAINT network_budget_hold_unit_shape CHECK (
    (unit = 'TRX' AND amount_sun IS NOT NULL AND per_send_sun IS NOT NULL AND snapshot_id IS NOT NULL AND deal_funded_usdt_minor IS NULL)
    OR (unit = 'USDT' AND amount_sun IS NULL AND per_send_sun IS NULL AND deal_funded_usdt_minor IS NOT NULL AND coalesce(reimbursed_sun, 0) = 0)),
  ADD CONSTRAINT network_budget_hold_closed CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL
    AND CASE unit WHEN 'TRX' THEN spent_sun IS NOT NULL ELSE spent_usdt_minor IS NOT NULL AND unused_usdt_minor IS NOT NULL END)),
  -- What a rise of the fees past the quote took beyond the allowance is INRP2P's (ADR 0022 §2.3), never a negative remainder.
  ADD CONSTRAINT network_budget_hold_settled CHECK (unused_usdt_minor IS NULL OR unused_usdt_minor = greatest(deal_funded_usdt_minor - spent_usdt_minor, 0));

DROP TRIGGER network_budget_hold_immutable ON network_budget_hold;
CREATE TRIGGER network_budget_hold_immutable BEFORE UPDATE ON network_budget_hold
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'closed_at', 'close_reason', 'spent_sun', 'reimbursed_sun', 'reimbursed_inr_minor', 'amount_sun',
    'spent_usdt_minor', 'unused_usdt_minor');

-- The TRX budget counts TRX holds only.
CREATE OR REPLACE FUNCTION inrp2p_network_available(p_trader uuid) RETURNS bigint
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
                    WHERE h.status = 'ACTIVE' AND h.unit = 'TRX' AND h.trader_id IS NOT DISTINCT FROM p_trader), 0)
       - coalesce((SELECT sum(amt) FROM pending), 0)
       - coalesce((SELECT sum(amount_sun + fee_estimate_sun) FROM network_deposit_withdrawal
                    WHERE p_trader IS NOT NULL AND trader_id = p_trader AND status IN ('REQUESTED', 'APPROVED')), 0)
$$;

-- IX108 (FI-91) stays a TRX rule: a USDT hold takes nothing of anyone's budget.
CREATE OR REPLACE FUNCTION inrp2p_check_network_budget() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  funder uuid;
  available bigint;
BEGIN
  IF TG_TABLE_NAME = 'network_budget_hold' THEN
    IF NEW.status <> 'ACTIVE' OR NEW.unit <> 'TRX' THEN RETURN NULL; END IF;
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


-- 5. Deal addresses that are GasFree accounts ------------------------------------------------------------------------

-- The HD key that owns a GasFree account issued as a deal address (ADR 0022 §2.1): `address` is the account, the key at
-- `custody_reference` signs its permits. A plain HD address has none.
ALTER TABLE deposit_address
  ADD COLUMN owner_address text CHECK (owner_address IS NULL OR source = 'DERIVED');
CREATE UNIQUE INDEX deposit_address_owner_unique ON deposit_address (owner_address) WHERE owner_address IS NOT NULL;
CREATE TRIGGER deposit_address_owner_immutable BEFORE UPDATE OF owner_address ON deposit_address
  FOR EACH ROW EXECUTE FUNCTION inrp2p_reject_mutation();


-- A client's USDT refunded out of a GasFree account goes back less that refund's own network (ADR 0022 §2.3): the leg pays
-- what reaches the client; `network_fee_minor` is what its transfer leaves for the network — together, what is returned.
ALTER TABLE settlement_leg ADD COLUMN network_fee_minor bigint CHECK (network_fee_minor > 0),
  ADD CONSTRAINT settlement_leg_network_fee_shape CHECK (network_fee_minor IS NULL OR (side = 'REFUND_TO_CLIENT' AND asset = 'USDT' AND source_deposit_address_id IS NOT NULL));


-- 6. A GasFree send's fee cap ----------------------------------------------------------------------------------------

-- A USDT send leaves a GasFree account with a USDT fee cap — its permits' `maxFee` — or a plain HD address with a TRX cap:
-- never both, always one for USDT.
ALTER TABLE chain_send ADD COLUMN fee_cap_usdt_minor bigint CHECK (fee_cap_usdt_minor > 0);
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'chain_send'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%(asset = ''USDT''::text) = (network_cap_sun IS NOT NULL)%'
  LOOP
    EXECUTE format('ALTER TABLE chain_send DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;
ALTER TABLE chain_send ADD CONSTRAINT chain_send_cap_unit CHECK (
  CASE WHEN asset = 'USDT' THEN num_nonnulls(network_cap_sun, fee_cap_usdt_minor) = 1
       ELSE network_cap_sun IS NULL AND fee_cap_usdt_minor IS NULL END);
DROP TRIGGER chain_send_immutable ON chain_send;
CREATE TRIGGER chain_send_immutable BEFORE UPDATE ON chain_send
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'approved_by', 'approved_at', 'blocked_reason', 'last_error', 'last_error_at',
    'failed_attempts', 'crypto_transfer_id', 'updated_at', 'closed_at', 'close_reason', 'network_cap_sun', 'fee_cap_usdt_minor');

-- The GasFree account a send leaves, if it leaves one: its owner.
CREATE FUNCTION inrp2p_gasfree_owner(p_address text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT owner_address FROM deposit_address WHERE network = 'TRON' AND address = p_address AND owner_address IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION inrp2p_guard_chain_send_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  live integer;
  confirmed integer;
  held bigint;
BEGIN
  IF NEW.network_cap_sun IS DISTINCT FROM OLD.network_cap_sun THEN
    IF NEW.network_cap_sun < OLD.network_cap_sun THEN
      RAISE EXCEPTION 'the TRX cap of send % only rises', NEW.ref USING ERRCODE = 'IX115';
    END IF;
    IF inrp2p_payouts_held() THEN
      RAISE EXCEPTION 'outgoing payments are held until the restore fence is lifted: no cap is raised' USING ERRCODE = 'IX100';
    END IF;
    SELECT amount_sun INTO held FROM network_budget_hold WHERE trade_id = NEW.trade_id AND status = 'ACTIVE' AND unit = 'TRX';
    IF held IS NULL OR inrp2p_trade_network_committed(NEW.trade_id, NEW.id) + greatest(NEW.network_cap_sun, inrp2p_send_network_used(NEW.id)) > held THEN
      RAISE EXCEPTION 'the TRX caps of trade % would exceed what it holds', NEW.trade_id USING ERRCODE = 'IX115';
    END IF;
  END IF;
  -- IX131: a GasFree send's fee cap only rises, by a person, while payments are open and no permit of it is live.
  IF NEW.fee_cap_usdt_minor IS DISTINCT FROM OLD.fee_cap_usdt_minor THEN
    IF OLD.fee_cap_usdt_minor IS NULL OR NEW.fee_cap_usdt_minor < OLD.fee_cap_usdt_minor THEN
      RAISE EXCEPTION 'the fee cap of send % only rises', NEW.ref USING ERRCODE = 'IX131';
    END IF;
    IF inrp2p_payouts_held() THEN
      RAISE EXCEPTION 'outgoing payments are held until the restore fence is lifted: no cap is raised' USING ERRCODE = 'IX100';
    END IF;
    IF EXISTS (SELECT 1 FROM gasfree_permit WHERE send_id = NEW.id AND status IN ('SIGNED', 'SUBMITTED')) THEN
      RAISE EXCEPTION 'send % has a permit that may still execute: its cap is raised once that is decided', NEW.ref USING ERRCODE = 'IX131';
    END IF;
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'AWAITING_APPROVAL' AND NEW.status = 'PLANNED' AND inrp2p_payouts_held() THEN
    RAISE EXCEPTION 'outgoing payments are held until the restore fence is lifted: send % is not approved', NEW.ref USING ERRCODE = 'IX100';
  END IF;
  SELECT count(*) FILTER (WHERE status IN ('SIGNED', 'BROADCAST')), count(*) FILTER (WHERE status = 'CONFIRMED')
    INTO live, confirmed FROM chain_send_attempt WHERE send_id = NEW.id;
  SELECT live + count(*) FILTER (WHERE status IN ('SIGNED', 'SUBMITTED')), confirmed + count(*) FILTER (WHERE status = 'CONFIRMED')
    INTO live, confirmed FROM gasfree_permit WHERE send_id = NEW.id;
  IF NEW.status = 'CONFIRMED' AND confirmed <> 1 THEN
    RAISE EXCEPTION 'send % is confirmed only by its confirmed transaction', NEW.id USING ERRCODE = 'IX105';
  END IF;
  IF NEW.status IN ('PLANNED', 'BLOCKED', 'CANCELLED') AND (live > 0 OR confirmed > 0) THEN
    RAISE EXCEPTION 'send % has a transaction that may still land (or did): it cannot be % until that is decided', NEW.id, NEW.status USING ERRCODE = 'IX105';
  END IF;
  RETURN NEW;
END
$$;

-- IX106: a send pays only its own business. Unchanged from 0040 but for GasFree: a send from a GasFree account carries a
-- fee cap and nothing else (no top-up, no TRX), a return leaves room for its own network, and TRX never leaves one.
CREATE OR REPLACE FUNCTION inrp2p_guard_chain_send_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  l record;
  o record;
  parent record;
  expected_to text;
  expected_from text;
  expected_path text;
  gasfree boolean;
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
  gasfree := inrp2p_gasfree_owner(NEW.from_address) IS NOT NULL;
  IF gasfree <> (NEW.fee_cap_usdt_minor IS NOT NULL) OR (gasfree AND NEW.asset <> 'USDT') THEN
    RAISE EXCEPTION 'a send from a GasFree account moves USDT with a fee cap; any other send has none' USING ERRCODE = 'IX106';
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
    -- at most what it delivered and nothing has used or returned, less the network of the return itself when it leaves a
    -- GasFree account (ADR 0022 §2.3), to its registered wallet and nowhere else.
    SELECT ro.trade_id, ro.status, ro.execution_mode, ro.route_delivers_asset, r.trader_id INTO o
      FROM route_obligation ro JOIN liquidity_route r ON r.id = ro.route_id WHERE ro.id = NEW.route_obligation_id;
    IF o.trade_id IS DISTINCT FROM NEW.trade_id OR o.status <> 'CANCELLED' OR o.execution_mode <> 'P2P' OR o.route_delivers_asset <> 'USDT'
       OR NEW.asset <> 'USDT' OR o.trader_id IS NULL OR NEW.amount_minor + coalesce(NEW.fee_cap_usdt_minor, 0) > inrp2p_escrow_returnable(NEW.route_obligation_id) THEN
      RAISE EXCEPTION 'send does not return the escrow of route obligation %', NEW.route_obligation_id USING ERRCODE = 'IX106';
    END IF;
    SELECT w.address::text INTO expected_to FROM trader_profile t JOIN crypto_wallet w ON w.id = t.wallet_id
     WHERE t.id = o.trader_id AND w.status = 'ACTIVE';
    expected_from := NEW.from_address;
  ELSIF NEW.purpose = 'FEE_SWEEP' THEN
    -- Block 10: INRP2P's earned USDT, off a deal address no trade is using now, to its revenue wallet and nowhere else.
    -- What it takes is earmarked from completed trades' own margins there (IX130) and covers the send exactly (IX086).
    IF NEW.asset <> 'USDT' OR EXISTS (SELECT 1 FROM deposit_address d WHERE d.network = 'TRON' AND d.address = NEW.from_address AND d.status = 'ASSIGNED') THEN
      RAISE EXCEPTION 'a fee sweep moves USDT off a deal address no trade is using' USING ERRCODE = 'IX106';
    END IF;
    expected_to := (SELECT w.address::text FROM treasury_wallet w WHERE w.role = 'REVENUE' AND w.status = 'ACTIVE');
    expected_from := NEW.from_address;
  ELSIF NEW.purpose = 'TRX_RECLAIM' THEN
    -- TD-31: the TRX a deal address's transfers did not burn, back to the budget wallet, once no trade uses the address.
    IF gasfree OR inrp2p_gasfree_owner(NEW.from_address) IS NOT NULL
       OR EXISTS (SELECT 1 FROM deposit_address d WHERE d.network = 'TRON' AND d.address = NEW.from_address AND d.status = 'ASSIGNED') THEN
      RAISE EXCEPTION 'TRX is reclaimed only from a plain deal address no trade is using' USING ERRCODE = 'IX106';
    END IF;
    expected_to := (SELECT w.address::text FROM treasury_wallet w WHERE w.role = 'NETWORK_BUDGET' AND w.status = 'ACTIVE');
    expected_from := NEW.from_address;
  ELSIF NEW.purpose = 'TOPUP' THEN
    SELECT from_address, trade_id, asset, network_cap_sun INTO parent FROM chain_send WHERE id = NEW.parent_send_id;
    -- A GasFree account is never topped up with TRX (ADR 0022 §2.1): only a TRX-capped send is.
    IF parent.asset <> 'USDT' OR parent.trade_id IS DISTINCT FROM NEW.trade_id OR parent.network_cap_sun IS NULL THEN
      RAISE EXCEPTION 'a top-up fuels a TRX-capped USDT send of its own trade' USING ERRCODE = 'IX106';
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
  -- The key is the one the custody HD account issued that address under (a GasFree account's owner's).
  expected_path := CASE WHEN NEW.asset = 'USDT' OR NEW.purpose = 'TRX_RECLAIM'
    THEN (SELECT d.custody_reference FROM deposit_address d JOIN custody_hd_account h ON h.provider = d.provider
           WHERE d.network = 'TRON' AND d.address = NEW.from_address AND d.source = 'DERIVED')
    ELSE (SELECT h.fee_wallet_path FROM custody_hd_account h WHERE h.fee_wallet_address = NEW.from_address) END;
  IF expected_path IS DISTINCT FROM NEW.from_path THEN
    RAISE EXCEPTION 'send % leaves % which the custody HD account did not issue under %', NEW.purpose, NEW.from_address, NEW.from_path USING ERRCODE = 'IX106';
  END IF;
  -- IX115: a trade's TRX-capped sends together never draw more than the trade holds; one that would not fit is not
  -- planned. A GasFree send's network is earmarked from the trade's own USDT instead (IX133).
  IF NEW.asset = 'USDT' AND NEW.purpose <> 'FEE_SWEEP' AND NEW.network_cap_sun IS NOT NULL
     AND inrp2p_trade_network_committed(NEW.trade_id, NULL) + NEW.network_cap_sun
         > coalesce((SELECT amount_sun FROM network_budget_hold WHERE trade_id = NEW.trade_id AND status = 'ACTIVE' AND unit = 'TRX'), 0) THEN
    RAISE EXCEPTION 'send % of trade % needs a TRX cap of % sun that its hold no longer has', NEW.purpose, NEW.trade_id, NEW.network_cap_sun USING ERRCODE = 'IX115';
  END IF;
  RETURN NEW;
END
$$;


-- 7. Permits ---------------------------------------------------------------------------------------------------------

-- One `PermitTransfer` the exchange signed for a send from a GasFree account (ADR 0022 §2.4): committed SIGNED before
-- GasFree sees it, SUBMITTED once GasFree took it (its trace id), CONFIRMED by the transaction that carried it — with what
-- the controller charged — or EXPIRED once the chain proves it can never execute (its deadline is behind every provider's
-- solidified head and its nonce was never used). Never two live for a send, nor for an owner.
CREATE TABLE gasfree_permit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  send_id uuid NOT NULL REFERENCES chain_send (id),
  seq integer NOT NULL CHECK (seq > 0),
  owner_address text NOT NULL,
  gasfree_address text NOT NULL,
  token text NOT NULL,
  service_provider text NOT NULL,
  receiver text NOT NULL,
  value_minor bigint NOT NULL CHECK (value_minor > 0),
  max_fee_minor bigint NOT NULL CHECK (max_fee_minor > 0),
  nonce bigint NOT NULL CHECK (nonce >= 0),
  deadline timestamptz NOT NULL,
  digest_hex text NOT NULL CHECK (digest_hex ~ '^[0-9a-f]{64}$'),
  signature_hex text NOT NULL CHECK (signature_hex ~ '^[0-9a-f]{130}$'),
  status text NOT NULL DEFAULT 'SIGNED' CHECK (status IN ('SIGNED', 'SUBMITTED', 'CONFIRMED', 'EXPIRED')),
  trace_id text,
  txid text CHECK (txid ~ '^[0-9a-f]{64}$'),
  -- What the controller charged, read from the transaction itself: its activation part and the whole.
  activate_fee_minor bigint CHECK (activate_fee_minor >= 0),
  fee_minor bigint CHECK (fee_minor >= 0),
  last_answer text,
  submitted_at timestamptz,
  signed_at timestamptz NOT NULL DEFAULT inrp2p_now(),
  decided_at timestamptz,
  decided_by text,
  UNIQUE (send_id, seq),
  UNIQUE (digest_hex),
  CONSTRAINT gasfree_permit_decided CHECK ((status IN ('CONFIRMED', 'EXPIRED')) = (decided_at IS NOT NULL AND decided_by IS NOT NULL)),
  CONSTRAINT gasfree_permit_confirmed CHECK ((status = 'CONFIRMED') = (fee_minor IS NOT NULL AND activate_fee_minor IS NOT NULL AND txid IS NOT NULL)),
  CONSTRAINT gasfree_permit_fee CHECK (fee_minor IS NULL OR (fee_minor <= max_fee_minor AND activate_fee_minor <= fee_minor))
);
CREATE UNIQUE INDEX gasfree_permit_one_live_per_send ON gasfree_permit (send_id) WHERE status IN ('SIGNED', 'SUBMITTED');
CREATE UNIQUE INDEX gasfree_permit_one_live_per_owner ON gasfree_permit (owner_address) WHERE status IN ('SIGNED', 'SUBMITTED');
CREATE UNIQUE INDEX gasfree_permit_txid ON gasfree_permit (txid) WHERE txid IS NOT NULL;
CREATE INDEX gasfree_permit_live_idx ON gasfree_permit (status, signed_at) WHERE status IN ('SIGNED', 'SUBMITTED');
CREATE TRIGGER gasfree_permit_status BEFORE UPDATE ON gasfree_permit
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'SIGNED>SUBMITTED,SIGNED>CONFIRMED,SIGNED>EXPIRED,SUBMITTED>CONFIRMED,SUBMITTED>EXPIRED');
CREATE TRIGGER gasfree_permit_immutable BEFORE UPDATE ON gasfree_permit
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'trace_id', 'txid', 'activate_fee_minor', 'fee_minor', 'last_answer', 'submitted_at',
    'decided_at', 'decided_by');
CREATE TRIGGER gasfree_permit_no_delete BEFORE DELETE OR TRUNCATE ON gasfree_permit
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- IX131 (FI-102): a permit is the send's own — its account, its owner, its receiver, its amount, within its cap — signed
-- while the send is sending, payments are open, and nothing else of the send or its owner may still execute.
CREATE FUNCTION inrp2p_guard_gasfree_permit_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s record;
BEGIN
  IF inrp2p_payouts_held() THEN
    RAISE EXCEPTION 'outgoing payments are held until the restore fence is lifted: no permit is signed' USING ERRCODE = 'IX100';
  END IF;
  SELECT status, from_address, to_address, amount_minor, fee_cap_usdt_minor INTO s FROM chain_send WHERE id = NEW.send_id FOR UPDATE;
  IF NOT FOUND OR s.status <> 'SENDING' OR s.fee_cap_usdt_minor IS NULL THEN
    RAISE EXCEPTION 'send % is not a GasFree send that is sending: no permit is signed for it', NEW.send_id USING ERRCODE = 'IX131';
  END IF;
  IF NEW.status <> 'SIGNED' OR NEW.trace_id IS NOT NULL OR NEW.txid IS NOT NULL OR NEW.fee_minor IS NOT NULL THEN
    RAISE EXCEPTION 'a permit starts SIGNED, untouched' USING ERRCODE = 'IX131';
  END IF;
  IF NEW.gasfree_address <> s.from_address OR NEW.owner_address IS DISTINCT FROM inrp2p_gasfree_owner(s.from_address)
     OR NEW.receiver <> s.to_address OR NEW.value_minor <> s.amount_minor OR NEW.max_fee_minor > s.fee_cap_usdt_minor THEN
    RAISE EXCEPTION 'permit for send % must pay its receiver its amount from its own account, within its fee cap', NEW.send_id USING ERRCODE = 'IX131';
  END IF;
  IF EXISTS (SELECT 1 FROM gasfree_permit WHERE (send_id = NEW.send_id OR owner_address = NEW.owner_address) AND status IN ('SIGNED', 'SUBMITTED'))
     OR EXISTS (SELECT 1 FROM gasfree_permit WHERE send_id = NEW.send_id AND status = 'CONFIRMED') THEN
    RAISE EXCEPTION 'send % (or its owner) already has a permit that may execute, or did', NEW.send_id USING ERRCODE = 'IX131';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER gasfree_permit_insert BEFORE INSERT ON gasfree_permit
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_gasfree_permit_insert();

-- IX132: what a permit did is recorded once — its trace once, its transaction once, its charge only when confirmed.
CREATE FUNCTION inrp2p_guard_gasfree_permit_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('CONFIRMED', 'EXPIRED') THEN
    RAISE EXCEPTION 'permit % of send % is decided', OLD.seq, OLD.send_id USING ERRCODE = 'IX132';
  END IF;
  IF (OLD.trace_id IS NOT NULL AND NEW.trace_id IS DISTINCT FROM OLD.trace_id) OR (OLD.txid IS NOT NULL AND NEW.txid IS DISTINCT FROM OLD.txid) THEN
    RAISE EXCEPTION 'permit % of send % already names its trace and transaction', OLD.seq, OLD.send_id USING ERRCODE = 'IX132';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER gasfree_permit_update BEFORE UPDATE ON gasfree_permit
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_gasfree_permit_update();

-- IX112 restated: what a confirmed send recorded is its own transaction — its confirmed attempt's, or the transaction its
-- confirmed permit executed in (ADR 0022).
CREATE OR REPLACE FUNCTION inrp2p_guard_chain_send_transfer() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.crypto_transfer_id IS NOT NULL AND NEW.crypto_transfer_id IS DISTINCT FROM OLD.crypto_transfer_id AND NOT EXISTS (
    SELECT 1 FROM crypto_transfer c
     WHERE c.id = NEW.crypto_transfer_id
       AND c.from_address = NEW.from_address AND c.to_address = NEW.to_address AND c.amount_minor = NEW.amount_minor
       AND (EXISTS (SELECT 1 FROM chain_send_attempt a WHERE a.txid = c.tx_hash AND a.send_id = NEW.id AND a.status = 'CONFIRMED')
            OR EXISTS (SELECT 1 FROM gasfree_permit p WHERE p.txid = c.tx_hash AND p.send_id = NEW.id AND p.status = 'CONFIRMED'))
  ) THEN
    RAISE EXCEPTION 'send % records only its own confirmed transaction', NEW.id USING ERRCODE = 'IX112';
  END IF;
  RETURN NEW;
END
$$;


-- 8. The network of a GasFree send, earmarked from the trade's own USDT ----------------------------------------------

ALTER TABLE funding_allocation DROP CONSTRAINT funding_allocation_use_kind_check;
ALTER TABLE funding_allocation ADD CONSTRAINT funding_allocation_use_kind_check
  CHECK (use_kind IN ('CLIENT_PAYOUT', 'REFUND', 'ROUTE_PAYMENT', 'ESCROW_RETURN', 'FEE_SWEEP', 'NETWORK_FEE'));
ALTER TABLE funding_allocation DROP CONSTRAINT funding_allocation_route_use_check;
ALTER TABLE funding_allocation ADD CONSTRAINT funding_allocation_route_use_check
  CHECK ((use_kind = 'ROUTE_PAYMENT') = (use_leg_id IS NULL AND use_kind NOT IN ('ESCROW_RETURN', 'FEE_SWEEP', 'NETWORK_FEE') AND ((use_route_settlement_id IS NOT NULL) <> (use_chain_send_id IS NOT NULL))));
ALTER TABLE funding_allocation ADD CONSTRAINT funding_allocation_network_fee_check
  CHECK (use_kind <> 'NETWORK_FEE' OR (use_chain_send_id IS NOT NULL AND use_leg_id IS NULL AND use_route_settlement_id IS NULL AND asset = 'USDT'));

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
    -- The network of a GasFree send is its own earmark (IX133), never part of what the send itself moves.
    IF NEW.use_kind = 'NETWORK_FEE' THEN RETURN NULL; END IF;
    u_leg := NEW.use_leg_id;
    u_rs := NEW.use_route_settlement_id;
    u_send := NEW.use_chain_send_id;
  ELSIF TG_TABLE_NAME = 'settlement_leg' THEN
    u_leg := NEW.id;
  ELSIF TG_TABLE_NAME = 'chain_send' THEN
    IF NEW.purpose NOT IN ('ROUTE_PAYMENT', 'ESCROW_RETURN', 'FEE_SWEEP') THEN RETURN NULL; END IF;
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
           s.purpose IN ('ROUTE_PAYMENT', 'ESCROW_RETURN', 'FEE_SWEEP')
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
   WHERE use_kind <> 'NETWORK_FEE' AND ((u_leg IS NOT NULL AND use_leg_id = u_leg)
      OR (u_send IS NOT NULL AND use_chain_send_id = u_send)
      OR (u_send IS NULL AND u_rs IS NOT NULL AND use_route_settlement_id = u_rs));

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
    -- The network of a GasFree send (ADR 0022) is earmarked like its amount: from its own trade's USDT at the address.
    SELECT s.trade_id, s.asset,
           (s.purpose = NEW.use_kind AND s.purpose IN ('ROUTE_PAYMENT', 'ESCROW_RETURN', 'FEE_SWEEP')) OR (NEW.use_kind = 'NETWORK_FEE' AND s.fee_cap_usdt_minor IS NOT NULL),
           'TRON:' || s.from_address::text
      INTO use_trade, use_asset, use_ok, use_location
      FROM chain_send s WHERE s.id = NEW.use_chain_send_id;
    -- A fee sweep gathers what several completed trades earned at one address: each earmark is its own trade's, and
    -- never more than that trade may give up (IX130).
    IF NEW.use_kind = 'FEE_SWEEP' THEN
      IF NEW.amount_minor > inrp2p_trade_sweepable(NEW.trade_id, NEW.location) THEN
        RAISE EXCEPTION 'trade % has not earned % of USDT at % to sweep', NEW.trade_id, NEW.amount_minor, NEW.location USING ERRCODE = 'IX130';
      END IF;
      use_trade := NEW.trade_id;
    END IF;
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

-- IX133 (FI-101): a live GasFree send of a counterparty-funded trade has its whole fee cap earmarked; a confirmed one
-- consumed exactly what the controller charged; a cancelled one holds nothing.
CREATE FUNCTION inrp2p_check_gasfree_fee_coverage() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  u_send uuid;
  s record;
  charged bigint;
  active_total bigint;
  consumed_total bigint;
BEGIN
  IF TG_TABLE_NAME = 'funding_allocation' THEN
    IF NEW.use_kind <> 'NETWORK_FEE' THEN RETURN NULL; END IF;
    u_send := NEW.use_chain_send_id;
  ELSIF TG_TABLE_NAME = 'gasfree_permit' THEN
    u_send := NEW.send_id;
  ELSE
    u_send := NEW.id;
  END IF;
  SELECT id, ref, trade_id, status, fee_cap_usdt_minor INTO s FROM chain_send WHERE id = u_send;
  IF s.fee_cap_usdt_minor IS NULL OR s.trade_id IS NULL OR NOT inrp2p_trade_is_counterparty_funded(s.trade_id) THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(sum(amount_minor) FILTER (WHERE status = 'ACTIVE'), 0), coalesce(sum(amount_minor) FILTER (WHERE status = 'CONSUMED'), 0)
    INTO active_total, consumed_total
    FROM funding_allocation WHERE use_chain_send_id = s.id AND use_kind = 'NETWORK_FEE';
  IF s.status = 'CONFIRMED' THEN
    SELECT fee_minor INTO charged FROM gasfree_permit WHERE send_id = s.id AND status = 'CONFIRMED';
    IF consumed_total <> coalesce(charged, -1) OR active_total <> 0 THEN
      RAISE EXCEPTION 'confirmed send % consumed % of its trade''s USDT for the network the controller charged %', s.ref, consumed_total, charged USING ERRCODE = 'IX133';
    END IF;
  ELSIF s.status = 'CANCELLED' THEN
    IF active_total <> 0 OR consumed_total <> 0 THEN
      RAISE EXCEPTION 'cancelled send % still holds its network earmark', s.ref USING ERRCODE = 'IX133';
    END IF;
  ELSIF active_total <> s.fee_cap_usdt_minor OR consumed_total <> 0 THEN
    RAISE EXCEPTION 'GasFree send % has % of its fee cap % earmarked', s.ref, active_total, s.fee_cap_usdt_minor USING ERRCODE = 'IX133';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER chain_send_gasfree_fee_coverage AFTER INSERT OR UPDATE ON chain_send
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inrp2p_check_gasfree_fee_coverage();
CREATE CONSTRAINT TRIGGER funding_allocation_gasfree_fee_coverage AFTER INSERT OR UPDATE ON funding_allocation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inrp2p_check_gasfree_fee_coverage();
CREATE CONSTRAINT TRIGGER gasfree_permit_fee_coverage AFTER INSERT OR UPDATE ON gasfree_permit
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inrp2p_check_gasfree_fee_coverage();


-- 9. Sweeps ----------------------------------------------------------------------------------------------------------

-- IX130 (ADR 0022 §2.3): what INRP2P may sweep of a completed trade at an address — its margin, less what of it is swept
-- or earmarked for a sweep, and less the network its GasFree transfers paid or will pay out of it. A desk's network
-- allowance is part of that margin: the payout's network and the sweep's own come out of it, and what is left is INRP2P's
-- fee. A cancelled trade leaves nothing to sweep: its USDT goes back, less its return's network.
CREATE OR REPLACE FUNCTION inrp2p_trade_sweepable(p_trade uuid, p_location text) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN t.lifecycle_state = 'COMPLETED'
                AND NOT EXISTS (SELECT 1 FROM route_obligation o WHERE o.trade_id = t.id AND o.status NOT IN ('SETTLED', 'CANCELLED'))
                AND NOT EXISTS (SELECT 1 FROM exception_case c WHERE c.trade_id = t.id AND c.status IN ('OPEN', 'IN_PROGRESS'))
              THEN greatest(least(
                coalesce((SELECT sum(s.amount_minor - coalesce((SELECT sum(a.amount_minor) FROM funding_allocation a
                                                                 WHERE (a.source_leg_id = s.source_id OR a.source_route_settlement_id = s.source_id)
                                                                   AND a.status IN ('ACTIVE', 'CONSUMED')), 0))
                            FROM funding_source s WHERE s.trade_id = t.id AND s.asset = 'USDT' AND s.location = p_location), 0),
                coalesce(e.gross_margin_base_minor, 0)
                  - coalesce((SELECT sum(a.amount_minor) FROM funding_allocation a
                               WHERE a.trade_id = t.id AND a.use_kind IN ('FEE_SWEEP', 'NETWORK_FEE') AND a.status IN ('ACTIVE', 'CONSUMED')), 0)), 0)
              ELSE 0 END
    FROM trade t LEFT JOIN trade_economics e ON e.trade_id = t.id
   WHERE t.id = p_trade
$$;


-- 10. Cases ----------------------------------------------------------------------------------------------------------

ALTER TABLE exception_case DROP CONSTRAINT exception_case_type_check;
ALTER TABLE exception_case ADD CONSTRAINT exception_case_type_check CHECK (type IN (
  'USDT_WRONG_AMOUNT', 'USDT_OVERPAYMENT', 'USDT_UNEXPECTED_SENDER', 'WRONG_NETWORK', 'TX_NOT_FINAL',
  'ROUTE_DIRECT_PAYOUT_MISMATCH', 'FUNDS_AFTER_TRADE_CLOSED', 'UNALLOCATED_DEPOSIT', 'DEPOSIT_POOL_LOW',
  'ROUTE_SETTLEMENT_MISMATCH', 'ROUTE_OBLIGATION_OVERDUE', 'DUPLICATE_TX_HASH', 'DUPLICATE_UTR',
  'PARTIAL_INR_PAYOUT', 'INR_PAYOUT_DELAYED', 'BANK_TRANSFER_FAILED', 'CLIENT_BANK_CHANGED',
  'ROUTE_CAPACITY_CHANGED', 'TRADE_CANCELLATION', 'OPERATOR_MISTAKE', 'RECONCILIATION_MISMATCH',
  'CHAIN_SEND_UNRESOLVED', 'NETWORK_BUDGET_SHORT', 'INR_UNEXPECTED_SENDER',
  'P2P_PAYMENT_OVERDUE', 'P2P_RECEIPT_OVERDUE', 'P2P_DISPUTE', 'GASFREE_UNAVAILABLE'));


-- Grants -------------------------------------------------------------------------------------------------------------

GRANT SELECT, INSERT ON gasfree_fee_reading, gasfree_permit TO inrp2p_app;
GRANT UPDATE (status, trace_id, txid, activate_fee_minor, fee_minor, last_answer, submitted_at, decided_at, decided_by) ON gasfree_permit TO inrp2p_app;
GRANT UPDATE (spent_usdt_minor, unused_usdt_minor) ON network_budget_hold TO inrp2p_app;
GRANT UPDATE (fee_cap_usdt_minor) ON chain_send TO inrp2p_app;
GRANT SELECT ON gasfree_fee_reading, gasfree_permit TO inrp2p_readonly;
GRANT SELECT (owner_address) ON deposit_address TO inrp2p_readonly;
GRANT SELECT (network_fee_minor) ON settlement_leg TO inrp2p_readonly;
GRANT SELECT (network_fee_base_minor) ON quote, trade_economics TO inrp2p_readonly;
GRANT SELECT (unit, gasfree_fee_reading_id, transfer_fee_usdt_minor, activate_fee_usdt_minor) ON quote_network_fee TO inrp2p_readonly;
GRANT SELECT (unit, deal_funded_usdt_minor, spent_usdt_minor, unused_usdt_minor) ON network_budget_hold TO inrp2p_readonly;
GRANT SELECT (fee_cap_usdt_minor) ON chain_send TO inrp2p_readonly;
GRANT EXECUTE ON FUNCTION inrp2p_gasfree_owner(text) TO inrp2p_app, inrp2p_readonly;
