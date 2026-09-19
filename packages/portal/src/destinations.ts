import type { Executor } from '@inrp2p/db';
import { clientSafe } from './access.ts';

/**
 * Where a client's money can go.
 *
 * Bank account numbers are envelope-encrypted and never unsealed for a screen: the client sees the last four
 * digits they use to recognise the account, which is what the desk shows too (SECURITY §4, D-09). A wallet is
 * shown in full, because an address is public by nature and the client must be able to check it character by
 * character before a payout is sent to it.
 */
export interface ClientBankAccount {
  readonly id: string;
  readonly bankName: string;
  readonly ifsc: string;
  readonly last4: string;
  readonly holderName: string;
  readonly rails: readonly string[];
  readonly status: 'ACTIVE' | 'ARCHIVED';
  readonly verified: boolean;
}

export interface ClientWallet {
  readonly id: string;
  readonly network: 'TRON';
  readonly address: string;
  readonly label: string;
  readonly purpose: 'SOURCE' | 'DESTINATION' | 'BOTH';
  readonly status: 'ACTIVE' | 'ARCHIVED';
}

export interface ClientDestinations {
  readonly banks: readonly ClientBankAccount[];
  readonly wallets: readonly ClientWallet[];
}

export async function clientDestinations(ex: Executor, clientId: string, opts: { includeArchived?: boolean } = {}): Promise<ClientDestinations> {
  let banks = ex
    .selectFrom('bank_account')
    .select(['id', 'bank_name', 'ifsc', 'account_last4', 'holder_name', 'rail_preferences', 'status', 'verified_at'])
    .where('client_id', '=', clientId)
    .orderBy('created_at', 'asc');
  let wallets = ex
    .selectFrom('crypto_wallet')
    .select(['id', 'network', 'address', 'label', 'purpose', 'status'])
    .where('client_id', '=', clientId)
    .orderBy('created_at', 'asc');
  if (!opts.includeArchived) {
    banks = banks.where('status', '=', 'ACTIVE');
    wallets = wallets.where('status', '=', 'ACTIVE');
  }

  return clientSafe({
    banks: (await banks.execute()).map((b) => ({
      id: b.id,
      bankName: b.bank_name,
      ifsc: b.ifsc,
      last4: b.account_last4,
      holderName: b.holder_name,
      rails: b.rail_preferences,
      status: b.status,
      verified: b.verified_at !== null,
    })),
    wallets: (await wallets.execute()).map((w) => ({
      id: w.id,
      network: w.network,
      address: w.address,
      label: w.label,
      purpose: w.purpose,
      status: w.status,
    })),
  });
}

/** How a destination is named on screen: recognisable, and never the full account number. */
export const bankLabel = (b: Pick<ClientBankAccount, 'bankName' | 'last4'>): string => `${b.bankName} •••• ${b.last4}`;
export const walletLabel = (w: Pick<ClientWallet, 'address'>): string => `TRC20 · ${w.address.slice(0, 3)}…${w.address.slice(-4)}`;
