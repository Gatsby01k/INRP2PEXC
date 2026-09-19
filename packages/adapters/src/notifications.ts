/**
 * Notification port (ARCHITECTURE §6). V1 channel for quote-acceptance codes is email. Implementations must
 * never log the message body; they return the provider message id for delivery records.
 */
export interface OtpEmail {
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
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  /** Absolute URL into the client product, when the message has somewhere to take the reader. */
  readonly link: string | null;
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
    throw new Error('NOTIFICATION_PROVIDER_NOT_CONFIGURED: no email provider is configured for acceptance codes');
  }

  async sendClientNotification(): Promise<{ readonly providerMessageId: string }> {
    throw new Error('NOTIFICATION_PROVIDER_NOT_CONFIGURED: no email provider is configured for client notifications');
  }
}

/** True when this adapter cannot send anything, so a caller can decline to register a channel rather than wedge it. */
export const isNotificationProviderConfigured = (adapter: NotificationAdapter): boolean => !(adapter instanceof UnconfiguredNotificationAdapter);
