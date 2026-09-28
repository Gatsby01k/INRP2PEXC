-- 0022 traders: clients who provide INR or USDT capacity, matched privately to client requests (docs/TRADERS.md).
--
-- A trader is not a new kind of counterparty. It is a client whose own registered bank account and TRC20 wallet
-- back one liquidity route per side it offers (DOMAIN_MODEL §2.4), so every order it fills is an ordinary quote,
-- trade, route obligation and route settlement, posted by the ledger rules that already exist. What this migration
-- adds is only what that model did not have:
--   - the operator-controlled programme settings (Security Reserve amount, reward rate, offer/hold timers);
--   - the trader's profile, its application and the operator's controls over it;
--   - the two capacity blocks (Buy USDT / Sell USDT) a trader edits, each tied to its route;
--   - the trader order: the private assignment of one client request to one trader, which holds capacity;
--   - the Security Reserve's withdrawals and the reward payouts (their deposits and accruals are ledger postings);
--   - deposit addresses assigned to a trader's reserve or to a trader delivery, so USDT is attributed by address
--     and never by amount or sender (D-02, FI-26).
-- Error codes IX070–IX079 belong to this migration.

-- ---------------------------------------------------------------------------------------------------------------
-- Programme settings: one row, changed only by an audited operator command.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE trader_program (
  id                             smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- USDT a trader must keep locked while providing liquidity. NULL until an operator sets it: nothing invents it.
  default_required_reserve_minor bigint CHECK (default_required_reserve_minor > 0),
  -- Reward INRP2P pays on a completed order, in basis points of the order's INR value. NULL = no reward is paid.
  reward_bps                     integer CHECK (reward_bps BETWEEN 0 AND 500),
  -- How long a trader has to accept an offer, and how long an accepted order holds capacity for the desk to quote.
  -- The hold never exceeds the route-snapshot age a quote may be sent on (QuotePolicy.maxSnapshotAgeSeconds).
  offer_ttl_seconds              integer NOT NULL DEFAULT 120 CHECK (offer_ttl_seconds BETWEEN 30 AND 900),
  hold_ttl_seconds               integer NOT NULL DEFAULT 900 CHECK (hold_ttl_seconds BETWEEN 60 AND 900),
  -- When on, a new USDT-fixed request is routed to an eligible trader as soon as it arrives.
  auto_assign                    boolean NOT NULL DEFAULT false,
  -- The exchange account traders pay INR into. NULL until configured; Buy USDT orders cannot be paid without it.
  collection_account_id          uuid REFERENCES inr_settlement_account (id),
  updated_by                     text NOT NULL,
  updated_at                     timestamptz NOT NULL DEFAULT statement_timestamp(),
  version                        integer NOT NULL DEFAULT 1
);
INSERT INTO trader_program (id, updated_by) VALUES (1, 'SYSTEM:migration');
CREATE TRIGGER trader_program_no_delete BEFORE DELETE OR TRUNCATE ON trader_program
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- Trader profile: the application, the operator's decision and controls, and the trader's own availability.
-- ---------------------------------------------------------------------------------------------------------------
CREATE SEQUENCE trader_ref_seq;
CREATE TABLE trader_profile (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  ref                     text NOT NULL UNIQUE DEFAULT ('TR-' || inrp2p_ref_number(nextval('trader_ref_seq'), 4)),
  client_id               uuid NOT NULL UNIQUE REFERENCES client (id),
  status                  text NOT NULL DEFAULT 'UNDER_REVIEW' CHECK (status IN ('UNDER_REVIEW', 'APPROVED', 'REJECTED', 'PAUSED')),
  offers_buy              boolean NOT NULL,
  offers_sell             boolean NOT NULL,
  typical_inr_minor       bigint CHECK (typical_inr_minor > 0),
  typical_usdt_minor      bigint CHECK (typical_usdt_minor > 0),
  -- The trader's own registered settlement details: a destination of this client, never a third party's.
  bank_account_id         uuid NOT NULL REFERENCES bank_account (id),
  wallet_id               uuid NOT NULL REFERENCES crypto_wallet (id),
  required_reserve_minor  bigint CHECK (required_reserve_minor > 0),
  reward_bps              integer CHECK (reward_bps BETWEEN 0 AND 500),
  max_order_inr_minor     bigint CHECK (max_order_inr_minor > 0),
  max_order_usdt_minor    bigint CHECK (max_order_usdt_minor > 0),
  max_capacity_inr_minor  bigint CHECK (max_capacity_inr_minor > 0),
  max_capacity_usdt_minor bigint CHECK (max_capacity_usdt_minor > 0),
  available               boolean NOT NULL DEFAULT false,
  assignments_enabled     boolean NOT NULL DEFAULT true,
  control_note            text CHECK (length(control_note) <= 500),
  applied_by              uuid NOT NULL REFERENCES auth_user (id),
  applied_at              timestamptz NOT NULL DEFAULT inrp2p_now(),
  reviewed_by             text,
  reviewed_at             timestamptz,
  review_note             text CHECK (length(review_note) <= 500),
  created_at              timestamptz NOT NULL DEFAULT inrp2p_now(),
  updated_at              timestamptz NOT NULL DEFAULT inrp2p_now(),
  version                 integer NOT NULL DEFAULT 1,
  CHECK (offers_buy OR offers_sell),
  CHECK (NOT offers_buy OR typical_inr_minor IS NOT NULL),
  CHECK (NOT offers_sell OR typical_usdt_minor IS NOT NULL),
  -- An approved trader has a reserve requirement: the operator set it, nothing defaulted it silently.
  CHECK (status NOT IN ('APPROVED', 'PAUSED') OR (required_reserve_minor IS NOT NULL AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)),
  -- Only an approved trader can be providing liquidity.
  CHECK (status = 'APPROVED' OR NOT available),
  CHECK (status <> 'REJECTED' OR review_note IS NOT NULL)
);
CREATE INDEX trader_profile_status_idx ON trader_profile (status);
CREATE TRIGGER trader_profile_status BEFORE UPDATE ON trader_profile
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'UNDER_REVIEW>APPROVED,UNDER_REVIEW>REJECTED,REJECTED>UNDER_REVIEW,APPROVED>PAUSED,PAUSED>APPROVED');
CREATE TRIGGER trader_profile_immutable BEFORE UPDATE ON trader_profile
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns(
    'status', 'offers_buy', 'offers_sell', 'typical_inr_minor', 'typical_usdt_minor', 'bank_account_id', 'wallet_id',
    'required_reserve_minor', 'reward_bps', 'max_order_inr_minor', 'max_order_usdt_minor', 'max_capacity_inr_minor',
    'max_capacity_usdt_minor', 'available', 'assignments_enabled', 'control_note', 'applied_by', 'applied_at',
    'reviewed_by', 'reviewed_at', 'review_note', 'updated_at', 'version');
