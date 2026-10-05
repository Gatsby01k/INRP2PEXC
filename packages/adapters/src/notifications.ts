/**
 * Notification port (ARCHITECTURE §6). V1 channel for quote-acceptance codes is email. Implementations must
 * never log the message body; they return the provider message id for delivery records.
 *
 * Every message names the delivery row it is (`deliveryId`). An implementation sends it under that identity — the
 * provider's idempotency key — so a send retried after a crash, a timeout or an ambiguous answer is the same email,
 * never a second one. A failure is thrown as a `NotificationDeliveryError` saying whether trying again can help; an
 * implementation never reports success it did not get (no provider message id, no success).
 */
export interface OtpEmail {
  readonly deliveryId: string;
  readonly to: string;
  readonly code: string;
  readonly quoteRef: string;
  readonly expiresAt: Date;
}

/**
 * A client notification sent by email. It carries the same sentence the in-app inbox shows and a path back into
 * the client product — never a figure the inbox would not show, and never anything internal to the desk.
 */
export interface NotificationEmail {
  readonly deliveryId: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  /** Absolute URL into the client product, when the message has somewhere to take the reader. */
  readonly link: string | null;
}

/**
 * Why an email did not go. `code` is a short machine word (`PROVIDER_TIMEOUT`, `PROVIDER_REJECTED_422`…) safe to
 * store and log: it never carries the message, the code inside it, the address or a credential. `retryable` says
 * whether the same delivery may be tried again (an outage, a rate limit, an ambiguous answer) or never will succeed
 * as it is (the provider refused it).
 */
export class NotificationDeliveryError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, retryable: boolean, detail = '') {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'NotificationDeliveryError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** The safe description of any failure from a send: a `NotificationDeliveryError` as is, anything else retryable. */
export function deliveryFailureOf(err: unknown): { code: string; retryable: boolean } {
  if (err instanceof NotificationDeliveryError) return { code: err.code, retryable: err.retryable };
  return { code: 'PROVIDER_ERROR', retryable: true };
}

export interface NotificationAdapter {
  readonly provider: string;
  /** Sends the acceptance code email. Contains only code, quote reference and expiry (SECURITY §2.3). */
  sendAcceptanceCode(message: OtpEmail): Promise<{ readonly providerMessageId: string }>;
  /** Sends a client notification (quote ready, trade settled). Same text as the in-app inbox. */
  sendClientNotification(message: NotificationEmail): Promise<{ readonly providerMessageId: string }>;
}

/**
 * Used when no email provider is configured: every send fails loudly, so undelivered codes stay visible as failed
 * outbox deliveries instead of disappearing. There is intentionally no logging adapter (codes must not reach logs).
 */
export class UnconfiguredNotificationAdapter implements NotificationAdapter {
  readonly provider = 'unconfigured';
  async sendAcceptanceCode(): Promise<{ readonly providerMessageId: string }> {
    throw new NotificationDeliveryError('NOTIFICATION_PROVIDER_NOT_CONFIGURED', true, 'no email provider is configured for acceptance codes');
  }

  async sendClientNotification(): Promise<{ readonly providerMessageId: string }> {
    throw new NotificationDeliveryError('NOTIFICATION_PROVIDER_NOT_CONFIGURED', true, 'no email provider is configured for client notifications');
  }
}

/** True when this adapter cannot send anything, so a caller can decline to register a channel rather than wedge it. */
export const isNotificationProviderConfigured = (adapter: NotificationAdapter): boolean => !(adapter instanceof UnconfiguredNotificationAdapter);
