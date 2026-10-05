-- 0026 custody balance observation (production task B2, DECISIONS.md D-16).
--
-- Until now nothing in production ever wrote what a treasury wallet actually holds: `observed_balance_minor` stayed 0
-- and `observed_at` null outside test fixtures, and a payout only ever lowered `reserved`, so money already sent could
-- look available again. This records what the chain says each exchange address holds, when, as of which solidified
-- block, from how many independent sources — append-only, so every payout decision can be traced to the reading it
-- relied on. A wallet's own `observed_balance_minor` / `observed_at` are kept current from the latest usable reading.
-- Error code IX089 belongs to this migration. 0001–0025 are applied and are not edited.

CREATE TABLE custody_balance_observation (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  network         text NOT NULL CHECK (network IN ('TRON')),
  address         inrp2p_tron_address NOT NULL,
  token_contract  inrp2p_tron_address NOT NULL,
  -- AGREED: two or more independent sources read the same balance at the same solidified block.
  -- SINGLE_SOURCE: one source answered (the others failed or were not configured).
  -- DISAGREED: sources answered with different balances for the same block — unusable.
  -- ERROR: nobody answered — unusable.
  quality         text NOT NULL CHECK (quality IN ('AGREED', 'SINGLE_SOURCE', 'DISAGREED', 'ERROR')),
  balance_minor   bigint CHECK (balance_minor >= 0),
  solidified_block bigint CHECK (solidified_block >= 0),
  trx_sun         bigint CHECK (trx_sun >= 0),
  providers       text NOT NULL CHECK (length(providers) <= 300),
  independent_sources integer NOT NULL CHECK (independent_sources >= 0),
  detail          text CHECK (length(detail) <= 500),
  observed_by     text NOT NULL,
  observed_at     timestamptz NOT NULL DEFAULT inrp2p_now(),
  CHECK ((quality IN ('AGREED', 'SINGLE_SOURCE')) = (balance_minor IS NOT NULL AND solidified_block IS NOT NULL)),
  CHECK (quality <> 'AGREED' OR independent_sources >= 2),
  CHECK (quality <> 'SINGLE_SOURCE' OR independent_sources = 1)
);
CREATE INDEX custody_balance_observation_address_idx ON custody_balance_observation (network, address, observed_at DESC);
CREATE TRIGGER custody_balance_observation_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON custody_balance_observation
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- A wallet's observed balance follows its latest usable reading and nothing else: no command may set it to a number
-- that no observation supports, nor wind it back to an older, larger reading.
CREATE FUNCTION inrp2p_guard_treasury_observed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  latest record;
BEGIN
  IF NEW.observed_balance_minor IS DISTINCT FROM OLD.observed_balance_minor OR NEW.observed_at IS DISTINCT FROM OLD.observed_at THEN
    SELECT o.balance_minor, o.observed_at INTO latest
      FROM custody_balance_observation o
     WHERE o.network = NEW.network AND o.address = NEW.address AND o.quality IN ('AGREED', 'SINGLE_SOURCE')
     ORDER BY o.observed_at DESC, o.id DESC
     LIMIT 1;
    IF NOT FOUND OR latest.balance_minor IS DISTINCT FROM NEW.observed_balance_minor OR latest.observed_at IS DISTINCT FROM NEW.observed_at THEN
      RAISE EXCEPTION 'treasury wallet % observed balance must be its latest recorded observation', NEW.id USING ERRCODE = 'IX089';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER treasury_wallet_observed_guard BEFORE UPDATE OF observed_balance_minor, observed_at ON treasury_wallet
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_treasury_observed();

GRANT SELECT, INSERT ON custody_balance_observation TO inrp2p_app;
GRANT SELECT ON custody_balance_observation TO inrp2p_readonly;

-- 0025's address-reuse guard (IX088) counted a planned outflow — an ACTIVE earmark — as money already gone, so a
-- deposit address could go back to the pool while a refund, or the payment to the counterparty, was still to leave
-- it. Money is gone from an address when its outflow is confirmed (CONSUMED), not when it is planned.
CREATE OR REPLACE FUNCTION inrp2p_address_earmarked(p_address text) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(s.amount_minor - coalesce((SELECT sum(f.amount_minor) FROM funding_allocation f
                                                  WHERE (f.source_leg_id = s.source_id OR f.source_route_settlement_id = s.source_id)
                                                    AND f.status = 'CONSUMED'), 0)), 0)
    FROM funding_source s
   WHERE s.location = 'TRON:' || p_address AND inrp2p_trade_is_counterparty_funded(s.trade_id)
$$;
