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

/**
 * A UPI ID the client registered (ADR 0029): shown in full to its own people — an address is what they check — with its
 * own limits, whether a deal has shown it is the client's own yet (ADR 0030), and why it is paused when a payer's app
 * showed another name.
 */
export interface ClientUpiId {
  readonly id: string;
  readonly vpa: string;
  readonly holderName: string;
  readonly verifiedName: string | null;
  readonly label: string | null;
  /** Decimal rupees. */
  readonly perPaymentLimit: string;
  readonly dailyLimit: string | null;
  /** ACTIVE: live. PENDING_REVIEW: paused — a payer's app showed another name, and INRP2P is checking. REJECTED: not the client's. */
  readonly status: DestinationStatus;
  /** Why the desk did not put it back, when it did not. */
  readonly reviewNote: string | null;
  /** A deal (or INRP2P) showed it is the client's own: its own limits apply; until then, the first deals' limit. */
  readonly nameConfirmed: boolean;
  /** When a payer said its app showed another name. */
  readonly reportedAt: string | null;
}

export interface ClientDestinations {
  readonly banks: readonly ClientBankAccount[];
  readonly wallets: readonly ClientWallet[];
  readonly upiIds: readonly ClientUpiId[];
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
  // Waiting and refused ones are the client's to see: it added them, and is told why one was not verified.
  let upis = ex
    .selectFrom('upi_id')
    .select(['id', 'vpa', 'holder_name', 'verified_name', 'label', 'per_payment_limit_minor', 'daily_limit_minor', 'status', 'review_note', 'name_confirmed_at', 'reported_at'])
    .where('client_id', '=', clientId)
    .orderBy('created_at', 'asc');
  if (!opts.includeArchived) {
    banks = banks.where('status', '=', 'ACTIVE');
    wallets = wallets.where('status', '=', 'ACTIVE');
    upis = upis.where('status', 'in', ['ACTIVE', 'PENDING_REVIEW', 'REJECTED']);
  }

  const [bankRows, walletRows, upiRows] = await Promise.all([banks.execute(), wallets.execute(), upis.execute()]);
  return clientSafe({
    banks: bankRows.map((b) => ({
      id: b.id,
      bankName: b.bank_name,
      ifsc: b.ifsc,
      last4: b.account_last4,
      holderName: b.holder_name,
      rails: b.rail_preferences,
      status: b.status,
      verified: b.verified_at !== null,
    })),
    wallets: walletRows.map((w) => ({
      id: w.id,
      network: w.network,
      address: w.address,
      label: w.label,
      purpose: w.purpose,
      status: w.status,
    })),
    upiIds: upiRows.map((u) => ({
      id: u.id,
      vpa: u.vpa,
      holderName: u.holder_name,
      verifiedName: u.verified_name,
      label: u.label,
      perPaymentLimit: rupees(u.per_payment_limit_minor),
      dailyLimit: u.daily_limit_minor === null ? null : rupees(u.daily_limit_minor),
      status: u.status,
      reviewNote: u.review_note,
      nameConfirmed: u.name_confirmed_at !== null,
      reportedAt: u.reported_at?.toISOString() ?? null,
    })),
  });
}

/** Paise as decimal rupees, without a float on the way. */
const rupees = (minor: bigint): string => {
  const whole = minor / 100n;
  const paise = minor % 100n;
  return paise === 0n ? whole.toString() : `${whole}.${paise.toString().padStart(2, '0')}`;
};

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