CREATE TRIGGER trader_profile_no_delete BEFORE DELETE OR TRUNCATE ON trader_profile
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- The registered settlement details belong to the trader's own client (no third-party accounts).
CREATE FUNCTION inrp2p_guard_trader_destinations() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT client_id FROM bank_account WHERE id = NEW.bank_account_id) IS DISTINCT FROM NEW.client_id THEN
    RAISE EXCEPTION 'trader % bank account must be a registered account of the same client', NEW.id USING ERRCODE = 'IX070';
  END IF;
  IF (SELECT client_id FROM crypto_wallet WHERE id = NEW.wallet_id) IS DISTINCT FROM NEW.client_id THEN
    RAISE EXCEPTION 'trader % wallet must be a registered wallet of the same client', NEW.id USING ERRCODE = 'IX070';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trader_profile_destinations BEFORE INSERT OR UPDATE OF bank_account_id, wallet_id ON trader_profile
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_trader_destinations();

-- Where a trader's USDT is expected to come from: its registered wallet, while that wallet is active. Settlement reads
-- this to check the sender of a reserve deposit (a check, never an attribution — the address attributes).
CREATE FUNCTION inrp2p_trader_wallet_address(p_trader uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT w.address FROM trader_profile t JOIN crypto_wallet w ON w.id = t.wallet_id
  WHERE t.id = p_trader AND w.status = 'ACTIVE'
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Trader routes: a liquidity route per side, owned by the trader profile. Clients' destinations never reach a
-- trader, so a trader route always delivers to the exchange (TO_EXCHANGE, D-14), and serves exactly one direction.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE liquidity_route ADD COLUMN trader_id uuid REFERENCES trader_profile (id);
ALTER TABLE liquidity_route ADD CONSTRAINT liquidity_route_trader_shape
  CHECK (trader_id IS NULL OR (execution_mode = 'TO_EXCHANGE' AND direction <> 'BOTH'));
CREATE UNIQUE INDEX liquidity_route_trader_direction ON liquidity_route (trader_id, direction) WHERE trader_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------------------
-- Capacity blocks. Amounts are in the block's own currency: a Buy USDT block holds INR (paise), a Sell USDT block
-- holds USDT (micro-USDT). `reserved` is the sum of the block's open orders and is re-checked at commit.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE trader_block (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  trader_id       uuid NOT NULL REFERENCES trader_profile (id),
  side            text NOT NULL CHECK (side IN ('BUY_USDT', 'SELL_USDT')),
  route_id        uuid NOT NULL UNIQUE REFERENCES liquidity_route (id),
  capacity_minor  bigint NOT NULL DEFAULT 0 CHECK (capacity_minor >= 0),
  reserved_minor  bigint NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),
  rate_micro      bigint CHECK (rate_micro > 0),
  min_order_minor bigint CHECK (min_order_minor > 0),
  max_order_minor bigint CHECK (max_order_minor > 0),
  status          text NOT NULL DEFAULT 'PAUSED' CHECK (status IN ('ACTIVE', 'PAUSED')),
  created_at      timestamptz NOT NULL DEFAULT inrp2p_now(),
  updated_at      timestamptz NOT NULL DEFAULT inrp2p_now(),
  version         integer NOT NULL DEFAULT 1,
  UNIQUE (trader_id, side),
  CHECK (reserved_minor <= capacity_minor),
  CHECK (min_order_minor IS NULL OR max_order_minor IS NULL OR min_order_minor <= max_order_minor),
  CHECK (status = 'PAUSED' OR (rate_micro IS NOT NULL AND min_order_minor IS NOT NULL AND max_order_minor IS NOT NULL))
);
CREATE TRIGGER trader_block_status BEFORE UPDATE ON trader_block
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'ACTIVE>PAUSED,PAUSED>ACTIVE');
CREATE TRIGGER trader_block_immutable BEFORE UPDATE ON trader_block
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('capacity_minor', 'reserved_minor', 'rate_micro', 'min_order_minor', 'max_order_minor', 'status', 'updated_at', 'version');
CREATE TRIGGER trader_block_no_delete BEFORE DELETE OR TRUNCATE ON trader_block
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- A Buy USDT block backs the route that serves clients selling USDT, and a Sell USDT block the one serving buyers.
CREATE FUNCTION inrp2p_guard_trader_block_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r liquidity_route%ROWTYPE;
BEGIN
  SELECT * INTO r FROM liquidity_route WHERE id = NEW.route_id;
  IF r.trader_id IS DISTINCT FROM NEW.trader_id THEN
    RAISE EXCEPTION 'trader block route belongs to another owner' USING ERRCODE = 'IX071';
  END IF;
  IF r.direction <> (CASE WHEN NEW.side = 'BUY_USDT' THEN 'SELL_USDT' ELSE 'BUY_USDT' END) THEN
    RAISE EXCEPTION 'a % block needs a route serving the opposite client direction (route serves %)', NEW.side, r.direction USING ERRCODE = 'IX071';
  END IF;
  IF NEW.reserved_minor <> 0 THEN
    RAISE EXCEPTION 'a trader block starts with nothing reserved' USING ERRCODE = 'IX071';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trader_block_insert BEFORE INSERT ON trader_block
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_trader_block_insert();

