/**
 * The words of a client step-up refusal (ADR 0026), apart from the confirmation sheet itself: a page that only reads a
 * refusal carries none of the sheet's script or stylesheet. The sheet (`ConfirmIdentity.tsx`) loads when it is shown
 * (`Confirm.tsx`) — a stylesheet on the page from the start would hold back the page's own reveal until it arrived.
 */
export type ConfirmFactor = 'TELEGRAM' | 'EMAIL' | 'TOTP';
export type ConfirmPurpose = 'DESTINATION' | 'WITHDRAWAL' | 'SETTLEMENT' | 'TEAM' | 'SECURITY' | 'CHANGE';

export const CONFIRM_FACTORS: readonly ConfirmFactor[] = ['TELEGRAM', 'EMAIL', 'TOTP'];
const PURPOSES: readonly ConfirmPurpose[] = ['DESTINATION', 'WITHDRAWAL', 'SETTLEMENT', 'TEAM', 'SECURITY', 'CHANGE'];

/** The factors a refusal named, in the server's order — or null when it named none (an operator's TOTP step-up). */
export function confirmFactorsOf(details: Record<string, unknown> | undefined): ConfirmFactor[] | null {
  const raw = details?.factors;
  if (!Array.isArray(raw)) return null;
  return raw.filter((f): f is ConfirmFactor => (CONFIRM_FACTORS as readonly unknown[]).includes(f));
}

/** What the refusal said it was confirming, for the code's message; anything else is a plain "change". */
export function confirmPurposeOf(details: Record<string, unknown> | undefined): ConfirmPurpose {
  return (PURPOSES as readonly unknown[]).includes(details?.purpose) ? (details!.purpose as ConfirmPurpose) : 'CHANGE';
}
