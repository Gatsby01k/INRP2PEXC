-- 0040 Desks: every trader runs its own exchange on INRP2P (docs/adr/0020-desks.md).
--
-- A desk is a trader's own exchange: a name and a page, its own clients and its own prices. Its clients deal with the
-- desk; the desk fills their deals with its own liquidity, through the P2P escrow of ADR 0019 (rupees straight between
-- the client's and the desk's own accounts, USDT through the deal's own address). INRP2P earns an explicit fee, never a
-- hidden spread: the fee policy's basis points of the deal's USDT, taken from the escrow.
--
-- 1. `fee_policy`: the platform's fee — on a deal a desk fills itself, and (later) on a deal the network fills. Append-only;
--    a change names a second person.
-- 2. `desk`: one per trader — handle, name, status. Live only for an approved trader.
-- 3. `desk_price`: the prices a desk shows its clients, per client direction, with limits. Append-only: the latest counts.
-- 4. `desk_client`: whose client a client is. A client may be a client of several desks; a desk never has its own trader's
--    client as a client.
-- 5. `trade_request.desk_id`: a request placed with a desk, by one of its active clients, and filled by that desk only.
-- 6. A desk deal's economics (IX125): the client's rate is the desk's; the desk gets the client's USDT less the fee (client
--    sells) or delivers it plus the fee (client buys); the fee is the policy's, rounded up, and is the deal's whole margin.
--    Frozen with the quote and the trade (IX045).
-- 7. The network fee of a P2P deal is the route trader's (IX103): its network deposit funds every transfer of the deal and
--    nothing is paid back — the platform has no TRX budget of its own to spend on P2P deals.
-- 8. `desk_deal_link`: a deal a desk offers one client by a link — direction, amount and the desk's rate for it. The first
--    client to take it is the only one who can; it yields at most one trade; its rate is the quote's (IX126).
-- 9. `client_invite`: an administrator invites a person by email to the team — as an administrator or an operator. Only
--    that email, signed in, can accept; an invite lives seven days (IX127). The team hears of every change.
-- 10. `telegram_link`, `telegram_delivery`: a person's Telegram chat, linked by a one-time code they send the bot, and each
--    alert sent to it once (a desk's new deals, its moves, deadlines, completions).
-- Error codes IX121–IX127 belong to this migration.

-- 1. The platform's fee ----------------------------------------------------------------------------------------------

CREATE TABLE fee_policy (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  -- Basis points of the deal's USDT on a deal the desk fills with its own liquidity.
  own_deal_bps     integer NOT NULL CHECK (own_deal_bps BETWEEN 0 AND 1000),
  -- Basis points on a deal another desk fills for it through the network (stage 2; recorded now so one row is the policy).
  network_deal_bps integer NOT NULL CHECK (network_deal_bps BETWEEN 0 AND 1000),
  reason           text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  set_by           text NOT NULL,
  approved_by      text,
  set_at           timestamptz NOT NULL DEFAULT inrp2p_now(),
  -- A change is made by one person and approved by another; only the migration's own first row has no approver.
  CHECK ((approved_by IS NULL AND set_by LIKE 'migration %') OR (approved_by IS NOT NULL AND approved_by <> set_by))
);
CREATE INDEX fee_policy_current_idx ON fee_policy (set_at DESC, id DESC);
CREATE TRIGGER fee_policy_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON fee_policy
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();
INSERT INTO fee_policy (own_deal_bps, network_deal_bps, reason, set_by)
VALUES (25, 60, 'owner decision of 2026-10-17: 0.25% on a desk''s own deal, 0.6% on a deal filled through the network', 'migration 0040');

-- A change of the fee is proposed by one person and decided by another (block 11): approved, it becomes the policy for every
-- price from then on (a price already given keeps its own fee, IX045); rejected or withdrawn, nothing changes. One open
-- proposal at a time.
CREATE TABLE fee_policy_proposal (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  own_deal_bps     integer NOT NULL CHECK (own_deal_bps BETWEEN 0 AND 1000),
  network_deal_bps integer NOT NULL CHECK (network_deal_bps BETWEEN 0 AND 1000),
  reason           text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  proposed_by      text NOT NULL,
  proposed_at      timestamptz NOT NULL DEFAULT inrp2p_now(),
  status           text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  decided_by       text,
  decided_at       timestamptz,
  decision_note    text CHECK (decision_note IS NULL OR length(btrim(decision_note)) BETWEEN 1 AND 500),
  fee_policy_id    uuid UNIQUE REFERENCES fee_policy (id),
  CHECK ((status = 'PROPOSED') = (decided_at IS NULL)),
  CHECK (status = 'PROPOSED' OR decided_by IS NOT NULL),
  -- Approved and rejected by someone else; withdrawn only by the one who proposed it.
  CHECK (status NOT IN ('APPROVED', 'REJECTED') OR decided_by <> proposed_by),
  CHECK (status <> 'WITHDRAWN' OR decided_by = proposed_by),
  CHECK ((status = 'APPROVED') = (fee_policy_id IS NOT NULL))
);
CREATE UNIQUE INDEX fee_policy_proposal_one_open ON fee_policy_proposal ((true)) WHERE status = 'PROPOSED';
CREATE TRIGGER fee_policy_proposal_status BEFORE UPDATE ON fee_policy_proposal
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'PROPOSED>APPROVED,PROPOSED>REJECTED,PROPOSED>WITHDRAWN');
CREATE TRIGGER fee_policy_proposal_immutable BEFORE UPDATE ON fee_policy_proposal
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'decided_by', 'decided_at', 'decision_note', 'fee_policy_id');
CREATE TRIGGER fee_policy_proposal_no_delete BEFORE DELETE OR TRUNCATE ON fee_policy_proposal
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

CREATE FUNCTION inrp2p_platform_fee_bps() RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT own_deal_bps FROM fee_policy ORDER BY set_at DESC, id DESC LIMIT 1
$$;

-- 2. Desks -----------------------------------------------------------------------------------------------------------

