import { requireUuid } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';

/** Masked destination views. Sealed values never leave the module through queries. */
export interface BankAccountView {
  readonly id: string;
  readonly clientId: string;
  readonly holderName: string;
  readonly bankName: string;
  readonly ifsc: string;
  readonly last4: string;
  readonly rails: readonly string[];
  readonly status: 'ACTIVE' | 'ARCHIVED';
}

export async function listBankAccounts(ex: Executor, clientId: string, opts: { includeArchived?: boolean } = {}): Promise<BankAccountView[]> {
  let q = ex
    .selectFrom('bank_account')
    .select(['id', 'client_id', 'holder_name', 'bank_name', 'ifsc', 'account_last4', 'rail_preferences', 'status'])
    .where('client_id', '=', requireUuid(clientId, 'clientId'));
  if (!opts.includeArchived) q = q.where('status', '=', 'ACTIVE');
  const rows = await q.orderBy('created_at', 'desc').execute();
  return rows.map((r) => ({ id: r.id, clientId: r.client_id, holderName: r.holder_name, bankName: r.bank_name, ifsc: r.ifsc, last4: r.account_last4, rails: r.rail_preferences, status: r.status }));
}

/** Destination check used by request/quote acceptance (Phase 3): the account must be ACTIVE and owned by the client. */
export async function isActiveBankAccountOfClient(ex: Executor, clientId: string, bankAccountId: string): Promise<boolean> {
  const r = await ex.selectFrom('bank_account').select('id').where('id', '=', bankAccountId).where('client_id', '=', clientId).where('status', '=', 'ACTIVE').executeTakeFirst();
  return Boolean(r);
}

export async function isActiveWalletOfClient(ex: Executor, clientId: string, walletId: string, purpose: 'SOURCE' | 'DESTINATION'): Promise<boolean> {
  const r = await ex
    .selectFrom('crypto_wallet')
    .select('id')
    .where('id', '=', walletId)
    .where('client_id', '=', clientId)
    .where('status', '=', 'ACTIVE')
    .where('purpose', 'in', [purpose, 'BOTH'])
    .executeTakeFirst();
  return Boolean(r);
}

/**
 * Authorized quote acceptors of a client (D-01): active client users with `can_accept_quotes`, active login
 * and an email verified by Better Auth. Emails are returned masked only.
 */
export async function listAuthorizedAcceptors(ex: Executor, clientId: string): Promise<Array<{ clientUserId: string; maskedEmail: string }>> {
  const rows = await ex
    .selectFrom('client_user as cu')
    .innerJoin('auth_user as u', 'u.id', 'cu.user_id')
    .select(['cu.id', 'u.email'])
    .where('cu.client_id', '=', requireUuid(clientId, 'clientId'))
    .where('cu.status', '=', 'ACTIVE')
    .where('cu.can_accept_quotes', '=', true)
    .where('u.status', '=', 'ACTIVE')
    .where('u.email_verified', '=', true)
    .orderBy('cu.created_at')
    .execute();
  return rows.map((r) => {
    const [local = '', domain = ''] = r.email.split('@');
    return { clientUserId: r.id, maskedEmail: `${local.slice(0, 1)}•••@${domain}` };
  });
}
