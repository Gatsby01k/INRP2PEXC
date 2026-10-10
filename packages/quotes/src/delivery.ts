import { sql } from 'kysely';
import { DomainError, requireUuid } from '@inrp2p/kernel';
import type { Db } from '@inrp2p/db';
import type { NotificationAdapter } from '@inrp2p/adapters';
import type { OutboxHandler } from '@inrp2p/outbox';
import { type QuoteDeps, policyOf } from './policy.ts';
import { otpSealContext } from './challenges.ts';

export type DeliveryOutcome = 'SENT' | 'ALREADY_ERASED' | 'CHALLENGE_CLOSED';

/**
 * Delivers an acceptance code (SECURITY §2.3). The code lives only in the sealed `otp_delivery` row: it is opened
 * here, handed to the email provider and erased in the same step, so it never reaches the outbox payload, the audit
 * trail or any log.
 *
 * The delivery row is locked for the whole send. Closing a challenge (a new code requested, the quote decided or
 * expired) erases its code under that same row, so the two are ordered: either the code was sent while its challenge
 * was still open, or the challenge closed first and nothing is sent. A code past its expiry is never sent either.
 *
 * Delivery is at-least-once and idempotent: the provider is asked under the delivery's id, so a send retried after a
 * crash or a timeout is the same email; once erased, a retry is a no-op; a code is never regenerated for an existing
 * challenge. A failed or ambiguous send throws — the code stays sealed and the outbox tries again — and is never
 * recorded as delivered.
 */
export async function deliverAcceptanceCode(db: Db, deps: Pick<QuoteDeps, 'protector' | 'policy'>, notifications: NotificationAdapter, input: { deliveryId: string }): Promise<DeliveryOutcome> {
  const deliveryId = requireUuid(input.deliveryId, 'deliveryId');
  policyOf(deps);
  return db.transaction().execute(async (tx) => {
    const locked = await tx.selectFrom('otp_delivery').select(['id', 'code_sealed', 'challenge_id']).where('id', '=', deliveryId).forUpdate().executeTakeFirst();
    if (!locked) throw new DomainError('NOT_FOUND', 'otp delivery not found');
    if (!locked.code_sealed) return 'ALREADY_ERASED' as const;
    const row = await tx
      .selectFrom('acceptance_challenge as c')
      .innerJoin('quote as q', 'q.id', 'c.quote_id')
      .innerJoin('client_user as cu', 'cu.id', 'c.client_user_id')
      .innerJoin('auth_user as u', 'u.id', 'cu.user_id')
      .select(['c.id as challenge_id', 'c.status as challenge_status', 'c.expires_at', sql<boolean>`c.expires_at <= inrp2p_now()`.as('expired'), 'q.ref as quote_ref', 'u.email', 'u.email_verified'])
      .where('c.id', '=', locked.challenge_id)
      .executeTakeFirstOrThrow();
    if (row.challenge_status !== 'PENDING' || row.expired) {
      // The challenge was superseded, consumed, closed or has run out before the email went out: erase, never send.
      await tx.updateTable('otp_delivery').set({ code_sealed: null, erased_reason: 'CHALLENGE_CLOSED' }).where('id', '=', locked.id).where('code_sealed', 'is not', null).execute();
      return 'CHALLENGE_CLOSED' as const;
    }
    if (!row.email_verified) throw new DomainError('OTP_RECIPIENT_INVALID', 'recipient email is not verified');

    const code = await deps.protector.open(locked.code_sealed, otpSealContext(row.challenge_id));
    const { providerMessageId } = await notifications.sendAcceptanceCode({ deliveryId: locked.id, to: row.email, code, quoteRef: row.quote_ref, expiresAt: row.expires_at });
    await tx
      .updateTable('otp_delivery')
      .set({ code_sealed: null, erased_reason: 'DELIVERED', delivered_at: sql<Date>`inrp2p_now()`, provider_message_id: providerMessageId.slice(0, 200) })
      .where('id', '=', locked.id)
      .where('code_sealed', 'is not', null)
      .execute();
    return 'SENT' as const;
  });
}

/** Outbox handler for `acceptance_otp.deliver`; wire it into the worker's handler list. */
export function acceptanceCodeHandler(db: Db, deps: Pick<QuoteDeps, 'protector' | 'policy'>, notifications: NotificationAdapter): OutboxHandler {
  return {
    name: 'acceptance_code_email',
    handles: (type) => type === 'acceptance_otp.deliver',
    run: async (event) => {
      const payload = event.payload as { deliveryId?: unknown };
      await deliverAcceptanceCode(db, deps, notifications, { deliveryId: String(payload.deliveryId ?? '') });
    },
  };
}