-- Paths of the public site and the app that a desk's page must never shadow (`inrp2p.com/<handle>`).
CREATE FUNCTION inrp2p_desk_handle_reserved(p_handle text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_handle = ANY (ARRAY[
    'about', 'account', 'accounts', 'admin', 'api', 'app', 'assets', 'become-a-trader', 'buy-usdt-in-india',
    'clients', 'contact', 'deal', 'deals', 'desk', 'desk-ops', 'desks', 'destinations', 'docs', 'escrow', 'exceptions',
    'exchange', 'faq', 'health', 'help', 'history', 'home', 'inr', 'inr-to-usdt', 'inrp2p', 'legal', 'link', 'links',
    'login', 'logout', 'metrics', 'network', 'notifications', 'official', 'open', 'open-account', 'orders', 'p2p',
    'pnl', 'privacy', 'public-desk', 'quote', 'quotes', 'rates', 'register', 'revenue', 'robots', 'root', 'sell-usdt-in-india',
    'settings', 'sign-in', 'sign-up', 'signin', 'signup', 'sitemap', 'static', 'status', 'support', 'system', 'team',
    'terms', 'trader', 'trader-desk', 'traders', 'trades', 'usdt', 'usdt-otc-india', 'usdt-to-inr', 'www'])
$$;

CREATE TABLE desk (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  trader_id    uuid NOT NULL UNIQUE REFERENCES trader_profile (id),
  -- The page's address: inrp2p.com/<handle>. Lower-case letters, digits and inner hyphens, 3 to 30 characters.
  handle       text NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$' AND NOT inrp2p_desk_handle_reserved(handle)),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 2 AND 60),
  about        text CHECK (about IS NULL OR length(btrim(about)) BETWEEN 1 AND 280),
  -- SUSPENDED (block 11): INRP2P stopped it — no new deal, its open deals go on; lifting it leaves the desk paused.
  status       text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'LIVE', 'PAUSED', 'SUSPENDED')),
  suspension_reason  text CHECK (suspension_reason IS NULL OR length(btrim(suspension_reason)) BETWEEN 3 AND 500),
  suspended_at       timestamptz,
  -- INRP2P hid the page: its name or words do not belong on INRP2P. Hidden from everyone until INRP2P shows it again.
  page_hidden_reason text CHECK (page_hidden_reason IS NULL OR length(btrim(page_hidden_reason)) BETWEEN 3 AND 500),
  page_hidden_at     timestamptz,
  -- Set when INRP2P renamed the desk: the only way a live desk's address ever changes.
  handle_moderated_at timestamptz,
  created_by   uuid NOT NULL REFERENCES auth_user (id),
  created_at   timestamptz NOT NULL DEFAULT inrp2p_now(),
  updated_at   timestamptz NOT NULL DEFAULT inrp2p_now(),
  version      integer NOT NULL DEFAULT 1,
  CHECK ((status = 'SUSPENDED') = (suspension_reason IS NOT NULL AND suspended_at IS NOT NULL)),
  CHECK ((page_hidden_reason IS NULL) = (page_hidden_at IS NULL))
);
CREATE TRIGGER desk_status BEFORE UPDATE ON desk
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status',
    'DRAFT>LIVE,LIVE>PAUSED,PAUSED>LIVE,DRAFT>SUSPENDED,LIVE>SUSPENDED,PAUSED>SUSPENDED,SUSPENDED>PAUSED');
CREATE TRIGGER desk_immutable BEFORE UPDATE ON desk
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('handle', 'display_name', 'about', 'status', 'suspension_reason', 'suspended_at',
    'page_hidden_reason', 'page_hidden_at', 'handle_moderated_at', 'updated_at', 'version');
CREATE TRIGGER desk_no_delete BEFORE DELETE OR TRUNCATE ON desk
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- IX121: a desk is live only while its trader is approved, and its handle is fixed once it has gone live: links to it are
-- out in the world — unless INRP2P renames it (block 11), which it records in the same change.
CREATE FUNCTION inrp2p_guard_desk() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'LIVE' AND (TG_OP = 'INSERT' OR OLD.status <> 'LIVE')
     AND (SELECT status FROM trader_profile WHERE id = NEW.trader_id) IS DISTINCT FROM 'APPROVED' THEN
    RAISE EXCEPTION 'desk % goes live only while its trader is approved', NEW.handle USING ERRCODE = 'IX121';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.handle <> OLD.handle AND OLD.status <> 'DRAFT' AND NEW.handle_moderated_at IS NOT DISTINCT FROM OLD.handle_moderated_at THEN
    RAISE EXCEPTION 'the handle of desk % is fixed once it has gone live', OLD.handle USING ERRCODE = 'IX121';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER desk_guard BEFORE INSERT OR UPDATE ON desk
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_desk();

-- 3. A desk's prices -------------------------------------------------------------------------------------------------

CREATE TABLE desk_price (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  desk_id        uuid NOT NULL REFERENCES desk (id),
  -- The client's direction: SELL_USDT is the rate the desk pays for a client's USDT, BUY_USDT what a client pays for it.
  direction      text NOT NULL CHECK (direction IN ('SELL_USDT', 'BUY_USDT')),
  rate_micro     bigint NOT NULL CHECK (rate_micro > 0),
  min_base_minor bigint NOT NULL CHECK (min_base_minor > 0),
  max_base_minor bigint NOT NULL,
  -- Off: the price is shown as the desk's but no deal is priced on it.
  live           boolean NOT NULL,
  -- A price is not offered past this moment: a desk that stops updating stops trading on stale prices.
  valid_until    timestamptz NOT NULL,
  set_by         uuid NOT NULL REFERENCES auth_user (id),
  set_at         timestamptz NOT NULL DEFAULT inrp2p_now(),
  CHECK (max_base_minor >= min_base_minor),
  CHECK (valid_until > set_at)
);
CREATE INDEX desk_price_current_idx ON desk_price (desk_id, direction, set_at DESC, id DESC);
CREATE TRIGGER desk_price_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON desk_price
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- 4. A desk's clients ------------------------------------------------------------------------------------------------

CREATE TABLE desk_client (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  desk_id             uuid NOT NULL REFERENCES desk (id),
  client_id           uuid NOT NULL REFERENCES client (id),
  -- How the client came: the desk's page, a deal link it was sent, or an invitation.
  source              text NOT NULL CHECK (source IN ('PAGE', 'LINK', 'INVITE')),
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'BLOCKED')),
  -- The desk's own limit on one deal with this client; none means the desk's prices' limits.
  max_deal_base_minor bigint CHECK (max_deal_base_minor > 0),
  note                text CHECK (note IS NULL OR length(note) <= 500),
  created_at          timestamptz NOT NULL DEFAULT inrp2p_now(),
  updated_at          timestamptz NOT NULL DEFAULT inrp2p_now(),
  version             integer NOT NULL DEFAULT 1,
  UNIQUE (desk_id, client_id)
);
CREATE INDEX desk_client_client_idx ON desk_client (client_id);
CREATE TRIGGER desk_client_status BEFORE UPDATE ON desk_client
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'ACTIVE>BLOCKED,BLOCKED>ACTIVE');
CREATE TRIGGER desk_client_immutable BEFORE UPDATE ON desk_client
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'max_deal_base_minor', 'note', 'updated_at', 'version');
CREATE TRIGGER desk_client_no_delete BEFORE DELETE OR TRUNCATE ON desk_client
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- IX122: a desk never takes its own trader's client as a client (it would be dealing with itself).
CREATE FUNCTION inrp2p_guard_desk_client() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT t.client_id FROM desk d JOIN trader_profile t ON t.id = d.trader_id WHERE d.id = NEW.desk_id) = NEW.client_id THEN
    RAISE EXCEPTION 'a desk cannot have its own trader as a client' USING ERRCODE = 'IX122';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER desk_client_guard BEFORE INSERT ON desk_client
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_desk_client();

-- 5. A request placed with a desk ------------------------------------------------------------------------------------

-- Insert-once: the request's immutability guard (0013) lets only its lifecycle columns change.
ALTER TABLE trade_request ADD COLUMN desk_id uuid REFERENCES desk (id);
CREATE INDEX trade_request_desk_idx ON trade_request (desk_id, created_at DESC) WHERE desk_id IS NOT NULL;

