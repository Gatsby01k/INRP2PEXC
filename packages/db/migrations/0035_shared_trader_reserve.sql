-- 0035 one Security Reserve address for every trader, credited by the wallet that sent the USDT (owner decision
-- 2026-10-10, docs/DECISIONS.md D-17).
--
-- Until now each trader's reserve had its own deposit address, issued through the custody pool, and the address
-- attributed the money. Every trader now sees one TRC20 address, an exchange wallet watched like any other (the
-- application never holds its key). One address cannot say whose money arrived, so the sender does:
--
-- 1. `treasury_wallet.role = 'TRADER_RESERVE'`: the shared reserve address. At most one is active; the owner's address
--    is recorded here, so changing it is a reviewed migration, never a setting someone flips.
-- 2. `inrp2p_reserve_sender_trader(from, at)`: the trader a reserve deposit belongs to — the single trader whose
--    registered wallet (verified, or still under review: topping up is not admission to trading) is the sender and was
--    on file before the transfer. Two traders with that wallet on file, or none, is nobody: the money waits for the
--    desk. "On file before the transfer" is what stops anyone from registering a wallet they saw on chain and claiming
--    a deposit already made from it.
-- 3. IX102: a transfer into the shared address is the reserve of exactly that trader, or of unknown origin — never
--    another trader's, whatever the application asks. One row per on-chain transfer (FI-23) and one journal per
--    movement keep it from being credited twice.
-- 4. `crypto_transfer.source = 'CLIENT_SUBMITTED'`: a trader may hand in the hash of its own transfer; the facts are
--    read from the chain, and attribution is still the sender's wallet, never the person asking.
--
-- Error code IX102 belongs to this migration. 0001–0034 are not edited.

ALTER TABLE treasury_wallet DROP CONSTRAINT treasury_wallet_role_check;
ALTER TABLE treasury_wallet ADD CONSTRAINT treasury_wallet_role_check CHECK (role IN ('HOT', 'COLD', 'DEPOSIT_POOL', 'TRADER_RESERVE'));
CREATE UNIQUE INDEX treasury_wallet_one_trader_reserve ON treasury_wallet (role) WHERE role = 'TRADER_RESERVE' AND status = 'ACTIVE';

INSERT INTO treasury_wallet (network, address, label, role, created_by)
VALUES ('TRON', 'TJNzB4sUGBo8fv7UdeeKQKQUffpfLSXbPP', 'Trader Security Reserve', 'TRADER_RESERVE', 'migration 0035 (owner decision D-17, 2026-10-10)');

ALTER TABLE crypto_transfer DROP CONSTRAINT crypto_transfer_source_check;
ALTER TABLE crypto_transfer ADD CONSTRAINT crypto_transfer_source_check CHECK (source IN ('SCANNER', 'OPERATOR_SUBMITTED', 'CLIENT_SUBMITTED'));

-- Wall-clock times on both sides: a wallet's `created_at` and a block's time are both real time, whatever the
-- business clock says.
CREATE FUNCTION inrp2p_reserve_sender_trader(p_from text, p_at timestamptz) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN count(*) = 1 THEN min(t.id::text)::uuid END
  FROM trader_profile t
  JOIN crypto_wallet w ON w.id = t.wallet_id
  WHERE w.network = 'TRON'
    AND w.address = p_from
    AND w.status IN ('ACTIVE', 'PENDING_REVIEW')
    AND w.created_at <= p_at
$$;

CREATE FUNCTION inrp2p_guard_shared_reserve_transfer() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected uuid;
BEGIN
  IF NEW.payer_type <> 'TRADER' OR NOT EXISTS (
    SELECT 1 FROM treasury_wallet WHERE network = NEW.network AND address = NEW.to_address AND role = 'TRADER_RESERVE'
  ) THEN
    RETURN NEW;
  END IF;
  expected := inrp2p_reserve_sender_trader(NEW.from_address, statement_timestamp());
  IF expected IS NULL OR NEW.payer_id IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'reserve deposit %:%: credited only to the one trader whose registered wallet sent it', NEW.tx_hash, NEW.log_index USING ERRCODE = 'IX102';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER crypto_transfer_shared_reserve BEFORE INSERT ON crypto_transfer
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_shared_reserve_transfer();

GRANT EXECUTE ON FUNCTION inrp2p_reserve_sender_trader(text, timestamptz) TO inrp2p_app, inrp2p_readonly;
