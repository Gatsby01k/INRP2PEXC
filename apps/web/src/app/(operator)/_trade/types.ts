/**
 * What the trade workspace may offer this operator, computed once on the server from the same matrix the commands
 * enforce. It decides which controls are drawn; the command still authorizes itself, so a control drawn by mistake
 * would only ever be refused.
 */
export interface TradePerms {
  readonly meId: string;
  readonly economics: boolean;
  readonly createPayout: boolean;
  /** Who may decide a disputed P2P payment was made: the same people who confirm a client's funds, or a payout. */
  readonly confirmPayout: boolean;
  readonly confirmIncoming: boolean;
  readonly openException: boolean;
  readonly resolveException: boolean;
  readonly requestAdjustment: boolean;
  readonly approveAdjustment: boolean;
  readonly approveRefund: boolean;
  readonly cancelTrade: boolean;
  readonly receipt: boolean;
  readonly requestDestinationChange: boolean;
  readonly approveDestinationChange: boolean;
  /** `network:manage`: raise what a trade holds of its funder's TRX (ADR 0017, FI-95). */
  readonly manageNetwork: boolean;
}