-- IX123: a request is placed with a live desk by one of its active clients.
CREATE FUNCTION inrp2p_guard_desk_request() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.desk_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF (SELECT status FROM desk WHERE id = NEW.desk_id) IS DISTINCT FROM 'LIVE' THEN
    RAISE EXCEPTION 'desk % is not live', NEW.desk_id USING ERRCODE = 'IX123';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM desk_client WHERE desk_id = NEW.desk_id AND client_id = NEW.client_id AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'client % is not an active client of desk %', NEW.client_id, NEW.desk_id USING ERRCODE = 'IX123';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trade_request_desk BEFORE INSERT ON trade_request
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_desk_request();

-- IX124: a desk's request is filled by that desk alone (stage 1: no network yet).
CREATE FUNCTION inrp2p_guard_desk_order() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  desk_trader uuid;
BEGIN
  SELECT d.trader_id INTO desk_trader FROM trade_request r JOIN desk d ON d.id = r.desk_id WHERE r.id = NEW.trade_request_id;
  IF desk_trader IS NOT NULL AND desk_trader <> NEW.trader_id THEN
    RAISE EXCEPTION 'a request placed with a desk is filled by that desk''s own trader' USING ERRCODE = 'IX124';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trader_order_desk BEFORE INSERT ON trader_order
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_desk_order();

-- 6. A desk deal's economics -----------------------------------------------------------------------------------------

ALTER TABLE quote
  ADD COLUMN platform_fee_bps integer CHECK (platform_fee_bps BETWEEN 0 AND 1000),
  ADD COLUMN platform_fee_base_minor bigint CHECK (platform_fee_base_minor >= 0),
  ADD CONSTRAINT quote_platform_fee_shape CHECK ((platform_fee_bps IS NULL) = (platform_fee_base_minor IS NULL)
    AND (platform_fee_bps IS NULL OR route_base_minor IS NOT NULL));

ALTER TABLE trade_economics
  ADD COLUMN platform_fee_bps integer CHECK (platform_fee_bps BETWEEN 0 AND 1000),
  ADD COLUMN platform_fee_base_minor bigint CHECK (platform_fee_base_minor >= 0),
  ADD CONSTRAINT trade_economics_platform_fee_shape CHECK ((platform_fee_bps IS NULL) = (platform_fee_base_minor IS NULL)
    AND (platform_fee_bps IS NULL OR route_base_minor IS NOT NULL));

-- IX125 (FI-99): a desk deal is priced on the desk's own P2P route at the desk's own rate, and its whole margin is the
-- platform's fee — the current policy's basis points of the client's USDT, rounded up. A deal outside a desk has no fee.
CREATE FUNCTION inrp2p_guard_desk_quote() RETURNS trigger
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
     OR NEW.gross_margin_base_minor IS DISTINCT FROM NEW.platform_fee_base_minor
     OR NEW.route_rate_micro <> NEW.client_rate_micro THEN
    RAISE EXCEPTION 'desk deal % must be priced at the desk''s rate with the platform''s fee as its whole margin', NEW.ref USING ERRCODE = 'IX125';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER quote_desk_terms BEFORE INSERT ON quote
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_desk_quote();

-- IX045: copied values equal the accepted quote exactly — the trader's USDT side and the platform's fee included.
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
     OR q.platform_fee_bps IS DISTINCT FROM NEW.platform_fee_bps OR q.platform_fee_base_minor IS DISTINCT FROM NEW.platform_fee_base_minor THEN
    RAISE EXCEPTION 'trade economics for % do not equal the accepted quote', NEW.trade_id USING ERRCODE = 'IX045';
  END IF;
  RETURN NEW;
END
$$;

-- 7. The network fee of a P2P deal is its trader's -------------------------------------------------------------------

-- FI-90 / FI-97 (revised): on a P2P route the route's trader funds the deal's transfers from its network deposit, so the
-- fee is not taken from the platform's margin: the net margin is the USDT margin itself, and no reward is counted.
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

-- 8. Deal links -------------------------------------------------------------------------------------------------------

CREATE SEQUENCE desk_deal_link_ref_seq;
CREATE TABLE desk_deal_link (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  ref               text NOT NULL UNIQUE DEFAULT ('DL-' || inrp2p_ref_number(nextval('desk_deal_link_ref_seq'), 4)),
  desk_id           uuid NOT NULL REFERENCES desk (id),
  -- The link's secret is never stored: only its hash, as for quote links.
  token_hash        text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  direction         text NOT NULL CHECK (direction IN ('SELL_USDT', 'BUY_USDT')),
  fixed_side        text NOT NULL CHECK (fixed_side IN ('BASE', 'QUOTE')),
  -- In the fixed side's currency: micro-USDT (BASE) or paise (QUOTE).
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  rate_micro        bigint NOT NULL CHECK (rate_micro > 0),
  -- The desk's own label for whom it made the link; shown to the desk only.
  note              text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 140),
  expires_at        timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLAIMED', 'REVOKED')),
  claimed_client_id uuid REFERENCES client (id),
  claimed_at        timestamptz,
  created_by        uuid NOT NULL REFERENCES auth_user (id),
  created_at        timestamptz NOT NULL DEFAULT inrp2p_now(),
  revoked_by        text,
  revoked_at        timestamptz,
  revoke_reason     text CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 500),
  version           integer NOT NULL DEFAULT 1,
  CHECK (expires_at > created_at),
  CHECK ((claimed_client_id IS NULL) = (claimed_at IS NULL)),
  CHECK (status <> 'CLAIMED' OR claimed_client_id IS NOT NULL),
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL AND revoked_by IS NOT NULL))
);
CREATE INDEX desk_deal_link_desk_idx ON desk_deal_link (desk_id, created_at DESC);
CREATE TRIGGER desk_deal_link_status BEFORE UPDATE ON desk_deal_link
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'OPEN>CLAIMED,OPEN>REVOKED,CLAIMED>REVOKED');
CREATE TRIGGER desk_deal_link_immutable BEFORE UPDATE ON desk_deal_link
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'claimed_client_id', 'claimed_at', 'revoked_by', 'revoked_at', 'revoke_reason', 'version');
CREATE TRIGGER desk_deal_link_no_delete BEFORE DELETE OR TRUNCATE ON desk_deal_link
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- IX126: whoever claimed a link keeps it; the claim is made once.
CREATE FUNCTION inrp2p_guard_desk_deal_link() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.claimed_client_id IS NOT NULL AND NEW.claimed_client_id IS DISTINCT FROM OLD.claimed_client_id THEN
    RAISE EXCEPTION 'deal link % is already taken', OLD.ref USING ERRCODE = 'IX126';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER desk_deal_link_guard BEFORE UPDATE ON desk_deal_link
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_desk_deal_link();

-- A request made from a link (insert-once, like the rest of the request).
ALTER TABLE trade_request ADD COLUMN desk_deal_link_id uuid REFERENCES desk_deal_link (id);
-- One open request per link at a time: a client asking again while its price is still being decided gets that one.
CREATE UNIQUE INDEX trade_request_one_open_per_link ON trade_request (desk_deal_link_id) WHERE desk_deal_link_id IS NOT NULL AND status IN ('OPEN', 'QUOTED');

