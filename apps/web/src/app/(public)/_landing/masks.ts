import type { MaskedValue } from '../../../content/site.ts';

/**
 * The shape of a figure that only a real trade has.
 *
 * The public site prints no figure of its own (content/site.ts), so where a record would hold a rate, a time or
 * a reference, the landing draws its outline in the masking the product itself uses for an account number
 * (`•••• 4321`, D-09) — with every character masked. The shapes are the true ones: a rate has two places, a TRON
 * address starts with its network’s letter, an IMPS reference is twelve characters long.
 */
export const MASKS: Record<MaskedValue, string> = {
  rate: '••.••',
  time: '••:••',
  amount: '•••,•••',
  account: '•••• ••••',
  wallet: 'T••••••••••••',
  hash: '••••••••••••••••',
  reference: '••••••••••••',
};
