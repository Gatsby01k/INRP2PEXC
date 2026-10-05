import type { DestinationStatus, Executor } from '@inrp2p/db';
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
  /** ACTIVE is verified and usable; PENDING_REVIEW and REJECTED are details the client submitted (migration 0023). */
  readonly status: DestinationStatus;
  readonly verified: boolean;
}

export interface ClientWallet {
  readonly id: string;
  readonly network: 'TRON';
  readonly address: string;
  readonly label: string;
  readonly purpose: 'SOURCE' | 'DESTINATION' | 'BOTH';
  readonly status: DestinationStatus;
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

/** One person of a client, as that client's administrator sees them (TD-11): no email beyond the masked one. */
export interface ClientPerson {
  readonly clientUserId: string;
  readonly name: string;
  readonly email: string;
  readonly role: 'CLIENT_ADMIN' | 'CLIENT_TRADER' | 'CLIENT_VIEWER';
  readonly status: 'ACTIVE' | 'DISABLED';
  readonly canAcceptQuotes: boolean;
  readonly authenticator: boolean;
}

const maskEmail = (email: string): string => {
  const [local = '', domain = ''] = email.split('@');
  return domain ? `${local.slice(0, 1)}•••@${domain}` : '•••';
};

/** The people of a client: who may decide on quotes, and who has an authenticator. */
export async function clientPeople(ex: Executor, clientId: string): Promise<ClientPerson[]> {
  const rows = await ex
    .selectFrom('client_user as cu')
    .innerJoin('auth_user as u', 'u.id', 'cu.user_id')
    .select(['cu.id', 'u.name', 'u.email', 'cu.role', 'cu.status', 'cu.can_accept_quotes', 'u.two_factor_enabled'])
    .where('cu.client_id', '=', clientId)
    .orderBy('u.name')
    .execute();
  return rows.map((r) => ({
    clientUserId: r.id, name: r.name, email: maskEmail(r.email), role: r.role as ClientPerson['role'], status: r.status as ClientPerson['status'],
    canAcceptQuotes: r.can_accept_quotes, authenticator: r.two_factor_enabled === true,
  }));
}

/** Whether this signed-in person has set up an authenticator (the step-up factor for sensitive changes). */
export async function hasAuthenticator(ex: Executor, userId: string): Promise<boolean> {
  const u = await ex.selectFrom('auth_user').select('two_factor_enabled').where('id', '=', userId).executeTakeFirst();
  return u?.two_factor_enabled === true;
}