-- IX126: a request from a link is the link's own deal — its desk, the client who claimed it, its direction and amount —
-- while the link is claimed and unexpired, and only while the link has not already become a trade.
CREATE FUNCTION inrp2p_guard_link_request() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  l desk_deal_link%ROWTYPE;
BEGIN
  IF NEW.desk_deal_link_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO l FROM desk_deal_link WHERE id = NEW.desk_deal_link_id;
  IF l.desk_id IS DISTINCT FROM NEW.desk_id OR l.status <> 'CLAIMED' OR l.claimed_client_id IS DISTINCT FROM NEW.client_id
     OR l.expires_at <= inrp2p_now() OR l.direction <> NEW.direction OR l.fixed_side <> NEW.fixed_side
     OR l.amount_minor <> (CASE WHEN NEW.fixed_side = 'BASE' THEN NEW.requested_base_minor ELSE NEW.requested_quote_minor END) THEN
    RAISE EXCEPTION 'request is not deal link %''s own deal', l.ref USING ERRCODE = 'IX126';
  END IF;
  IF EXISTS (SELECT 1 FROM trade_request WHERE desk_deal_link_id = NEW.desk_deal_link_id AND status = 'ACCEPTED') THEN
    RAISE EXCEPTION 'deal link % has already become a trade', l.ref USING ERRCODE = 'IX126';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trade_request_deal_link BEFORE INSERT ON trade_request
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_link_request();

-- IX126: a quote of a link's request is at the link's own rate.
CREATE FUNCTION inrp2p_guard_link_quote() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  link_rate bigint;
BEGIN
  SELECT l.rate_micro INTO link_rate FROM trade_request r JOIN desk_deal_link l ON l.id = r.desk_deal_link_id WHERE r.id = NEW.trade_request_id;
  IF link_rate IS NOT NULL AND link_rate <> NEW.client_rate_micro THEN
    RAISE EXCEPTION 'a deal link''s quote is at the rate on the link' USING ERRCODE = 'IX126';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER quote_deal_link BEFORE INSERT ON quote
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_link_quote();

-- 9. The team ---------------------------------------------------------------------------------------------------------

-- An administrator of a client (a desk's trader is a client) invites a person by email. The person signs in with that
-- email — a code to it is the only way in — and accepts: they become a user of the client with the invite's role.
-- `ADMIN` = CLIENT_ADMIN, `OPERATOR` = CLIENT_TRADER; both can bind the client (`can_accept_quotes`). No secret is sent:
-- a forwarded invitation lets no one else in.
CREATE TABLE client_invite (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  client_id               uuid NOT NULL REFERENCES client (id),
  email                   text NOT NULL CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254 AND email ~ '^[^@\s]+@[^@\s]+$'),
  role                    text NOT NULL CHECK (role IN ('ADMIN', 'OPERATOR')),
  invited_by              uuid NOT NULL REFERENCES client_user (id),
  expires_at              timestamptz NOT NULL,
  status                  text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'REVOKED')),
  accepted_client_user_id uuid REFERENCES client_user (id),
  accepted_at             timestamptz,
  revoked_by              text,
  revoked_at              timestamptz,
  revoke_reason           text CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 200),
  -- The invitation email: sent once, under the invite's own id as the provider's idempotency key.
  email_sent_at           timestamptz,
  email_message_id        text CHECK (email_message_id IS NULL OR length(email_message_id) <= 200),
  created_at              timestamptz NOT NULL DEFAULT inrp2p_now(),
  CHECK (expires_at > created_at),
  CHECK ((status = 'ACCEPTED') = (accepted_client_user_id IS NOT NULL AND accepted_at IS NOT NULL)),
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL AND revoked_by IS NOT NULL))
);
CREATE INDEX client_invite_client_idx ON client_invite (client_id, created_at DESC);
CREATE INDEX client_invite_email_idx ON client_invite (email) WHERE status = 'PENDING';
-- One waiting invitation per person per client: inviting again replaces it.
CREATE UNIQUE INDEX client_invite_one_pending ON client_invite (client_id, email) WHERE status = 'PENDING';
CREATE TRIGGER client_invite_status BEFORE UPDATE ON client_invite
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'PENDING>ACCEPTED,PENDING>REVOKED');
CREATE TRIGGER client_invite_immutable BEFORE UPDATE ON client_invite
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'accepted_client_user_id', 'accepted_at', 'revoked_by', 'revoked_at', 'revoke_reason', 'email_sent_at', 'email_message_id');
CREATE TRIGGER client_invite_no_delete BEFORE DELETE OR TRUNCATE ON client_invite
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- IX127: an invitation comes from an active administrator of an active client, and is accepted — before it expires — by
-- the person it names: an active user of that same client whose email it is.
CREATE FUNCTION inrp2p_guard_client_invite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM client_user cu JOIN client c ON c.id = cu.client_id
                    WHERE cu.id = NEW.invited_by AND cu.client_id = NEW.client_id AND cu.role = 'CLIENT_ADMIN' AND cu.status = 'ACTIVE' AND c.status = 'ACTIVE') THEN
      RAISE EXCEPTION 'only an active administrator of an active client invites to its team' USING ERRCODE = 'IX127';
    END IF;
  ELSIF NEW.status = 'ACCEPTED' AND OLD.status = 'PENDING' THEN
    IF inrp2p_now() >= OLD.expires_at THEN
      RAISE EXCEPTION 'this invitation has expired' USING ERRCODE = 'IX127';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM client_user cu JOIN auth_user u ON u.id = cu.user_id
                    WHERE cu.id = NEW.accepted_client_user_id AND cu.client_id = NEW.client_id AND cu.status = 'ACTIVE'
                      AND u.kind = 'CLIENT' AND u.email_verified AND lower(u.email) = NEW.email) THEN
      RAISE EXCEPTION 'an invitation is accepted only by the person it names, as a user of its client' USING ERRCODE = 'IX127';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER client_invite_guard BEFORE INSERT OR UPDATE ON client_invite
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_client_invite();

-- Everyone on the team hears when someone joins, changes role or leaves.
ALTER TABLE client_notification DROP CONSTRAINT client_notification_kind_check;
ALTER TABLE client_notification ADD CONSTRAINT client_notification_kind_check CHECK (kind IN (
  'QUOTE_SENT', 'QUOTE_EXPIRED', 'REQUEST_DECLINED', 'TRADE_OPENED', 'PAYOUT_CONFIRMED', 'TRADE_COMPLETED', 'TRADE_CANCELLED',
  'DESTINATION_ADDED', 'DESTINATION_ARCHIVED', 'TRADE_DESTINATION_CHANGED',
  'TRADER_APPROVED', 'TRADER_REJECTED', 'TRADER_PAUSED', 'TRADER_RESUMED', 'TRADER_ORDER_NEW', 'TRADER_ORDER_ACCEPTED',
  'TRADER_ACTION_REQUIRED', 'TRADER_PAYMENT_CONFIRMED', 'TRADER_ORDER_COMPLETED', 'TRADER_ORDER_CLOSED', 'TRADER_RESERVE_ISSUE',
  'PAYMENT_RETURNED', 'TEAM_CHANGED'));

