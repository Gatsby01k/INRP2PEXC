-- 0044 Traders go live without a person in the loop, inside limits their own reserve and record set
-- (docs/adr/0024-onboarding-automation-and-risk-limits.md).
--
-- 1. The programme may review applications by rule (`auto_review`, off until the desk switches it on): a wallet is
--    proven by USDT the trader sent from it, a bank account by consistent details, and an application whose details
--    are verified and whose reserve is funded is approved. Whatever a rule cannot settle waits for a person, with the
--    reasons (`auto_review_flags`). A person may still decide anything, at any time.
-- 2. The programme names how far a trader's Security Reserve stretches (`risk_policy`): three levels — new, proven,
--    trusted — reached by completed deals and days since approval, lost again by a deal the trader failed in the last
--    `cleanDays`; at each level a single deal may be up to `dealX` times the trader's free reserve and its open deals up
--    to `openX` times. Null switches the reserve-based limits off. The reserve that backs open deals stays locked.
-- 3. A change of an approved trader's bank account or wallet takes effect only after `settlement_change_hold_hours`
--    (every member is told at once and an administrator can stop it), and is then applied by rule when auto-review is
--    on; until then the registered details keep settling every order.
-- 4. A trader becomes APPROVED only with both registered details verified and a Security Reserve set (IX138), whoever
--    approves it.
--
-- Error code IX138 belongs to this migration. 0001–0043 are not edited.


-- 1–3. The programme ------------------------------------------------------------------------------------------------

