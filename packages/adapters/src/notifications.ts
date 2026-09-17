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

export interface NotificationAdapter {
  readonly provider: string;
  /** Sends the acceptance code email. Contains only code, quote reference and expiry (SECURITY §2.3). */
  sendAcceptanceCode(message: OtpEmail): Promise<{ readonly providerMessageId: string }>;
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
}