-- 10. Telegram -----------------------------------------------------------------------------------------------------

-- A person links their Telegram chat to their sign-in: the workspace hands them a one-time code (only its hash is kept,
-- valid fifteen minutes), they send it to the bot (`/start <code>`), and the chat is theirs until they or the bot's
-- refusal end it. Alerts go only to ACTIVE links of active users. A chat id is not a secret — it is useless without the
-- bot's token — so it is kept as it is.
CREATE TABLE telegram_link (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  client_user_id  uuid NOT NULL REFERENCES client_user (id),
  code_hash       text UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  code_expires_at timestamptz,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'REVOKED')),
  chat_id         bigint,
  username        text CHECK (username IS NULL OR length(username) BETWEEN 1 AND 64),
  created_at      timestamptz NOT NULL DEFAULT inrp2p_now(),
  linked_at       timestamptz,
  revoked_at      timestamptz,
  revoke_reason   text CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 200),
  CHECK (status <> 'PENDING' OR (code_hash IS NOT NULL AND code_expires_at IS NOT NULL AND chat_id IS NULL)),
  CHECK (status <> 'ACTIVE' OR (chat_id IS NOT NULL AND linked_at IS NOT NULL)),
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX telegram_link_one_active ON telegram_link (client_user_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX telegram_link_one_pending ON telegram_link (client_user_id) WHERE status = 'PENDING';
CREATE INDEX telegram_link_chat_idx ON telegram_link (chat_id) WHERE status = 'ACTIVE';
CREATE TRIGGER telegram_link_status BEFORE UPDATE ON telegram_link
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'PENDING>ACTIVE,PENDING>REVOKED,ACTIVE>REVOKED');
CREATE TRIGGER telegram_link_immutable BEFORE UPDATE ON telegram_link
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'chat_id', 'username', 'linked_at', 'revoked_at', 'revoke_reason');
CREATE TRIGGER telegram_link_no_delete BEFORE DELETE OR TRUNCATE ON telegram_link
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- One alert to one chat, sent once: its id is derived from what it is about and the link (a redelivered event sends the
-- same message), SENT only with Telegram's message id, FAILED after the bot was refused or the attempts ran out.
CREATE TABLE telegram_delivery (
  id                  uuid PRIMARY KEY,
  telegram_link_id    uuid NOT NULL REFERENCES telegram_link (id),
  dedupe_key          text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  body                text NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  button_url          text CHECK (button_url IS NULL OR (button_url ~ '^https?://' AND length(button_url) <= 500)),
  status              text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  provider_message_id text CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 64),
  last_error          text CHECK (last_error IS NULL OR length(last_error) <= 80),
  created_at          timestamptz NOT NULL DEFAULT inrp2p_now(),
  sent_at             timestamptz,
  failed_at           timestamptz,
  UNIQUE (telegram_link_id, dedupe_key),
  CHECK ((status = 'SENT') = (sent_at IS NOT NULL AND provider_message_id IS NOT NULL)),
  CHECK ((status = 'FAILED') = (failed_at IS NOT NULL))
);
CREATE INDEX telegram_delivery_open_idx ON telegram_delivery (status, created_at) WHERE status = 'PENDING';
CREATE TRIGGER telegram_delivery_status BEFORE UPDATE ON telegram_delivery
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'PENDING>SENT,PENDING>FAILED');
CREATE TRIGGER telegram_delivery_immutable BEFORE UPDATE ON telegram_delivery
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'attempts', 'provider_message_id', 'last_error', 'sent_at', 'failed_at');
CREATE TRIGGER telegram_delivery_no_delete BEFORE DELETE OR TRUNCATE ON telegram_delivery
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- 11. P2P disputes and unwinds (block 9, TD-35) ------------------------------------------------------------------------

-- The one who received a P2P payment — always the seller of the USDT — says the rupees did not arrive. The deal stops (a
-- blocking `P2P_DISPUTE` case holds the trade) and INRP2P decides from the payee's bank: paid — the escrow releases as if
-- the payee had confirmed — or not paid — the deal unwinds. One dispute per payment, ever: a decision is final. What each
-- side writes goes to INRP2P only, never to the other side.
ALTER TABLE exception_case DROP CONSTRAINT exception_case_type_check;
ALTER TABLE exception_case ADD CONSTRAINT exception_case_type_check CHECK (type IN (
  'USDT_WRONG_AMOUNT', 'USDT_OVERPAYMENT', 'USDT_UNEXPECTED_SENDER', 'WRONG_NETWORK', 'TX_NOT_FINAL',
  'ROUTE_DIRECT_PAYOUT_MISMATCH', 'FUNDS_AFTER_TRADE_CLOSED', 'UNALLOCATED_DEPOSIT', 'DEPOSIT_POOL_LOW',
  'ROUTE_SETTLEMENT_MISMATCH', 'ROUTE_OBLIGATION_OVERDUE', 'DUPLICATE_TX_HASH', 'DUPLICATE_UTR',
  'PARTIAL_INR_PAYOUT', 'INR_PAYOUT_DELAYED', 'BANK_TRANSFER_FAILED', 'CLIENT_BANK_CHANGED',
  'ROUTE_CAPACITY_CHANGED', 'TRADE_CANCELLATION', 'OPERATOR_MISTAKE', 'RECONCILIATION_MISMATCH',
  'CHAIN_SEND_UNRESOLVED', 'NETWORK_BUDGET_SHORT', 'INR_UNEXPECTED_SENDER',
  'P2P_PAYMENT_OVERDUE', 'P2P_RECEIPT_OVERDUE', 'P2P_DISPUTE'));

