import { type OperatorActor, type Permission, effectiveRequirement } from '@inrp2p/identity';

/**
 * What the desk may *see*. Every read model takes this and omits what the viewer is not allowed to know —
 * field absence, not blanking (SECURITY §5): a SETTLEMENT_OPERATOR's payout panel simply has no route rate or
 * margin in it, so there is nothing to leak through a JSON payload, a screenshot or an export.
 *
 * This is a projection of the same RBAC matrix the commands enforce, not a second policy. It decides what the
 * page renders; the command still authorizes itself in its own transaction.
 */
export interface DeskAccess {
  /** `economics:view` — client vs route rate, spread, margin. */
  readonly economics: boolean;
  /** `route_positions:view` — route obligations and route settlements. */
  readonly routePositions: boolean;
  /** `pnl:view` — realized margin figures on the strip. */
  readonly pnl: boolean;
}

export const NO_ECONOMICS: DeskAccess = Object.freeze({ economics: false, routePositions: false, pnl: false });
export const FULL_ACCESS: DeskAccess = Object.freeze({ economics: true, routePositions: true, pnl: true });

export const allows = (actor: Pick<OperatorActor, 'roles' | 'grants'>, permission: Permission): boolean =>
  effectiveRequirement(permission, actor.roles, actor.grants) !== 'DENY';

/** The view access implied by an operator's roles and individual grants. */
export function accessFor(actor: Pick<OperatorActor, 'roles' | 'grants'>): DeskAccess {
  return {
    economics: allows(actor, 'economics:view'),
    routePositions: allows(actor, 'route_positions:view'),
    pnl: allows(actor, 'pnl:view'),
  };
}
