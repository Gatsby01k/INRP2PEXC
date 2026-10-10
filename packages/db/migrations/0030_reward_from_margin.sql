-- 0030 a trader's reward is paid from realized margin, never from principal (production task D4; ADR 0016 §6).
--
-- An exchange INR account holds other people's money: the client's INR waiting to pay a trader, a trader's INR waiting
-- to pay a client. Since D-16 the platform's own money in that account is only the margin its finished trades left
-- there. A reward payout is the platform's own expense, so it may draw on that and nothing else: the margin of trades
-- that are completed on both sides (the client paid in full, the counterparty paid in full — before that, part of it is
-- still owed to someone), less the rewards already paid or being paid from the account. It is also never more than the
-- account holds beyond the money of trades still open there.
--
-- Error code IX096 belongs to this migration. 0001–0029 are not edited.

CREATE FUNCTION inrp2p_inr_account_free_margin(p_account uuid) RETURNS bigint
LANGUAGE sql STABLE AS $$
  WITH sources AS (
    -- What each trade's money at this account still has, after what was paid out of it (CONSUMED earmarks).
    SELECT s.trade_id,
           s.amount_minor - coalesce((SELECT sum(a.amount_minor) FROM funding_allocation a
                                       WHERE a.status = 'CONSUMED'
                                         AND (a.source_leg_id = s.source_id OR a.source_route_settlement_id = s.source_id)), 0) AS left_minor,
           (t.lifecycle_state = 'COMPLETED' AND o.status = 'SETTLED') AS finished
      FROM funding_source s
      JOIN trade t ON t.id = s.trade_id
      LEFT JOIN route_obligation o ON o.trade_id = s.trade_id
     WHERE s.asset = 'INR' AND s.location = 'INR:' || p_account::text
  ),
  totals AS (
    SELECT coalesce(sum(left_minor) FILTER (WHERE finished), 0) AS realized,
           coalesce(sum(left_minor) FILTER (WHERE NOT finished), 0) AS held
      FROM sources
  ),
  rewards AS (
    SELECT coalesce(sum(amount_minor) FILTER (WHERE status IN ('RECORDED', 'CONFIRMED')), 0) AS spent,
           coalesce(sum(amount_minor) FILTER (WHERE status = 'RECORDED'), 0) AS pending
      FROM trader_reward_payout WHERE inr_account_id = p_account
  ),
  ledger AS (
    SELECT coalesce((SELECT b.dr_minus_cr_minor FROM ledger_account_balance b
                      WHERE b.code = 'ASSET:INR_SETTLEMENT:' || p_account::text AND b.currency = 'INR'), 0)::bigint AS balance
  )
  SELECT least(t.realized - r.spent, l.balance - t.held - r.pending)::bigint
    FROM totals t, rewards r, ledger l
$$;

CREATE FUNCTION inrp2p_guard_reward_from_margin() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  free bigint;
BEGIN
  -- Two payouts from the same account are decided one after the other.
  PERFORM pg_advisory_xact_lock(hashtext('inrp2p.reward_payout'), hashtext(NEW.inr_account_id::text));
  free := inrp2p_inr_account_free_margin(NEW.inr_account_id);
  IF NEW.amount_minor > free THEN
    RAISE EXCEPTION 'reward payout % exceeds the realized margin free at account % (% paise)', NEW.ref, NEW.inr_account_id, greatest(free, 0)
      USING ERRCODE = 'IX096';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trader_reward_payout_from_margin BEFORE INSERT ON trader_reward_payout
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_reward_from_margin();

GRANT EXECUTE ON FUNCTION inrp2p_inr_account_free_margin(uuid) TO inrp2p_app, inrp2p_readonly;