CREATE SEQUENCE p2p_dispute_ref_seq;
CREATE TABLE p2p_dispute (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  ref                text NOT NULL UNIQUE DEFAULT ('DSP-' || inrp2p_ref_number(nextval('p2p_dispute_ref_seq'), 4)),
  trade_id           uuid NOT NULL REFERENCES trade (id),
  settlement_leg_id  uuid NOT NULL UNIQUE REFERENCES settlement_leg (id),
  exception_case_id  uuid NOT NULL UNIQUE REFERENCES exception_case (id),
  payee              text NOT NULL CHECK (payee IN ('CLIENT', 'TRADER')),
  reason             text NOT NULL CHECK (reason IN ('NO_CREDIT', 'WRONG_AMOUNT', 'OTHER')),
  payee_note         text CHECK (payee_note IS NULL OR length(payee_note) BETWEEN 1 AND 1000),
  opened_by          uuid NOT NULL REFERENCES auth_user (id),
  payer_note         text CHECK (payer_note IS NULL OR length(payer_note) BETWEEN 1 AND 1000),
  payer_noted_by     uuid REFERENCES auth_user (id),
  payer_noted_at     timestamptz,
  status             text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'PAID', 'NOT_PAID')),
  decided_via        text CHECK (decided_via IN ('INRP2P', 'PAYEE')),
  decided_by         text CHECK (decided_by IS NULL OR length(decided_by) <= 120),
  decided_at         timestamptz,
  decision_notes     text CHECK (decision_notes IS NULL OR length(decision_notes) BETWEEN 1 AND 2000),
  created_at         timestamptz NOT NULL DEFAULT inrp2p_now(),
  CHECK (reason <> 'OTHER' OR payee_note IS NOT NULL),
  CHECK ((payer_note IS NULL) = (payer_noted_at IS NULL) AND (payer_note IS NULL) = (payer_noted_by IS NULL)),
  CHECK ((status = 'OPEN') = (decided_at IS NULL)),
  CHECK (status = 'OPEN' OR (decided_via IS NOT NULL AND decided_by IS NOT NULL)),
  CHECK (decided_via IS DISTINCT FROM 'PAYEE' OR status = 'PAID')
);
CREATE INDEX p2p_dispute_trade_idx ON p2p_dispute (trade_id);
CREATE TRIGGER p2p_dispute_status BEFORE UPDATE ON p2p_dispute
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'OPEN>PAID,OPEN>NOT_PAID');
CREATE TRIGGER p2p_dispute_immutable BEFORE UPDATE ON p2p_dispute
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('payer_note', 'payer_noted_by', 'payer_noted_at', 'status', 'decided_via', 'decided_by', 'decided_at', 'decision_notes');
CREATE TRIGGER p2p_dispute_no_delete BEFORE DELETE OR TRUNCATE ON p2p_dispute
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- IX128: a dispute is about one rupee payment of a P2P trade, opened by the side that receives it (the client receives the
-- trader's payout, the trader the client's payment) while it waits for that side's confirmation, with the blocking case
-- of that payment; once decided, nothing of it changes.
CREATE FUNCTION inrp2p_guard_p2p_dispute() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM settlement_leg l JOIN trade_economics e ON e.trade_id = l.trade_id
       WHERE l.id = NEW.settlement_leg_id AND l.trade_id = NEW.trade_id AND l.asset = 'INR' AND l.status = 'PROCESSING'
         AND e.route_execution_mode = 'P2P'
         AND CASE NEW.payee WHEN 'CLIENT' THEN l.side = 'EXCHANGE_TO_CLIENT' AND l.payer = 'ROUTE' ELSE l.side = 'CLIENT_TO_EXCHANGE' END) THEN
      RAISE EXCEPTION 'a dispute is opened by the payee of a P2P payment that waits for its confirmation' USING ERRCODE = 'IX128';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM exception_case c WHERE c.id = NEW.exception_case_id AND c.type = 'P2P_DISPUTE' AND c.subject_type = 'SETTLEMENT_LEG'
                    AND c.subject_id = NEW.settlement_leg_id AND c.trade_id = NEW.trade_id AND c.severity = 'BLOCKING') THEN
      RAISE EXCEPTION 'a dispute holds its trade through the blocking case of its payment' USING ERRCODE = 'IX128';
    END IF;
  ELSIF OLD.status <> 'OPEN' THEN
    RAISE EXCEPTION 'dispute % is decided', OLD.ref USING ERRCODE = 'IX128';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER p2p_dispute_guard BEFORE INSERT OR UPDATE ON p2p_dispute
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_p2p_dispute();

-- A client's USDT goes back from the escrow of a SELL whose trader did not pay — in time, or at all (INRP2P decided "not
-- paid"). Recorded once, by the deadline or by the decision. From then on the trader cannot file a payment; the worker
-- returns the USDT to the registered wallet it came from (a refund the trader's network deposit pays for, approved by a
-- second person over the threshold), and cancels the trade once it is back.
CREATE TABLE p2p_unwind (
  trade_id        uuid PRIMARY KEY REFERENCES trade (id),
  reason          text NOT NULL CHECK (reason IN ('PAY_WINDOW_MISSED', 'NOT_PAID')),
  p2p_dispute_id  uuid UNIQUE REFERENCES p2p_dispute (id),
  refund_leg_id   uuid UNIQUE REFERENCES settlement_leg (id),
  waiting_reason  text CHECK (waiting_reason IS NULL OR length(waiting_reason) BETWEEN 1 AND 300),
  decided_by      text NOT NULL CHECK (length(decided_by) BETWEEN 1 AND 120),
  created_at      timestamptz NOT NULL DEFAULT inrp2p_now(),
  updated_at      timestamptz NOT NULL DEFAULT inrp2p_now(),
  -- Not paid is INRP2P's decision — on a dispute, or on a payment its payee never answered.
  CHECK (reason <> 'PAY_WINDOW_MISSED' OR p2p_dispute_id IS NULL)
);
CREATE TRIGGER p2p_unwind_immutable BEFORE UPDATE ON p2p_unwind
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('refund_leg_id', 'waiting_reason', 'updated_at');
CREATE TRIGGER p2p_unwind_no_delete BEFORE DELETE OR TRUNCATE ON p2p_unwind
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- IX129: only a P2P client's SELL unwinds, and its refund is a full return of the client's USDT; a trade being unwound
-- takes no payment of the trader any more.
CREATE FUNCTION inrp2p_guard_p2p_unwind() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM trade t JOIN trade_economics e ON e.trade_id = t.id
     WHERE t.id = NEW.trade_id AND t.direction = 'SELL_USDT' AND e.route_execution_mode = 'P2P'
       AND t.lifecycle_state NOT IN ('COMPLETED', 'CANCELLED')) THEN
    RAISE EXCEPTION 'only an open P2P SELL unwinds' USING ERRCODE = 'IX129';
  END IF;
  IF NEW.refund_leg_id IS NOT NULL AND NEW.refund_leg_id IS DISTINCT FROM OLD.refund_leg_id AND NOT EXISTS (
    SELECT 1 FROM settlement_leg l WHERE l.id = NEW.refund_leg_id AND l.trade_id = NEW.trade_id AND l.side = 'REFUND_TO_CLIENT'
       AND l.asset = 'USDT' AND l.refund_kind = 'UNWIND') THEN
    RAISE EXCEPTION 'an unwind is refunded by a full USDT refund of its own trade' USING ERRCODE = 'IX129';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER p2p_unwind_guard BEFORE INSERT OR UPDATE ON p2p_unwind
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_p2p_unwind();

CREATE FUNCTION inrp2p_guard_payout_after_unwind() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM p2p_unwind u WHERE u.trade_id = NEW.trade_id) THEN
    RAISE EXCEPTION 'the payment window of this deal is closed: its USDT goes back to the client' USING ERRCODE = 'IX129';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER settlement_leg_after_unwind BEFORE INSERT ON settlement_leg
  FOR EACH ROW WHEN (NEW.side = 'EXCHANGE_TO_CLIENT') EXECUTE FUNCTION inrp2p_guard_payout_after_unwind();

