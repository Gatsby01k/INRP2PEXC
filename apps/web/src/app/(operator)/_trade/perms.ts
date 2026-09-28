import 'server-only';
import { type OperatorContext, can } from '../../../server/operator.ts';
import type { TradePerms } from './types.ts';

export type { TradePerms };

export function tradePerms(ctx: OperatorContext): TradePerms {
  return {
    meId: ctx.actor.userId,
    economics: ctx.access.economics,
    createPayout: can(ctx, 'settlement:create_payout'),
    sendPayout: can(ctx, 'settlement:send_payout'),
    routeSent: can(ctx, 'settlement:record_route_payout_sent'),
    recordUtr: can(ctx, 'settlement:record_utr'),
    confirmPayout: can(ctx, 'settlement:confirm_payout'),
    failPayout: can(ctx, 'settlement:fail_payout'),
    cancelPayout: can(ctx, 'settlement:cancel_payout'),
    changeUtr: can(ctx, 'settlement:change_utr'),
    recordIncoming: can(ctx, 'settlement:record_incoming'),
    confirmIncoming: can(ctx, 'settlement:confirm_incoming'),
    openException: can(ctx, 'exception:open'),
    resolveException: can(ctx, 'exception:resolve'),
    requestAdjustment: can(ctx, 'adjustment:request'),
    approveAdjustment: can(ctx, 'adjustment:approve'),
    approveRefund: can(ctx, 'refund:approve'),
    cancelTrade: can(ctx, 'trade:cancel'),
    receipt: can(ctx, 'receipt:view'),
  };
}