-- ---------------------------------------------------------------------------------------------------------------
-- Trader orders: one client request, privately assigned to one trader (no split fills in V1).
-- OFFERED ─accept→ ACCEPTED ─trade opened→ IN_PROGRESS ─obligation settled→ COMPLETED
--    ├─decline→ DECLINED   ├─hold ended / request closed / desk released→ RELEASED   └─trade cancelled→ CANCELLED
--    ├─offer expired→ EXPIRED
--    └─withdrawn (request closed, trader offline or paused)→ WITHDRAWN
-- ---------------------------------------------------------------------------------------------------------------
CREATE SEQUENCE trader_order_ref_seq;
CREATE TABLE trader_order (
  id                        uuid PRIMARY KEY DEFAULT uuidv7(),
  ref                       text NOT NULL UNIQUE DEFAULT ('TO-' || to_char((inrp2p_now() AT TIME ZONE 'Asia/Kolkata'), 'YYMMDD') || '-' || inrp2p_ref_number(nextval('trader_order_ref_seq'), 4)),
  trader_id                 uuid NOT NULL REFERENCES trader_profile (id),
  block_id                  uuid NOT NULL REFERENCES trader_block (id),
  route_id                  uuid NOT NULL REFERENCES liquidity_route (id),
  trade_request_id          uuid NOT NULL REFERENCES trade_request (id),
  side                      text NOT NULL CHECK (side IN ('BUY_USDT', 'SELL_USDT')),
  -- The order's terms at the trader's rate: USDT, the INR it converts to, and the rate itself.
  base_minor                bigint NOT NULL CHECK (base_minor > 0),
  inr_minor                 bigint NOT NULL CHECK (inr_minor > 0),
  rate_micro                bigint NOT NULL CHECK (rate_micro > 0),
  -- What the order holds on its block, in the block's currency.
  capacity_minor            bigint NOT NULL CHECK (capacity_minor > 0),
  -- Desk-only: the client rate an INR-fixed request was sized at. Never part of a trader projection.
  planned_client_rate_micro bigint CHECK (planned_client_rate_micro > 0),
  status                    text NOT NULL DEFAULT 'OFFERED' CHECK (status IN ('OFFERED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  offered_by                text NOT NULL,
  offered_at                timestamptz NOT NULL DEFAULT inrp2p_now(),
  offer_expires_at          timestamptz NOT NULL,
  accepted_at               timestamptz,
  accepted_by               uuid REFERENCES auth_user (id),
  hold_until                timestamptz,
  route_rate_snapshot_id    uuid REFERENCES rate_snapshot (id),
  trade_id                  uuid UNIQUE REFERENCES trade (id),
  route_obligation_id       uuid UNIQUE REFERENCES route_obligation (id),
  quote_id                  uuid UNIQUE REFERENCES quote (id),
  started_at                timestamptz,
  -- When the trader's own side (its INR or USDT) was confirmed in full.
  delivered_at              timestamptz,
  -- Frozen when the order starts, so a later programme change never alters an order in flight.
  reward_bps                integer CHECK (reward_bps BETWEEN 0 AND 500),
  reward_inr_minor          bigint CHECK (reward_inr_minor >= 0),
  completed_at              timestamptz,
  closed_at                 timestamptz,
  closed_by                 text,
  close_reason              text CHECK (length(close_reason) <= 500),
  version                   integer NOT NULL DEFAULT 1,
  CHECK (capacity_minor = CASE WHEN side = 'BUY_USDT' THEN inr_minor ELSE base_minor END),
  CHECK (offer_expires_at > offered_at),
  CHECK ((status IN ('ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'RELEASED', 'CANCELLED'))
       = (accepted_at IS NOT NULL AND accepted_by IS NOT NULL AND hold_until IS NOT NULL AND route_rate_snapshot_id IS NOT NULL)),
  CHECK ((status IN ('IN_PROGRESS', 'COMPLETED', 'CANCELLED'))
       = (trade_id IS NOT NULL AND route_obligation_id IS NOT NULL AND quote_id IS NOT NULL AND started_at IS NOT NULL)),
  CHECK ((status IN ('DECLINED', 'EXPIRED', 'WITHDRAWN', 'RELEASED', 'COMPLETED', 'CANCELLED')) = (closed_at IS NOT NULL)),
  CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL)),
  CHECK (delivered_at IS NULL OR started_at IS NOT NULL),
  CHECK ((reward_bps IS NULL) = (reward_inr_minor IS NULL))
);
-- One live assignment per request: a request is never offered to two traders at once (no split fills).
CREATE UNIQUE INDEX trader_order_one_live_per_request ON trader_order (trade_request_id) WHERE status IN ('OFFERED', 'ACCEPTED');
CREATE INDEX trader_order_trader_idx ON trader_order (trader_id, status, offered_at DESC);
CREATE INDEX trader_order_offer_expiry_idx ON trader_order (offer_expires_at) WHERE status = 'OFFERED';
CREATE INDEX trader_order_hold_idx ON trader_order (hold_until) WHERE status = 'ACCEPTED';
CREATE INDEX trader_order_request_idx ON trader_order (trade_request_id, offered_at DESC);
CREATE TRIGGER trader_order_status BEFORE UPDATE ON trader_order
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status',
    'OFFERED>ACCEPTED,OFFERED>DECLINED,OFFERED>EXPIRED,OFFERED>WITHDRAWN,ACCEPTED>IN_PROGRESS,ACCEPTED>RELEASED,IN_PROGRESS>COMPLETED,IN_PROGRESS>CANCELLED');
CREATE TRIGGER trader_order_immutable BEFORE UPDATE ON trader_order
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns(
    'status', 'accepted_at', 'accepted_by', 'hold_until', 'route_rate_snapshot_id', 'trade_id', 'route_obligation_id',
    'quote_id', 'started_at', 'delivered_at', 'reward_bps', 'reward_inr_minor', 'completed_at', 'closed_at', 'closed_by', 'close_reason', 'version');
CREATE TRIGGER trader_order_no_delete BEFORE DELETE OR TRUNCATE ON trader_order
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

CREATE FUNCTION inrp2p_guard_trader_order_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  b trader_block%ROWTYPE;
  r trade_request%ROWTYPE;
  trader_client uuid;
BEGIN
  SELECT * INTO b FROM trader_block WHERE id = NEW.block_id;
  IF b.trader_id <> NEW.trader_id OR b.route_id <> NEW.route_id OR b.side <> NEW.side THEN
    RAISE EXCEPTION 'trader order does not match its block' USING ERRCODE = 'IX072';
  END IF;
  SELECT * INTO r FROM trade_request WHERE id = NEW.trade_request_id;
  IF r.direction <> (CASE WHEN NEW.side = 'BUY_USDT' THEN 'SELL_USDT' ELSE 'BUY_USDT' END) THEN
    RAISE EXCEPTION 'a % order cannot fill a % request', NEW.side, r.direction USING ERRCODE = 'IX072';
  END IF;
  -- A trader never fills its own client's request.
  SELECT client_id INTO trader_client FROM trader_profile WHERE id = NEW.trader_id;
  IF trader_client = r.client_id THEN
    RAISE EXCEPTION 'a trader cannot be assigned its own request' USING ERRCODE = 'IX072';
  END IF;
  IF NEW.status <> 'OFFERED' THEN
    RAISE EXCEPTION 'a trader order starts OFFERED' USING ERRCODE = 'IX040';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trader_order_insert BEFORE INSERT ON trader_order
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_trader_order_insert();

-- The trade an order starts is exactly the one the trader accepted: same quote on the same route, the snapshot the
-- acceptance published, the accepted USDT and INR amounts, and that trade's own obligation.
CREATE FUNCTION inrp2p_guard_trader_order_link() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  q quote%ROWTYPE;
BEGIN
  IF NEW.trade_id IS NOT NULL AND OLD.trade_id IS NULL THEN
    SELECT * INTO q FROM quote WHERE id = NEW.quote_id;
    IF q.route_id <> NEW.route_id OR q.trade_request_id <> NEW.trade_request_id OR q.route_rate_snapshot_id <> NEW.route_rate_snapshot_id
       OR q.base_minor <> NEW.base_minor OR q.route_value_inr_minor <> NEW.inr_minor THEN
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
CREATE TRIGGER trader_order_link BEFORE UPDATE ON trader_order
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_trader_order_link();

-- A block's reserved amount equals the capacity its open orders hold, at commit.
CREATE FUNCTION inrp2p_check_trader_block_reserved() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  blk uuid;
  held bigint;
  reserved bigint;
BEGIN
  IF TG_TABLE_NAME = 'trader_block' THEN
    blk := NEW.id;
  ELSE
    blk := NEW.block_id;
  END IF;
  SELECT reserved_minor INTO reserved FROM trader_block WHERE id = blk;
  SELECT coalesce(sum(capacity_minor), 0) INTO held FROM trader_order WHERE block_id = blk AND status IN ('ACCEPTED', 'IN_PROGRESS');
  IF reserved IS DISTINCT FROM held THEN
    RAISE EXCEPTION 'trader block % reserves % but its open orders hold %', blk, reserved, held USING ERRCODE = 'IX074';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER trader_block_reserved_consistent AFTER UPDATE ON trader_block
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inrp2p_check_trader_block_reserved();
CREATE CONSTRAINT TRIGGER trader_order_reserved_consistent AFTER INSERT OR UPDATE ON trader_order
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inrp2p_check_trader_block_reserved();

-- A quote on a trader route prices only what that trader accepted, on the snapshot its acceptance published.
CREATE FUNCTION inrp2p_guard_trader_route_quote() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT trader_id FROM liquidity_route WHERE id = NEW.route_id) IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NOT (NEW.status = 'SENT' AND OLD.status <> 'SENT') THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM trader_order o
    WHERE o.trade_request_id = NEW.trade_request_id AND o.route_id = NEW.route_id AND o.status = 'ACCEPTED'
      AND o.route_rate_snapshot_id = NEW.route_rate_snapshot_id AND o.base_minor = NEW.base_minor AND o.inr_minor = NEW.route_value_inr_minor
  ) THEN
    RAISE EXCEPTION 'a quote on a trader route needs that trader''s accepted order for exactly this amount' USING ERRCODE = 'IX075';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER quote_trader_route BEFORE INSERT OR UPDATE OF status ON quote
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_trader_route_quote();

