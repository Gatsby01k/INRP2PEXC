import 'server-only';
import { type OperatorContext, can } from '../../../server/operator.ts';
import type { TradePerms } from './types.ts';

export type { TradePerms };

export function tradePerms(ctx: OperatorContext): TradePerms {
  return {
    meId: ctx.actor.userId,
    economics: ctx.access.economics,
    createPayout: can(ctx, 'settlement:create_payout'),
    confirmPayout: can(ctx, 'settlement:confirm_payout'),
    confirmIncoming: can(ctx, 'settlement:confirm_incoming'),
    openException: can(ctx, 'exception:open'),
    resolveException: can(ctx, 'exception:resolve'),
    requestAdjustment: can(ctx, 'adjustment:request'),
    approveAdjustment: can(ctx, 'adjustment:approve'),
    approveRefund: can(ctx, 'refund:approve'),
    cancelTrade: can(ctx, 'trade:cancel'),
    receipt: can(ctx, 'receipt:view'),
    requestDestinationChange: can(ctx, 'trade:request_destination_change'),
    approveDestinationChange: can(ctx, 'trade:approve_destination_change'),
    manageNetwork: can(ctx, 'network:manage'),
  };
}
