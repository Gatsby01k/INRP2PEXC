-- 0029 applying a trader's Security Reserve to USDT it did not deliver (production task D3, TD-21).
--
-- A trader's Security Reserve was credited, locked and withdrawn, but nothing could use it. When a trader leaves the
-- USDT of one of its own orders undelivered, the desk may now apply the trader's reserve to that delivery: one
-- person asks, with the reason, another approves, each with step-up. Custody — the existing external mechanism; the
-- application never sends — moves that USDT from the trader's reserve address (or a treasury wallet) to the order's
-- own delivery address, and the movement is that order's delivery: one route settlement, one journal
-- (Dr LIAB:TRADER_RESERVE / Cr ASSET:ROUTE_RECEIVABLE). The client is then paid from it like from any delivery.
--
-- Only USDT the trader owes, only from that trader's own reserve, never beyond what the reserve holds free or the
-- order still owes. An INR shortfall would need a conversion rate the owner has not agreed: for it there is only a
-- HOLD — the same two people keep part of the reserve from being withdrawn while the INR debt stays open, nothing
-- moves and nothing posts, until the owner's terms exist. Taking a reserve for anything else would be a forfeiture:
-- also the owner's decision, not made here.
--
-- With it, a rule D-16 relied on is now stated in the database: a route's delivery is the route's own money — the
-- exchange's USDT or INR is never booked as a counterparty's delivery, except a reserve applied here.
--
-- Error codes IX094–IX095 belong to this migration. 0001–0028 are not edited.

CREATE SEQUENCE trader_reserve_application_ref_seq;
CREATE TABLE trader_reserve_application (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  ref                 text NOT NULL UNIQUE DEFAULT ('RA-' || inrp2p_ref_number(nextval('trader_reserve_application_ref_seq'), 6)),
  trader_id           uuid NOT NULL REFERENCES trader_profile (id),
  trader_order_id     uuid NOT NULL REFERENCES trader_order (id),
  route_obligation_id uuid NOT NULL REFERENCES route_obligation (id),
  -- APPLY: the reserve becomes the order's USDT delivery. HOLD: an INR shortfall; the reserve is only kept back.
  kind                text NOT NULL DEFAULT 'APPLY' CHECK (kind IN ('APPLY', 'HOLD')),
  -- USDT minor units, for both kinds: the reserve is USDT.
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  reason              text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  status              text NOT NULL DEFAULT 'REQUESTED'
                      CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'SENT', 'COMPLETED', 'FAILED')),
  requested_by        uuid NOT NULL REFERENCES auth_user (id),
  requested_at        timestamptz NOT NULL DEFAULT inrp2p_now(),
  -- The approval or the refusal: always someone other than the requester.
  decided_by          uuid REFERENCES auth_user (id),
  decided_at          timestamptz,
  decision_note       text CHECK (length(decision_note) <= 500),
  sent_at             timestamptz,
  completed_at        timestamptz,
  closed_at           timestamptz,
  closed_by           text,
  close_reason        text CHECK (length(close_reason) <= 500),
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
  CHECK (status IN ('REQUESTED', 'CANCELLED') OR decided_by IS NOT NULL),
  CHECK ((status IN ('SENT', 'COMPLETED', 'FAILED')) = (sent_at IS NOT NULL)),
  CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL)),
  CHECK ((status IN ('REJECTED', 'CANCELLED', 'COMPLETED', 'FAILED')) = (closed_at IS NOT NULL)),
  CHECK (status NOT IN ('REJECTED', 'CANCELLED', 'FAILED') OR close_reason IS NOT NULL),
  -- A hold never moves anything.
  CHECK (kind = 'APPLY' OR status NOT IN ('SENT', 'COMPLETED', 'FAILED'))
);
-- One live application per order: a second one waits until the first is finished either way.
CREATE UNIQUE INDEX trader_reserve_application_one_live ON trader_reserve_application (trader_order_id) WHERE status IN ('REQUESTED', 'APPROVED', 'SENT');
CREATE INDEX trader_reserve_application_trader_idx ON trader_reserve_application (trader_id, status);
CREATE TRIGGER trader_reserve_application_status BEFORE UPDATE ON trader_reserve_application
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status',
    'REQUESTED>APPROVED,REQUESTED>REJECTED,REQUESTED>CANCELLED,APPROVED>CANCELLED,APPROVED>SENT,SENT>COMPLETED,SENT>FAILED');
CREATE TRIGGER trader_reserve_application_immutable BEFORE UPDATE ON trader_reserve_application
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'decided_by', 'decided_at', 'decision_note', 'sent_at', 'completed_at', 'closed_at', 'closed_by', 'close_reason');
CREATE TRIGGER trader_reserve_application_no_delete BEFORE DELETE OR TRUNCATE ON trader_reserve_application
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- What the ledger owes a trader on its Security Reserve (a liability is a credit balance).
CREATE FUNCTION inrp2p_trader_reserve_balance(p_trader uuid) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT -b.dr_minus_cr_minor FROM ledger_account_balance b
                    WHERE b.code = 'LIAB:TRADER_RESERVE:' || p_trader::text AND b.currency = 'USDT'), 0)::bigint