-- One level of the reserve-based limits: whole numbers in range, and open deals never below a single deal.
CREATE FUNCTION inrp2p_valid_risk_tier(t jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(t) = 'object'
                AND inrp2p_minutes_between(t->>'minDeals', 0, 100000) AND inrp2p_minutes_between(t->>'minDays', 0, 3650)
                AND inrp2p_minutes_between(t->>'dealX', 1, 100) AND inrp2p_minutes_between(t->>'openX', 1, 500)
              THEN (t->>'openX')::integer >= (t->>'dealX')::integer
              ELSE false END
$$;

-- Three levels, the first open to everyone, each asking at least as much as the one before and allowing at least as much.
CREATE FUNCTION inrp2p_valid_trader_risk_policy(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(p) = 'object' AND inrp2p_minutes_between(p->>'cleanDays', 0, 365) AND jsonb_typeof(p->'tiers') = 'array'
              THEN CASE WHEN jsonb_array_length(p->'tiers') = 3
                          AND inrp2p_valid_risk_tier(p->'tiers'->0) AND inrp2p_valid_risk_tier(p->'tiers'->1) AND inrp2p_valid_risk_tier(p->'tiers'->2)
                        THEN (p->'tiers'->0->>'minDeals')::integer = 0 AND (p->'tiers'->0->>'minDays')::integer = 0
                         AND (p->'tiers'->1->>'minDeals')::integer >= (p->'tiers'->0->>'minDeals')::integer
                         AND (p->'tiers'->2->>'minDeals')::integer >= (p->'tiers'->1->>'minDeals')::integer
                         AND (p->'tiers'->1->>'minDays')::integer >= (p->'tiers'->0->>'minDays')::integer
                         AND (p->'tiers'->2->>'minDays')::integer >= (p->'tiers'->1->>'minDays')::integer
                         AND (p->'tiers'->1->>'dealX')::integer >= (p->'tiers'->0->>'dealX')::integer
                         AND (p->'tiers'->2->>'dealX')::integer >= (p->'tiers'->1->>'dealX')::integer
                         AND (p->'tiers'->1->>'openX')::integer >= (p->'tiers'->0->>'openX')::integer
                         AND (p->'tiers'->2->>'openX')::integer >= (p->'tiers'->1->>'openX')::integer
                        ELSE false END
              ELSE false END
$$;

ALTER TABLE trader_program ADD COLUMN auto_review boolean NOT NULL DEFAULT false;
ALTER TABLE trader_program ADD COLUMN risk_policy jsonb
  DEFAULT '{"cleanDays": 30, "tiers": [{"minDeals": 0, "minDays": 0, "dealX": 2, "openX": 4}, {"minDeals": 10, "minDays": 7, "dealX": 5, "openX": 15}, {"minDeals": 50, "minDays": 30, "dealX": 10, "openX": 30}]}'
  CHECK (risk_policy IS NULL OR inrp2p_valid_trader_risk_policy(risk_policy));
-- The default applies to the existing row as well: the limits are on from this release.
UPDATE trader_program SET risk_policy = DEFAULT WHERE risk_policy IS NULL;
ALTER TABLE trader_program ADD COLUMN settlement_change_hold_hours integer NOT NULL DEFAULT 24 CHECK (settlement_change_hold_hours BETWEEN 1 AND 168);


-- 1, 3, 4. The trader ------------------------------------------------------------------------------------------------

ALTER TABLE trader_profile ADD COLUMN approved_at timestamptz;

ALTER TABLE trader_profile ADD COLUMN auto_review_flags text[] NOT NULL DEFAULT '{}'
  CHECK (auto_review_flags <@ ARRAY[
    'BANK_NAME_MISMATCH', 'BANK_ON_FILE_ELSEWHERE', 'BANK_REJECTED_BEFORE',
    'WALLET_NOT_PROVEN', 'WALLET_ON_FILE_ELSEWHERE', 'WALLET_REJECTED_BEFORE',
    'RESERVE_SHORT', 'NO_DEFAULT_RESERVE', 'REJECTED_BEFORE', 'ORDERS_OPEN']::text[]);
ALTER TABLE trader_profile ADD COLUMN auto_reviewed_at timestamptz;

ALTER TABLE trader_profile ADD COLUMN proposal_effective_at timestamptz;
ALTER TABLE trader_profile ADD COLUMN proposed_by uuid REFERENCES auth_user (id);

-- The clock of a proposed change exists only while something is proposed: settling the last part of it (approved,
-- rejected, cancelled or replaced by the desk) stops it, whichever command did.
CREATE FUNCTION inrp2p_trader_proposal_clock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.proposed_bank_account_id IS NULL AND NEW.proposed_wallet_id IS NULL THEN
    NEW.proposal_effective_at := NULL;
    NEW.proposed_by := NULL;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trader_profile_a_proposal_clock BEFORE INSERT OR UPDATE ON trader_profile
  FOR EACH ROW EXECUTE FUNCTION inrp2p_trader_proposal_clock();

-- IX138: whoever approves a trader — a person or the programme's rules — its registered bank account and wallet are
-- verified, the wallet sends and receives, and the Security Reserve it must keep is set.
CREATE FUNCTION inrp2p_guard_trader_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'APPROVED' AND OLD.status = 'UNDER_REVIEW' THEN
    IF NOT EXISTS (SELECT 1 FROM bank_account b WHERE b.id = NEW.bank_account_id AND b.status = 'ACTIVE')
       OR NOT EXISTS (SELECT 1 FROM crypto_wallet w WHERE w.id = NEW.wallet_id AND w.status = 'ACTIVE' AND w.purpose = 'BOTH') THEN
      RAISE EXCEPTION 'trader % is approved only with its bank account and wallet verified', NEW.ref USING ERRCODE = 'IX138';
    END IF;
    IF NEW.required_reserve_minor IS NULL OR NEW.required_reserve_minor <= 0 OR NEW.approved_at IS NULL THEN
      RAISE EXCEPTION 'trader % is approved only with its Security Reserve set', NEW.ref USING ERRCODE = 'IX138';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trader_profile_approval BEFORE UPDATE OF status ON trader_profile
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_trader_approval();

DROP TRIGGER trader_profile_immutable ON trader_profile;
CREATE TRIGGER trader_profile_immutable BEFORE UPDATE ON trader_profile
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns(
    'status', 'offers_buy', 'offers_sell', 'typical_inr_minor', 'typical_usdt_minor', 'bank_account_id', 'wallet_id',
    'required_reserve_minor', 'reward_bps', 'max_order_inr_minor', 'max_order_usdt_minor', 'max_capacity_inr_minor',
    'max_capacity_usdt_minor', 'available', 'assignments_enabled', 'control_note', 'applied_by', 'applied_at',
    'reviewed_by', 'reviewed_at', 'review_note', 'updated_at', 'version',
    'p2p_experience', 'profile_link', 'telegram_handle', 'phone_enc', 'phone_last4', 'daily_capacity_inr_minor',
    'daily_capacity_usdt_minor', 'ownership_confirmed_at', 'proposed_bank_account_id', 'proposed_wallet_id',
    'approved_at', 'auto_review_flags', 'auto_reviewed_at', 'proposal_effective_at', 'proposed_by');

-- Every approved or paused trader was approved at its last review (pausing never touches the review fields) — filled
-- once the guard above lets `approved_at` change, then required.
UPDATE trader_profile SET approved_at = coalesce(reviewed_at, applied_at) WHERE status IN ('APPROVED', 'PAUSED');
ALTER TABLE trader_profile ADD CONSTRAINT trader_profile_approved_at CHECK (status NOT IN ('APPROVED', 'PAUSED') OR approved_at IS NOT NULL);

-- The sweep finds due changes without reading every trader.
CREATE INDEX trader_profile_proposal_due_idx ON trader_profile (proposal_effective_at) WHERE proposal_effective_at IS NOT NULL;


-- 3. What the inbox says ---------------------------------------------------------------------------------------------

ALTER TABLE client_notification DROP CONSTRAINT client_notification_kind_check;
ALTER TABLE client_notification ADD CONSTRAINT client_notification_kind_check CHECK (kind IN (
  'QUOTE_SENT', 'QUOTE_EXPIRED', 'REQUEST_DECLINED', 'TRADE_OPENED', 'PAYOUT_CONFIRMED', 'TRADE_COMPLETED', 'TRADE_CANCELLED',
  'DESTINATION_ADDED', 'DESTINATION_ARCHIVED', 'TRADE_DESTINATION_CHANGED',
  'TRADER_APPROVED', 'TRADER_REJECTED', 'TRADER_PAUSED', 'TRADER_RESUMED', 'TRADER_ORDER_NEW', 'TRADER_ORDER_ACCEPTED',
  'TRADER_ACTION_REQUIRED', 'TRADER_PAYMENT_CONFIRMED', 'TRADER_ORDER_COMPLETED', 'TRADER_ORDER_CLOSED', 'TRADER_RESERVE_ISSUE',
  'PAYMENT_RETURNED', 'TEAM_CHANGED', 'P2P_DISPUTE_OPENED', 'P2P_DISPUTE_DECIDED', 'P2P_REFUND', 'DESK_NOTICE',
  'DEAL_MESSAGE', 'P2P_PAY_FINAL', 'P2P_RECEIPT_LATE', 'TRADER_SETTLEMENT_CHANGE'));


-- Grants -------------------------------------------------------------------------------------------------------------

GRANT UPDATE (auto_review, risk_policy, settlement_change_hold_hours) ON trader_program TO inrp2p_app;
GRANT UPDATE (approved_at, auto_review_flags, auto_reviewed_at, proposal_effective_at, proposed_by) ON trader_profile TO inrp2p_app;
GRANT EXECUTE ON FUNCTION inrp2p_valid_risk_tier(jsonb), inrp2p_valid_trader_risk_policy(jsonb) TO inrp2p_app, inrp2p_readonly;
