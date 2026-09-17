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
 * trail or any log. Delivery is at-least-once and idempotent — once erased, a retry is a no-op, and a code is never
 * regenerated for an existing challenge.
 */
export async function deliverAcceptanceCode(db: Db, deps: Pick<QuoteDeps, 'protector' | 'policy'>, notifications: NotificationAdapter, input: { deliveryId: string }): Promise<DeliveryOutcome> {
  const deliveryId = requireUuid(input.deliveryId, 'deliveryId');
  policyOf(deps);
  const row = await db
    .selectFrom('otp_delivery as d')
    .innerJoin('acceptance_challenge as c', 'c.id', 'd.challenge_id')
    .innerJoin('quote as q', 'q.id', 'c.quote_id')
    .innerJoin('client_user as cu', 'cu.id', 'c.client_user_id')
    .innerJoin('auth_user as u', 'u.id', 'cu.user_id')
    .select(['d.id as delivery_id', 'd.code_sealed', 'c.id as challenge_id', 'c.status as challenge_status', 'c.expires_at', 'q.ref as quote_ref', 'u.email', 'u.email_verified'])
    .where('d.id', '=', deliveryId)
    .executeTakeFirst();
  if (!row) throw new DomainError('NOT_FOUND', 'otp delivery not found');
  if (!row.code_sealed) return 'ALREADY_ERASED';
  if (row.challenge_status !== 'PENDING') {
    // The challenge was superseded, consumed or closed before the email went out: erase instead of sending.
    await db.updateTable('otp_delivery').set({ code_sealed: null, erased_reason: 'CHALLENGE_CLOSED' }).where('id', '=', row.delivery_id).where('code_sealed', 'is not', null).execute();
    return 'CHALLENGE_CLOSED';
  }
  if (!row.email_verified) throw new DomainError('OTP_RECIPIENT_INVALID', 'recipient email is not verified');

  const code = await deps.protector.open(row.code_sealed, otpSealContext(row.challenge_id));
  const { providerMessageId } = await notifications.sendAcceptanceCode({ to: row.email, code, quoteRef: row.quote_ref, expiresAt: row.expires_at });
  await db
    .updateTable('otp_delivery')
    .set({ code_sealed: null, erased_reason: 'DELIVERED', delivered_at: sql<Date>`inrp2p_now()`, provider_message_id: providerMessageId.slice(0, 200) })
    .where('id', '=', row.delivery_id)
    .where('code_sealed', 'is not', null)
    .execute();
  return 'SENT';
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