$$;

-- The reserve that is free to be applied: the balance, less withdrawals on their way out and applications already
-- approved or in flight (other than the one being decided).
CREATE FUNCTION inrp2p_trader_reserve_free(p_trader uuid, p_except uuid) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT inrp2p_trader_reserve_balance(p_trader)
       - coalesce((SELECT sum(w.amount_minor) FROM trader_reserve_withdrawal w WHERE w.trader_id = p_trader AND w.status IN ('REQUESTED', 'SENT')), 0)
       - coalesce((SELECT sum(a.amount_minor) FROM trader_reserve_application a
                    WHERE a.trader_id = p_trader AND a.status IN ('APPROVED', 'SENT') AND a.id IS DISTINCT FROM p_except), 0)
$$;

-- What the route still owes on its delivering side: the side, less what is allocated, less deliveries recorded and
-- not yet confirmed.
CREATE FUNCTION inrp2p_route_delivery_open(p_obligation uuid) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT inrp2p_route_obligation_side(p_obligation, 'ROUTE_DELIVERS')
       - coalesce((SELECT sum(a.amount_minor) FROM route_settlement_allocation a WHERE a.route_obligation_id = p_obligation AND a.side = 'ROUTE_DELIVERS'), 0)
       - coalesce((SELECT sum(s.amount_minor) FROM route_settlement s
                    WHERE s.route_obligation_id = p_obligation AND s.obligation_side = 'ROUTE_DELIVERS' AND s.status = 'RECORDED'), 0)
$$;

CREATE FUNCTION inrp2p_guard_reserve_application() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o record;
  ob record;
  free bigint;
  open_delivery bigint;
  owed_asset text;
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (OLD.status = 'REQUESTED' AND NEW.status = 'APPROVED') THEN
    RETURN NEW;
  END IF;
  -- Serialized with the trader's withdrawals and its other applications.
  PERFORM 1 FROM trader_profile WHERE id = NEW.trader_id FOR UPDATE;
  SELECT t.trader_id, t.side, t.status, t.route_obligation_id INTO o FROM trader_order t WHERE t.id = NEW.trader_order_id;
  IF o.trader_id IS DISTINCT FROM NEW.trader_id OR o.route_obligation_id IS DISTINCT FROM NEW.route_obligation_id THEN
    RAISE EXCEPTION 'a reserve is applied only to an order of the same trader' USING ERRCODE = 'IX094';
  END IF;
  -- The trader's SELL_USDT order is the one where the trader owes USDT; the reserve is USDT. Nothing is converted:
  -- what a Buy USDT order owes is INR, and against that the reserve is only held.
  IF o.status <> 'IN_PROGRESS' OR (NEW.kind = 'APPLY') <> (o.side = 'SELL_USDT') THEN
    RAISE EXCEPTION 'a reserve is applied only to USDT a started order still owes, and held only against INR one owes' USING ERRCODE = 'IX094';
  END IF;
  SELECT r.status, r.route_delivers_asset INTO ob FROM route_obligation r WHERE r.id = NEW.route_obligation_id;
  IF NEW.kind = 'APPLY' THEN
    owed_asset := 'USDT';
  ELSE
    owed_asset := 'INR';
  END IF;
  IF ob.route_delivers_asset <> owed_asset OR ob.status NOT IN ('OPEN', 'PARTIALLY_SETTLED') THEN
    RAISE EXCEPTION 'the order''s obligation does not owe that now' USING ERRCODE = 'IX094';
  END IF;
  open_delivery := inrp2p_route_delivery_open(NEW.route_obligation_id);
  IF open_delivery <= 0 OR (NEW.kind = 'APPLY' AND NEW.amount_minor > open_delivery) THEN
    RAISE EXCEPTION 'the order still owes % minor units; % cannot be applied', open_delivery, NEW.amount_minor USING ERRCODE = 'IX094';
  END IF;
  free := inrp2p_trader_reserve_free(NEW.trader_id, NEW.id);
  IF NEW.amount_minor > free THEN
    RAISE EXCEPTION 'the reserve holds % USDT minor units free; % cannot be applied', free, NEW.amount_minor USING ERRCODE = 'IX094';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trader_reserve_application_guard BEFORE INSERT OR UPDATE ON trader_reserve_application
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_reserve_application();

-- ── The delivery a route settlement records ────────────────────────────────────────────────────────────────────
ALTER TABLE route_settlement ADD COLUMN reserve_application_id uuid REFERENCES trader_reserve_application (id);
CREATE UNIQUE INDEX route_settlement_reserve_application_unique ON route_settlement (reserve_application_id) WHERE reserve_application_id IS NOT NULL;