-- Both sides hear of a dispute and of its decision; a client hears that its USDT is coming back.
ALTER TABLE client_notification DROP CONSTRAINT client_notification_kind_check;
ALTER TABLE client_notification ADD CONSTRAINT client_notification_kind_check CHECK (kind IN (
  'QUOTE_SENT', 'QUOTE_EXPIRED', 'REQUEST_DECLINED', 'TRADE_OPENED', 'PAYOUT_CONFIRMED', 'TRADE_COMPLETED', 'TRADE_CANCELLED',
  'DESTINATION_ADDED', 'DESTINATION_ARCHIVED', 'TRADE_DESTINATION_CHANGED',
  'TRADER_APPROVED', 'TRADER_REJECTED', 'TRADER_PAUSED', 'TRADER_RESUMED', 'TRADER_ORDER_NEW', 'TRADER_ORDER_ACCEPTED',
  'TRADER_ACTION_REQUIRED', 'TRADER_PAYMENT_CONFIRMED', 'TRADER_ORDER_COMPLETED', 'TRADER_ORDER_CLOSED', 'TRADER_RESERVE_ISSUE',
  'PAYMENT_RETURNED', 'TEAM_CHANGED', 'P2P_DISPUTE_OPENED', 'P2P_DISPUTE_DECIDED', 'P2P_REFUND', 'DESK_NOTICE'));

-- 12. INRP2P's fees off the deal addresses (block 10, TD-31, TD-36) --------------------------------------------------

-- A completed trade leaves INRP2P's earnings — its USDT margin, a desk's platform fee — at the deal address the money
-- moved through, and the TRX its transfers did not burn. Once no trade uses the address, the signer sweeps the USDT to
-- the platform's revenue wallet (paid from the platform's TRX budget, only when an address has earned enough to be
-- worth it) and sends the TRX back to the budget wallet, credited to whoever paid for it.

-- The platform's own USDT wallet: where its earnings go. One at a time; registered watch-only, like every wallet.
ALTER TABLE treasury_wallet DROP CONSTRAINT treasury_wallet_role_check;
ALTER TABLE treasury_wallet ADD CONSTRAINT treasury_wallet_role_check CHECK (role IN ('HOT', 'COLD', 'DEPOSIT_POOL', 'TRADER_RESERVE', 'NETWORK_BUDGET', 'REVENUE'));
CREATE UNIQUE INDEX treasury_wallet_one_revenue ON treasury_wallet ((true)) WHERE role = 'REVENUE' AND status = 'ACTIVE';

ALTER TABLE chain_send DROP CONSTRAINT chain_send_purpose_check;
ALTER TABLE chain_send ADD CONSTRAINT chain_send_purpose_check
  CHECK (purpose IN ('CLIENT_PAYOUT', 'REFUND', 'ROUTE_PAYMENT', 'ESCROW_RETURN', 'TOPUP', 'DEPOSIT_WITHDRAWAL', 'FEE_SWEEP', 'TRX_RECLAIM'));
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'chain_send'::regclass AND contype = 'c'
              AND (pg_get_constraintdef(oid) LIKE '%''TOPUP''::text, ''DEPOSIT_WITHDRAWAL''::text])) = (asset = ''TRX''::text)%'
                   OR pg_get_constraintdef(oid) LIKE '%(purpose = ''DEPOSIT_WITHDRAWAL''::text) OR (trade_id IS NOT NULL)%')
  LOOP
    EXECUTE format('ALTER TABLE chain_send DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;
ALTER TABLE chain_send ADD CONSTRAINT chain_send_trx_purpose_check CHECK ((purpose IN ('TOPUP', 'DEPOSIT_WITHDRAWAL', 'TRX_RECLAIM')) = (asset = 'TRX'));
-- A sweep names the latest trade whose earnings it carries (its lock, its key); a reclaim is of no trade.
ALTER TABLE chain_send ADD CONSTRAINT chain_send_trade_check CHECK (purpose IN ('DEPOSIT_WITHDRAWAL', 'TRX_RECLAIM') OR trade_id IS NOT NULL);
ALTER TABLE chain_send ADD CONSTRAINT chain_send_platform_check CHECK (purpose NOT IN ('FEE_SWEEP', 'TRX_RECLAIM') OR (funder_trader_id IS NULL AND bearer = 'PLATFORM'));
-- One of the platform's own sends at a time per address: what it holds is read once and moved once.
CREATE UNIQUE INDEX chain_send_one_live_own_send ON chain_send (from_address) WHERE purpose IN ('FEE_SWEEP', 'TRX_RECLAIM') AND status NOT IN ('CONFIRMED', 'CANCELLED');

ALTER TABLE funding_allocation DROP CONSTRAINT funding_allocation_use_kind_check;
ALTER TABLE funding_allocation ADD CONSTRAINT funding_allocation_use_kind_check CHECK (use_kind IN ('CLIENT_PAYOUT', 'REFUND', 'ROUTE_PAYMENT', 'ESCROW_RETURN', 'FEE_SWEEP'));
ALTER TABLE funding_allocation DROP CONSTRAINT funding_allocation_route_use_check;
ALTER TABLE funding_allocation ADD CONSTRAINT funding_allocation_route_use_check
  CHECK ((use_kind = 'ROUTE_PAYMENT') = (use_leg_id IS NULL AND use_kind NOT IN ('ESCROW_RETURN', 'FEE_SWEEP') AND ((use_route_settlement_id IS NOT NULL) <> (use_chain_send_id IS NOT NULL))));
-- A fee sweep is the signer's send, of USDT, from whichever of the trade's own sources is free at the address.
ALTER TABLE funding_allocation ADD CONSTRAINT funding_allocation_fee_sweep_check
  CHECK (use_kind <> 'FEE_SWEEP' OR (use_chain_send_id IS NOT NULL AND use_leg_id IS NULL AND use_route_settlement_id IS NULL AND asset = 'USDT'));

-- IX130: what of a trade's own USDT at one address INRP2P has earned and may sweep. Nothing until the trade is completed,
-- its route obligation over and no case of it open; then what is still free of its sources there — never more than its
-- USDT margin, less what was swept already. A cancelled trade's money is never anyone's earnings.
CREATE FUNCTION inrp2p_trade_sweepable(p_trade uuid, p_location text) RETURNS bigint
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
                               WHERE a.trade_id = t.id AND a.use_kind = 'FEE_SWEEP' AND a.status IN ('ACTIVE', 'CONSUMED')), 0)), 0)
              ELSE 0 END
    FROM trade t LEFT JOIN trade_economics e ON e.trade_id = t.id
   WHERE t.id = p_trade
