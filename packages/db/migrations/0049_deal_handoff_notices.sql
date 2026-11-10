-- 0049 A deal says whose move it is, the moment it becomes theirs (launch audit, 2026-11-10).
--
-- A P2P deal is a relay of timed steps: the seller locks its USDT, the buyer pays the rupees, the seller confirms them. Three
-- of the hand-offs told nobody: a client buying USDT was not told its time to pay had started, a client selling was not
-- told its trader said it had paid, and a trader was told "the buyer says it paid" only in Telegram. Each of them was first
-- heard of when its time was already up. And a trader's side that had used up its capacity stopped taking orders in
-- silence. The inbox gains the three kinds those messages are:
--
-- - `P2P_PAY_NOW`: the seller's USDT is locked in escrow — the buyer's time to pay runs from now.
-- - `P2P_PAYMENT_SENT`: the buyer says it paid — the seller checks its bank and confirms, or says it has not arrived.
-- - `TRADER_SIDE_EMPTY`: a side of the trader's can no longer take its smallest order — it gets no orders until topped up.
--
-- No table, column or rule of money changes. No error code belongs to this migration. 0001–0048 are not edited.

ALTER TABLE client_notification DROP CONSTRAINT client_notification_kind_check;
ALTER TABLE client_notification ADD CONSTRAINT client_notification_kind_check CHECK (kind IN (
  'QUOTE_SENT', 'QUOTE_EXPIRED', 'REQUEST_DECLINED', 'TRADE_OPENED', 'PAYOUT_CONFIRMED', 'TRADE_COMPLETED', 'TRADE_CANCELLED',
  'DESTINATION_ADDED', 'DESTINATION_ARCHIVED', 'TRADE_DESTINATION_CHANGED',
  'TRADER_APPROVED', 'TRADER_REJECTED', 'TRADER_PAUSED', 'TRADER_RESUMED', 'TRADER_ORDER_NEW', 'TRADER_ORDER_ACCEPTED',
  'TRADER_ACTION_REQUIRED', 'TRADER_PAYMENT_CONFIRMED', 'TRADER_ORDER_COMPLETED', 'TRADER_ORDER_CLOSED', 'TRADER_RESERVE_ISSUE',
  'PAYMENT_RETURNED', 'TEAM_CHANGED', 'P2P_DISPUTE_OPENED', 'P2P_DISPUTE_DECIDED', 'P2P_REFUND', 'DESK_NOTICE',
  'DEAL_MESSAGE', 'P2P_PAY_FINAL', 'P2P_RECEIPT_LATE', 'TRADER_SETTLEMENT_CHANGE', 'TRADER_PRICE_REQUEST',
  'P2P_PAY_NOW', 'P2P_PAYMENT_SENT', 'TRADER_SIDE_EMPTY'));