CREATE FUNCTION inrp2p_guard_route_delivery_source() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  app record;
  c record;
  payer text;
BEGIN
  IF NEW.reserve_application_id IS NOT NULL THEN
    SELECT a.trader_id, a.status, a.kind, a.route_obligation_id, a.amount_minor INTO app FROM trader_reserve_application a WHERE a.id = NEW.reserve_application_id;
    IF app.status IS DISTINCT FROM 'APPROVED' OR app.kind <> 'APPLY' OR app.route_obligation_id <> NEW.route_obligation_id OR app.amount_minor <> NEW.amount_minor
       OR NEW.flow <> 'FROM_ROUTE_TO_EXCHANGE' OR NEW.asset <> 'USDT' OR NEW.transfer_kind <> 'CRYPTO' THEN
      RAISE EXCEPTION 'route settlement % does not carry the approved reserve application it names', NEW.ref USING ERRCODE = 'IX095';
    END IF;
    SELECT t.from_address, t.to_address INTO c FROM crypto_transfer t WHERE t.id = NEW.crypto_transfer_id;
    -- To the order's own delivery address …
    IF NOT EXISTS (SELECT 1 FROM deposit_assignment a JOIN deposit_address d ON d.id = a.deposit_address_id
                    WHERE a.route_obligation_id = NEW.route_obligation_id AND d.address = c.to_address) THEN
      RAISE EXCEPTION 'an applied reserve is delivered to the order''s own address' USING ERRCODE = 'IX095';
    END IF;
    -- … from the trader's own reserve address or a treasury wallet — never from another subject's deposit address.
    IF NOT (EXISTS (SELECT 1 FROM treasury_wallet w WHERE w.address = c.from_address)
            OR EXISTS (SELECT 1 FROM deposit_assignment a JOIN deposit_address d ON d.id = a.deposit_address_id
                        WHERE a.trader_id = app.trader_id AND d.address = c.from_address)) THEN
      RAISE EXCEPTION 'an applied reserve leaves the trader''s reserve address or a treasury wallet' USING ERRCODE = 'IX095';
    END IF;
  ELSIF NEW.flow = 'FROM_ROUTE_TO_EXCHANGE' THEN
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
CREATE TRIGGER route_settlement_delivery_source BEFORE INSERT ON route_settlement
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_route_delivery_source();

-- The application and its movement move together: SENT while the settlement is recorded, COMPLETED once it is
-- confirmed, FAILED once it failed; before SENT nothing names it. Checked at commit, whatever code wrote either row.
CREATE FUNCTION inrp2p_check_reserve_application_settlement() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  app_id uuid;
  app_status text;
  s_status text;
  n integer;
  consistent boolean;
BEGIN
  IF TG_TABLE_NAME = 'route_settlement' THEN
    app_id := NEW.reserve_application_id;
  ELSE
    app_id := NEW.id;
  END IF;
  SELECT a.status INTO app_status FROM trader_reserve_application a WHERE a.id = app_id;
  SELECT count(*), max(s.status) INTO n, s_status FROM route_settlement s WHERE s.reserve_application_id = app_id;
  consistent := CASE app_status
                  WHEN 'SENT' THEN n = 1 AND s_status = 'RECORDED'
                  WHEN 'COMPLETED' THEN n = 1 AND s_status = 'CONFIRMED'
                  WHEN 'FAILED' THEN n = 1 AND s_status = 'FAILED'
                  ELSE n = 0
                END;
  IF NOT consistent THEN
    RAISE EXCEPTION 'reserve application % is % but its delivery is %', app_id, app_status, coalesce(s_status, 'not recorded') USING ERRCODE = 'IX095';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER trader_reserve_application_settlement AFTER INSERT OR UPDATE ON trader_reserve_application
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inrp2p_check_reserve_application_settlement();
CREATE CONSTRAINT TRIGGER route_settlement_reserve_application AFTER INSERT OR UPDATE ON route_settlement
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.reserve_application_id IS NOT NULL)
  EXECUTE FUNCTION inrp2p_check_reserve_application_settlement();

GRANT SELECT, INSERT ON trader_reserve_application TO inrp2p_app;
GRANT UPDATE (status, decided_by, decided_at, decision_note, sent_at, completed_at, closed_at, closed_by, close_reason) ON trader_reserve_application TO inrp2p_app;
GRANT SELECT ON trader_reserve_application TO inrp2p_readonly;
GRANT USAGE ON SEQUENCE trader_reserve_application_ref_seq TO inrp2p_app;
GRANT EXECUTE ON FUNCTION inrp2p_trader_reserve_balance(uuid), inrp2p_trader_reserve_free(uuid, uuid), inrp2p_route_delivery_open(uuid) TO inrp2p_app, inrp2p_readonly;