$$;

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
    IF EXISTS (SELECT 1 FROM deposit_address d WHERE d.network = 'TRON' AND d.address = NEW.from_address AND d.status = 'ASSIGNED') THEN
      RAISE EXCEPTION 'TRX is reclaimed only from a deal address no trade is using' USING ERRCODE = 'IX106';
    END IF;
    expected_to := (SELECT w.address::text FROM treasury_wallet w WHERE w.role = 'NETWORK_BUDGET' AND w.status = 'ACTIVE');
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
  expected_path := CASE WHEN NEW.asset = 'USDT' OR NEW.purpose = 'TRX_RECLAIM'
    THEN (SELECT d.custody_reference FROM deposit_address d JOIN custody_hd_account h ON h.provider = d.provider
           WHERE d.network = 'TRON' AND d.address = NEW.from_address AND d.source = 'DERIVED')
    ELSE (SELECT h.fee_wallet_path FROM custody_hd_account h WHERE h.fee_wallet_address = NEW.from_address) END;
  IF expected_path IS DISTINCT FROM NEW.from_path THEN
    RAISE EXCEPTION 'send % leaves % which the custody HD account did not issue under %', NEW.purpose, NEW.from_address, NEW.from_path USING ERRCODE = 'IX106';
  END IF;
  -- IX115: a trade's USDT sends together never draw more than the trade holds; one that would not fit is not planned.
  -- A fee sweep is the platform's own transfer, paid from its budget at the top-up (IX108), not from the trade's hold.
  IF NEW.asset = 'USDT' AND NEW.purpose <> 'FEE_SWEEP' AND inrp2p_trade_network_committed(NEW.trade_id, NULL) + NEW.network_cap_sun
       > coalesce((SELECT amount_sun FROM network_budget_hold WHERE trade_id = NEW.trade_id AND status = 'ACTIVE'), 0) THEN
    RAISE EXCEPTION 'send % of trade % needs a TRX cap of % sun that its hold no longer has', NEW.purpose, NEW.trade_id, NEW.network_cap_sun USING ERRCODE = 'IX115';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION inrp2p_guard_chain_send_funder() RETURNS trigger
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
  -- Block 10: a fee sweep, its top-up and a TRX reclaim are the platform's own — its TRX, never a trader's.
  IF NEW.purpose IN ('FEE_SWEEP', 'TRX_RECLAIM')
     OR (NEW.purpose = 'TOPUP' AND (SELECT purpose FROM chain_send WHERE id = NEW.parent_send_id) = 'FEE_SWEEP') THEN
    IF NEW.funder_trader_id IS NOT NULL THEN
      RAISE EXCEPTION 'a % is paid from the platform''s budget', lower(NEW.purpose) USING ERRCODE = 'IX109';
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
    SELECT s.trade_id, s.asset, s.purpose = NEW.use_kind AND s.purpose IN ('ROUTE_PAYMENT', 'ESCROW_RETURN', 'FEE_SWEEP'), 'TRON:' || s.from_address::text
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

-- The TRX a deal address's transfers did not burn comes back to whoever paid for it (TD-31): a `RECLAIM` of the budget.
ALTER TABLE network_budget_entry DROP CONSTRAINT network_budget_entry_kind_check;
ALTER TABLE network_budget_entry ADD CONSTRAINT network_budget_entry_kind_check CHECK (kind IN ('DEPOSIT', 'WITHDRAWAL', 'SPENT', 'ADJUSTMENT', 'RECLAIM'));
ALTER TABLE network_budget_entry ADD CONSTRAINT network_budget_entry_reclaim_check CHECK (kind <> 'RECLAIM' OR (amount_sun > 0 AND chain_send_attempt_id IS NOT NULL));

-- When a sweep is worth its TRX, and when a reclaim is: part of the network policy, set like the rest of it.
ALTER TABLE network_fee_policy
  ADD COLUMN fee_sweep_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN fee_sweep_min_usdt_minor bigint NOT NULL DEFAULT 20000000 CHECK (fee_sweep_min_usdt_minor BETWEEN 1000000 AND 100000000000),
  ADD COLUMN trx_reclaim_min_sun bigint NOT NULL DEFAULT 1000000 CHECK (trx_reclaim_min_sun BETWEEN 100000 AND 100000000);

-- Grants -------------------------------------------------------------------------------------------------------------

GRANT SELECT, INSERT ON fee_policy, desk, desk_price, desk_client, desk_deal_link, client_invite TO inrp2p_app;
GRANT UPDATE (status, accepted_client_user_id, accepted_at, revoked_by, revoked_at, revoke_reason, email_sent_at, email_message_id) ON client_invite TO inrp2p_app;
GRANT SELECT, INSERT ON telegram_link, telegram_delivery TO inrp2p_app;
GRANT UPDATE (status, chat_id, username, linked_at, revoked_at, revoke_reason) ON telegram_link TO inrp2p_app;
GRANT UPDATE (status, attempts, provider_message_id, last_error, sent_at, failed_at) ON telegram_delivery TO inrp2p_app;
GRANT SELECT (id, client_user_id, status, username, created_at, linked_at, revoked_at, revoke_reason) ON telegram_link TO inrp2p_readonly;
GRANT SELECT (id, telegram_link_id, dedupe_key, status, attempts, last_error, created_at, sent_at, failed_at) ON telegram_delivery TO inrp2p_readonly;
GRANT UPDATE (status, claimed_client_id, claimed_at, revoked_by, revoked_at, revoke_reason, version) ON desk_deal_link TO inrp2p_app;
GRANT USAGE ON SEQUENCE desk_deal_link_ref_seq TO inrp2p_app;
GRANT UPDATE (handle, display_name, about, status, suspension_reason, suspended_at, page_hidden_reason, page_hidden_at, handle_moderated_at, updated_at, version) ON desk TO inrp2p_app;
GRANT UPDATE (status, max_deal_base_minor, note, updated_at, version) ON desk_client TO inrp2p_app;
GRANT SELECT ON fee_policy, desk, desk_price, desk_client TO inrp2p_readonly;
GRANT SELECT (id, ref, desk_id, direction, fixed_side, amount_minor, rate_micro, note, expires_at, status, claimed_client_id, claimed_at, created_by, created_at, revoked_by, revoked_at, revoke_reason, version) ON desk_deal_link TO inrp2p_readonly;
GRANT SELECT (desk_id, desk_deal_link_id) ON trade_request TO inrp2p_readonly;
GRANT SELECT (id, client_id, role, invited_by, expires_at, status, accepted_client_user_id, accepted_at, revoked_by, revoked_at, revoke_reason, email_sent_at, created_at) ON client_invite TO inrp2p_readonly;
GRANT SELECT (platform_fee_bps, platform_fee_base_minor) ON quote, trade_economics TO inrp2p_readonly;
GRANT EXECUTE ON FUNCTION inrp2p_platform_fee_bps(), inrp2p_desk_handle_reserved(text) TO inrp2p_app, inrp2p_readonly;
GRANT SELECT, INSERT ON p2p_dispute, p2p_unwind TO inrp2p_app;
GRANT UPDATE (payer_note, payer_noted_by, payer_noted_at, status, decided_via, decided_by, decided_at, decision_notes) ON p2p_dispute TO inrp2p_app;
GRANT UPDATE (refund_leg_id, waiting_reason, updated_at) ON p2p_unwind TO inrp2p_app;
GRANT USAGE ON SEQUENCE p2p_dispute_ref_seq TO inrp2p_app;
GRANT SELECT (id, ref, trade_id, settlement_leg_id, exception_case_id, payee, reason, opened_by, payer_noted_at, status, decided_via, decided_by, decided_at, created_at) ON p2p_dispute TO inrp2p_readonly;
GRANT SELECT ON p2p_unwind TO inrp2p_readonly;
GRANT EXECUTE ON FUNCTION inrp2p_trade_sweepable(uuid, text) TO inrp2p_app, inrp2p_readonly;
GRANT SELECT, INSERT ON fee_policy_proposal TO inrp2p_app;
GRANT UPDATE (status, decided_by, decided_at, decision_note, fee_policy_id) ON fee_policy_proposal TO inrp2p_app;
GRANT SELECT ON fee_policy_proposal TO inrp2p_readonly;
