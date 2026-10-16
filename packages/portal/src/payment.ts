import { sql } from 'kysely';
import { Money, upiPayUri } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';
import type { FieldProtector } from '@inrp2p/adapters';
import { collectionInstructions } from '@inrp2p/inr-accounts';
import { COLLECTION_POLICY } from '@inrp2p/treasury';
import { effectiveObligations } from '@inrp2p/trades';

/**
 * A BUY trade's rupees, as its client pays them (ADR 0018): where to pay, under which reference and by when; which of
 * the client's own accounts may pay; and every payment the client or the desk filed, with where it stands. The
 * screen built on this is the whole of "how do I pay" — nothing is left to a message from the desk.
 */
export interface PortalInrPayment {
  /** Null when the trade predates collection instructions, or no account collects: the desk says where to pay. */
  readonly instructions: {
    readonly reference: string;
    readonly payBy: string;
    readonly beneficiaryName: string;
    readonly bankName: string;
    readonly ifsc: string;
    readonly accountNumber: string;
    readonly accountLast4: string;
    readonly upiId: string | null;
    /** The `upi://pay` link with the exact amount and the reference — a QR code on a computer, a tap on a phone. */
    readonly upiLink: string | null;
    readonly rails: readonly string[];
  } | null;
  /** The client's own registered accounts: the only ones it may pay from. */
  readonly fromAccounts: readonly { readonly id: string; readonly holderName: string; readonly bankName: string; readonly last4: string }[];
  readonly payments: readonly {
    readonly ref: string;
    readonly amount: string;
    readonly rail: string;
    readonly utr: string;
    readonly from: { readonly bankName: string; readonly last4: string } | null;
    /** CHECKING until the desk confirms it; RETURNING when it came from someone else; NOT_RECEIVED when the bank never showed it. */
    readonly state: 'CHECKING' | 'CONFIRMED' | 'RETURNING' | 'NOT_RECEIVED';
    readonly filedBy: 'DESK' | 'CLIENT' | 'TRADER';
    readonly filedAt: string;
  }[];
  /** INR the client still has to pay and say so (what is already filed counts as said). */
  readonly due: string;
  /** Whether the client may say "I paid" now. */
  readonly canClaim: boolean;
  readonly upiLimit: string;
}

export async function portalInrPayment(ex: Executor, protector: FieldProtector | null, input: { readonly tradeId: string; readonly clientId: string; readonly lifecycle: string; readonly hold: boolean }): Promise<PortalInrPayment> {
  const [instructions, accounts, legs, obligations] = await Promise.all([
    protector ? collectionInstructions(ex, protector, input.tradeId) : Promise.resolve(null),
    ex
      .selectFrom('bank_account')
      .select(['id', 'holder_name', 'bank_name', 'account_last4'])
      .where('client_id', '=', input.clientId)
      .where('status', '=', 'ACTIVE')
      .orderBy('created_at')
      .execute(),
    sql<{ ref: string; amount_minor: bigint; status: string; created_at: Date; rail: string; utr: string; filed_by: 'DESK' | 'CLIENT' | 'TRADER'; bank_name: string | null; last4: string | null; transfer_status: string; verdict: string }>`
      select l.ref, l.amount_minor, l.status, l.created_at, f.rail, f.utr, f.filed_by, b.bank_name, b.account_last4 as last4, f.status as transfer_status,
             inrp2p_fiat_sender_verdict(f.id) as verdict
      from settlement_leg l
      join transfer_allocation a on a.settlement_leg_id = l.id and a.fiat_transfer_id is not null
      join fiat_transfer f on f.id = a.fiat_transfer_id
      left join bank_account b on b.id = f.payer_bank_account_id
      where l.trade_id = ${input.tradeId} and l.side = 'CLIENT_TO_EXCHANGE' and l.asset = 'INR'
      order by l.created_at`.execute(ex),
    effectiveObligations(ex, input.tradeId),
  ]);

  const filed = legs.rows.filter((l) => l.status === 'PROCESSING' || l.status === 'COMPLETED').reduce((sum, l) => sum + l.amount_minor, 0n);
  const dueMinor = obligations.receivable.minor - filed;
  const due = Money.ofMinor(dueMinor > 0n ? dueMinor : 0n, 'INR');
  const open = input.lifecycle === 'AWAITING_FIRST_LEG' || input.lifecycle === 'FIRST_LEG_DETECTED';
  const upiLimit = Money.parse(COLLECTION_POLICY.upiMaxInr, 'INR');

  return {
    instructions: instructions
      ? {
          reference: instructions.reference,
          payBy: instructions.payBy.toISOString(),
          beneficiaryName: instructions.beneficiaryName,
          bankName: instructions.bankName,
          ifsc: instructions.ifsc,
          accountNumber: instructions.accountNumber,
          accountLast4: instructions.accountLast4,
          upiId: instructions.upiVpa,
          upiLink:
            instructions.upiVpa && due.isPositive() && due.minor <= upiLimit.minor
              ? upiPayUri({ vpa: instructions.upiVpa, payeeName: instructions.beneficiaryName, amount: due.toDecimalString(), note: `INRP2P ${instructions.reference}` })
              : null,
          rails: instructions.rails,
        }
      : null,
    fromAccounts: accounts.map((a) => ({ id: a.id, holderName: a.holder_name, bankName: a.bank_name, last4: a.account_last4 })),
    payments: legs.rows.map((l) => ({
      ref: l.ref,
      amount: Money.ofMinor(l.amount_minor, 'INR').toDecimalString(),
      rail: l.rail,
      utr: l.utr,
      from: l.bank_name && l.last4 ? { bankName: l.bank_name, last4: l.last4 } : null,
      state:
        l.verdict === 'MISMATCH' ? 'RETURNING'
        : l.status === 'COMPLETED' ? 'CONFIRMED'
        : l.status === 'FAILED' ? 'NOT_RECEIVED'
        : 'CHECKING',
      filedBy: l.filed_by,
      filedAt: l.created_at.toISOString(),
    })),
    due: due.toDecimalString(),
    canClaim: open && !input.hold && due.isPositive() && instructions !== null && accounts.length > 0,
    upiLimit: upiLimit.toDecimalString(),
  };
}