-- A trade opened on a trader route has started that trader's order by the time it commits.
CREATE FUNCTION inrp2p_check_trader_route_trade() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT trader_id FROM liquidity_route WHERE id = NEW.route_id) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM trader_order WHERE trade_id = NEW.trade_id) THEN
    RAISE EXCEPTION 'trade % on a trader route has no started trader order', NEW.trade_id USING ERRCODE = 'IX075';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER trade_economics_trader_order AFTER INSERT ON trade_economics
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inrp2p_check_trader_route_trade();

-- ---------------------------------------------------------------------------------------------------------------
-- Route rates on trader routes come from the trader (source TRADER); operator-published rates are refused there,
-- and TRADER is refused anywhere else. Market reference rates are never a trader's rate (FI-01).
-- ---------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'rate_snapshot'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%source%' LOOP
    EXECUTE format('ALTER TABLE rate_snapshot DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;
ALTER TABLE rate_snapshot ADD CONSTRAINT rate_snapshot_source_format CHECK (source ~ '^(OPERATOR|TRADER|FEED:[a-z0-9_]{1,40})$');
ALTER TABLE rate_snapshot ADD CONSTRAINT rate_snapshot_source_kind CHECK ((kind = 'REFERENCE' AND source <> 'TRADER') OR (kind = 'ROUTE' AND source IN ('OPERATOR', 'TRADER')));
CREATE FUNCTION inrp2p_guard_rate_snapshot_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owned boolean;
BEGIN
  IF NEW.kind = 'ROUTE' THEN
    SELECT trader_id IS NOT NULL INTO owned FROM liquidity_route WHERE id = NEW.route_id;
    IF owned AND NEW.source <> 'TRADER' THEN
      RAISE EXCEPTION 'the rate of a trader route is set by the trader' USING ERRCODE = 'IX076';
    END IF;
    IF NOT owned AND NEW.source = 'TRADER' THEN
      RAISE EXCEPTION 'only a trader route takes a trader rate' USING ERRCODE = 'IX076';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER rate_snapshot_owner BEFORE INSERT ON rate_snapshot
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_rate_snapshot_owner();

-- ---------------------------------------------------------------------------------------------------------------
-- Security Reserve withdrawals. Deposits are ledger postings from USDT that arrived at the trader's own reserve
-- address; a withdrawal is the one movement that sends it back, to the trader's registered wallet.
-- REQUESTED ─tx recorded→ SENT ─verified on chain→ COMPLETED;  REQUESTED/SENT ─operator→ REJECTED;  REQUESTED ─trader→ CANCELLED
-- ---------------------------------------------------------------------------------------------------------------
CREATE SEQUENCE trader_reserve_withdrawal_ref_seq;
CREATE TABLE trader_reserve_withdrawal (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  ref                 text NOT NULL UNIQUE DEFAULT ('RW-' || inrp2p_ref_number(nextval('trader_reserve_withdrawal_ref_seq'), 6)),
  trader_id           uuid NOT NULL REFERENCES trader_profile (id),
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  status              text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'SENT', 'COMPLETED', 'REJECTED', 'CANCELLED')),
  destination_address inrp2p_tron_address NOT NULL,
  requested_by        uuid NOT NULL REFERENCES auth_user (id),
  requested_at        timestamptz NOT NULL DEFAULT inrp2p_now(),
  treasury_wallet_id  uuid REFERENCES treasury_wallet (id),
  crypto_transfer_id  uuid UNIQUE REFERENCES crypto_transfer (id),
  sent_recorded_by    text,
  sent_at             timestamptz,
  completed_at        timestamptz,
  closed_at           timestamptz,
  closed_by           text,
  close_reason        text CHECK (length(close_reason) <= 500),
  CHECK ((crypto_transfer_id IS NULL) = (sent_at IS NULL)),
  CHECK ((crypto_transfer_id IS NULL) = (treasury_wallet_id IS NULL)),
  CHECK (status NOT IN ('SENT', 'COMPLETED') OR crypto_transfer_id IS NOT NULL),
  CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL)),
  CHECK ((status IN ('COMPLETED', 'REJECTED', 'CANCELLED')) = (closed_at IS NOT NULL)),
  CHECK (status NOT IN ('REJECTED', 'CANCELLED') OR close_reason IS NOT NULL)
);
CREATE UNIQUE INDEX trader_reserve_withdrawal_one_open ON trader_reserve_withdrawal (trader_id) WHERE status IN ('REQUESTED', 'SENT');
CREATE TRIGGER trader_reserve_withdrawal_status BEFORE UPDATE ON trader_reserve_withdrawal
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'REQUESTED>SENT,SENT>COMPLETED,REQUESTED>REJECTED,SENT>REJECTED,REQUESTED>CANCELLED');
CREATE TRIGGER trader_reserve_withdrawal_immutable BEFORE UPDATE ON trader_reserve_withdrawal
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'treasury_wallet_id', 'crypto_transfer_id', 'sent_recorded_by', 'sent_at', 'completed_at', 'closed_at', 'closed_by', 'close_reason');
CREATE TRIGGER trader_reserve_withdrawal_no_delete BEFORE DELETE OR TRUNCATE ON trader_reserve_withdrawal
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- Reward payouts: INR paid from an exchange account to the trader's registered bank account, against the reward
-- payable the ledger accrued on completed orders. RECORDED ─confirm⧗→ CONFIRMED;  RECORDED ─fail⧗→ FAILED
-- ---------------------------------------------------------------------------------------------------------------
CREATE SEQUENCE trader_reward_payout_ref_seq;
CREATE TABLE trader_reward_payout (
  id                          uuid PRIMARY KEY DEFAULT uuidv7(),
  ref                         text NOT NULL UNIQUE DEFAULT ('RP-' || inrp2p_ref_number(nextval('trader_reward_payout_ref_seq'), 6)),
  trader_id                   uuid NOT NULL REFERENCES trader_profile (id),
  amount_minor                bigint NOT NULL CHECK (amount_minor > 0),
  status                      text NOT NULL DEFAULT 'RECORDED' CHECK (status IN ('RECORDED', 'CONFIRMED', 'FAILED')),
  inr_account_id              uuid NOT NULL REFERENCES inr_settlement_account (id),
  fiat_transfer_id            uuid NOT NULL UNIQUE REFERENCES fiat_transfer (id),
  capacity_reservation_id     uuid REFERENCES capacity_reservation (id),
  destination_bank_account_id uuid NOT NULL REFERENCES bank_account (id),
  recorded_by                 text NOT NULL,
  recorded_at                 timestamptz NOT NULL DEFAULT inrp2p_now(),
  confirmed_by                text,
  confirmed_at                timestamptz,
  failed_at                   timestamptz,
  failure_reason              text CHECK (length(failure_reason) <= 500),
  CHECK ((status = 'CONFIRMED') = (confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)),
  CHECK ((status = 'FAILED') = (failed_at IS NOT NULL AND failure_reason IS NOT NULL))
);
CREATE INDEX trader_reward_payout_trader_idx ON trader_reward_payout (trader_id, recorded_at DESC);
CREATE TRIGGER trader_reward_payout_status BEFORE UPDATE ON trader_reward_payout
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'RECORDED>CONFIRMED,RECORDED>FAILED');
CREATE TRIGGER trader_reward_payout_immutable BEFORE UPDATE ON trader_reward_payout
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'capacity_reservation_id', 'confirmed_by', 'confirmed_at', 'failed_at', 'failure_reason');
CREATE TRIGGER trader_reward_payout_no_delete BEFORE DELETE OR TRUNCATE ON trader_reward_payout
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- Outgoing INR for a reward payout draws on the same daily account capacity as every other payment out (FI-30).
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'capacity_reservation'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%purpose%' LOOP
    EXECUTE format('ALTER TABLE capacity_reservation DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;
ALTER TABLE capacity_reservation ADD COLUMN trader_reward_payout_id uuid REFERENCES trader_reward_payout (id);
ALTER TABLE capacity_reservation ADD CONSTRAINT capacity_reservation_purpose_check CHECK (purpose IN ('CLIENT_PAYOUT', 'ROUTE_SETTLEMENT', 'TRADER_REWARD_PAYOUT'));
ALTER TABLE capacity_reservation ADD CONSTRAINT capacity_reservation_one_subject CHECK (
  (purpose = 'CLIENT_PAYOUT' AND trade_id IS NOT NULL AND route_settlement_id IS NULL AND trader_reward_payout_id IS NULL)
  OR (purpose = 'ROUTE_SETTLEMENT' AND route_settlement_id IS NOT NULL AND trade_id IS NULL AND trader_reward_payout_id IS NULL)
  OR (purpose = 'TRADER_REWARD_PAYOUT' AND trader_reward_payout_id IS NOT NULL AND trade_id IS NULL AND route_settlement_id IS NULL));
ALTER TABLE capacity_reservation DROP CONSTRAINT capacity_reservation_released_reason_check;
ALTER TABLE capacity_reservation ADD CONSTRAINT capacity_reservation_released_reason_check CHECK (released_reason IN (
  'TRADE_CANCELLED', 'LEG_CANCELLED', 'LEG_FAILED', 'TRADE_COMPLETED', 'ROUTE_SETTLEMENT_FAILED', 'DAY_ROLLOVER', 'OPERATOR', 'TRADER_PAYOUT_FAILED'));
CREATE INDEX capacity_reservation_trader_payout_idx ON capacity_reservation (trader_reward_payout_id) WHERE trader_reward_payout_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------------------
-- Deposit addresses for a trader's reserve and for a trader's USDT delivery on one obligation. The address is the
-- only attribution, exactly as for a client deposit (D-02): nothing is matched by amount or sender.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE deposit_assignment ALTER COLUMN trade_id DROP NOT NULL;
ALTER TABLE deposit_assignment ADD COLUMN trader_id uuid REFERENCES trader_profile (id);
ALTER TABLE deposit_assignment ADD COLUMN route_obligation_id uuid REFERENCES route_obligation (id);
ALTER TABLE deposit_assignment ADD CONSTRAINT deposit_assignment_one_subject CHECK (num_nonnulls(trade_id, trader_id, route_obligation_id) = 1);
ALTER TABLE deposit_assignment DROP CONSTRAINT deposit_assignment_release_reason_check;
ALTER TABLE deposit_assignment ADD CONSTRAINT deposit_assignment_release_reason_check
  CHECK (release_reason IN ('TRADE_COMPLETED', 'TRADE_CANCELLED', 'OBLIGATION_SETTLED', 'OBLIGATION_CANCELLED', 'TRADER_CLOSED'));
CREATE UNIQUE INDEX deposit_assignment_one_open_per_trader ON deposit_assignment (trader_id) WHERE trader_id IS NOT NULL AND released_at IS NULL;
CREATE UNIQUE INDEX deposit_assignment_one_per_obligation ON deposit_assignment (route_obligation_id) WHERE route_obligation_id IS NOT NULL;
-- A delivery address is only for the USDT a trader route owes the exchange.
CREATE FUNCTION inrp2p_guard_deposit_assignment_subject() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o route_obligation%ROWTYPE;
BEGIN
  IF NEW.route_obligation_id IS NOT NULL THEN
    SELECT * INTO o FROM route_obligation WHERE id = NEW.route_obligation_id;
    IF o.route_delivers_asset <> 'USDT' OR (SELECT trader_id FROM liquidity_route WHERE id = o.route_id) IS NULL THEN
      RAISE EXCEPTION 'a delivery address is only for the USDT a trader route owes' USING ERRCODE = 'IX077';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER deposit_assignment_subject BEFORE INSERT ON deposit_assignment
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_deposit_assignment_subject();

-- ---------------------------------------------------------------------------------------------------------------
-- Movement parties: a trader's reserve deposits and withdrawals (USDT) and reward payouts (INR).
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE crypto_transfer DROP CONSTRAINT crypto_transfer_payer_type_check;
ALTER TABLE crypto_transfer ADD CONSTRAINT crypto_transfer_payer_type_check CHECK (payer_type IN ('CLIENT', 'EXCHANGE_TREASURY', 'ROUTE', 'TRADER', 'UNKNOWN'));
ALTER TABLE crypto_transfer DROP CONSTRAINT crypto_transfer_payee_type_check;
ALTER TABLE crypto_transfer ADD CONSTRAINT crypto_transfer_payee_type_check CHECK (payee_type IN ('CLIENT_WALLET', 'EXCHANGE_TREASURY', 'ROUTE', 'TRADER', 'UNKNOWN'));
ALTER TABLE fiat_transfer DROP CONSTRAINT fiat_transfer_payee_type_check;
ALTER TABLE fiat_transfer ADD CONSTRAINT fiat_transfer_payee_type_check CHECK (payee_type IN ('CLIENT_BANK', 'EXCHANGE_ACCOUNT', 'ROUTE', 'TRADER'));

-- ---------------------------------------------------------------------------------------------------------------
-- Trader notifications land in the client's inbox (a trader is a client). References may grow a digit (0020).
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE client_notification DROP CONSTRAINT client_notification_kind_check;
ALTER TABLE client_notification ADD CONSTRAINT client_notification_kind_check CHECK (kind IN (
  'QUOTE_SENT', 'QUOTE_EXPIRED', 'REQUEST_DECLINED', 'TRADE_OPENED', 'PAYOUT_CONFIRMED', 'TRADE_COMPLETED', 'TRADE_CANCELLED',
  'DESTINATION_ADDED', 'DESTINATION_ARCHIVED',
  'TRADER_APPROVED', 'TRADER_REJECTED', 'TRADER_PAUSED', 'TRADER_RESUMED', 'TRADER_ORDER_NEW', 'TRADER_ORDER_ACCEPTED',
  'TRADER_ACTION_REQUIRED', 'TRADER_PAYMENT_CONFIRMED', 'TRADER_ORDER_COMPLETED', 'TRADER_ORDER_CLOSED', 'TRADER_RESERVE_ISSUE'));
ALTER TABLE client_notification DROP CONSTRAINT client_notification_subject_ref_check;
ALTER TABLE client_notification ADD CONSTRAINT client_notification_subject_ref_check CHECK (subject_ref ~ '^[A-Z]{2}-[0-9]{6}-[0-9]{4,}$');

-- ---------------------------------------------------------------------------------------------------------------
-- Grants: lifecycle columns only; no DELETE anywhere.
-- ---------------------------------------------------------------------------------------------------------------
GRANT USAGE ON SEQUENCE trader_ref_seq, trader_order_ref_seq, trader_reserve_withdrawal_ref_seq, trader_reward_payout_ref_seq TO inrp2p_app;
GRANT EXECUTE ON FUNCTION inrp2p_trader_wallet_address(uuid) TO inrp2p_app, inrp2p_readonly;
GRANT SELECT ON trader_program TO inrp2p_app;
GRANT UPDATE (default_required_reserve_minor, reward_bps, offer_ttl_seconds, hold_ttl_seconds, auto_assign, collection_account_id, updated_by, updated_at, version) ON trader_program TO inrp2p_app;
GRANT SELECT, INSERT ON trader_profile, trader_block, trader_order, trader_reserve_withdrawal, trader_reward_payout TO inrp2p_app;
GRANT UPDATE (status, offers_buy, offers_sell, typical_inr_minor, typical_usdt_minor, bank_account_id, wallet_id, required_reserve_minor, reward_bps,
  max_order_inr_minor, max_order_usdt_minor, max_capacity_inr_minor, max_capacity_usdt_minor, available, assignments_enabled, control_note,
  applied_by, applied_at, reviewed_by, reviewed_at, review_note, updated_at, version) ON trader_profile TO inrp2p_app;
GRANT UPDATE (capacity_minor, reserved_minor, rate_micro, min_order_minor, max_order_minor, status, updated_at, version) ON trader_block TO inrp2p_app;
GRANT UPDATE (status, accepted_at, accepted_by, hold_until, route_rate_snapshot_id, trade_id, route_obligation_id, quote_id, started_at, delivered_at,
  reward_bps, reward_inr_minor, completed_at, closed_at, closed_by, close_reason, version) ON trader_order TO inrp2p_app;
GRANT UPDATE (status, treasury_wallet_id, crypto_transfer_id, sent_recorded_by, sent_at, completed_at, closed_at, closed_by, close_reason) ON trader_reserve_withdrawal TO inrp2p_app;
GRANT UPDATE (status, capacity_reservation_id, confirmed_by, confirmed_at, failed_at, failure_reason) ON trader_reward_payout TO inrp2p_app;
GRANT SELECT ON trader_program, trader_profile, trader_block, trader_order, trader_reserve_withdrawal, trader_reward_payout TO inrp2p_readonly;
