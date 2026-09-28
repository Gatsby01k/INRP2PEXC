/**
 * What the trade workspace may offer this operator, computed once on the server from the same matrix the commands
 * enforce. It decides which controls are drawn; the command still authorizes itself, so a control drawn by mistake
 * would only ever be refused.
 */
export interface TradePerms {
  readonly meId: string;
  readonly economics: boolean;
  readonly createPayout: boolean;
  readonly sendPayout: boolean;
  readonly routeSent: boolean;
  readonly recordUtr: boolean;
  readonly confirmPayout: boolean;
  readonly failPayout: boolean;
  readonly cancelPayout: boolean;
  readonly changeUtr: boolean;
  readonly recordIncoming: boolean;
  readonly confirmIncoming: boolean;
  readonly openException: boolean;
  readonly resolveException: boolean;
  readonly requestAdjustment: boolean;
  readonly approveAdjustment: boolean;
  readonly approveRefund: boolean;
  readonly cancelTrade: boolean;
  readonly receipt: boolean;
}
