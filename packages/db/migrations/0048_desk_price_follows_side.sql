-- 0048 One price for a trader (ADR 0028 §2.7): a desk's price may follow its own side on Traders.
--
-- A trader set its rate twice: on its sides, for INRP2P's orders, and on its desk, for its own clients — the second a fixed
-- number that ran out (at most seven days) so the page never dealt on a forgotten price. `desk_price.basis = 'SIDE'` is
-- the desk's price for a direction at whatever its side's rate is now: its own fixed number, or its market rate (the
-- market reference moved by its offset, held at its bound). Such a price has no number and no end of its own: it is as
-- fresh as the side it follows, and off while that side has no rate (a market rate with no fresh reference). An order a
-- desk deal opens at a market rate records the reference and terms like any other (IX143).
-- No error code belongs to this migration. 0001–0047 are not edited.

ALTER TABLE desk_price
  ADD COLUMN basis text NOT NULL DEFAULT 'OWN' CHECK (basis IN ('OWN', 'SIDE')),
  ALTER COLUMN rate_micro DROP NOT NULL,
  ALTER COLUMN valid_until DROP NOT NULL,
  ADD CONSTRAINT desk_price_basis_shape CHECK (
    (basis = 'OWN' AND rate_micro IS NOT NULL AND valid_until IS NOT NULL)
    OR (basis = 'SIDE' AND rate_micro IS NULL AND valid_until IS NULL));
