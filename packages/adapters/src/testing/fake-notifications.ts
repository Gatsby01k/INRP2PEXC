import { NotificationDeliveryError, type NotificationAdapter, type NotificationEmail, type OtpEmail } from '../notifications.ts';

/**
 * Captures sent codes and notifications in memory for tests. Like a real provider it is idempotent by delivery id:
 * the same delivery sent twice is one message with one id. `failNext` makes the next send fail — retryable by
 * default (an outage), or permanently (`'PERMANENT'`, the provider refusing it).
 */
export class FakeNotificationAdapter implements NotificationAdapter {
  readonly provider = 'fake-email';
  readonly sent: OtpEmail[] = [];
  readonly notifications: NotificationEmail[] = [];
  readonly #ids = new Map<string, string>();
  failNext: boolean | 'PERMANENT' = false;

  #fail(): void {
    if (!this.failNext) return;
    const permanent = this.failNext === 'PERMANENT';
    this.failNext = false;
    throw permanent ? new NotificationDeliveryError('PROVIDER_REJECTED_422', false, 'fake provider refused it') : new NotificationDeliveryError('PROVIDER_UNAVAILABLE', true, 'fake provider outage');
  }

  async sendAcceptanceCode(message: OtpEmail) {
    this.#fail();
    const known = this.#ids.get(message.deliveryId);
    if (known) return { providerMessageId: known };
    this.sent.push(message);
    const id = `fake-${this.sent.length}`;
    this.#ids.set(message.deliveryId, id);
    return { providerMessageId: id };
  }

  async sendClientNotification(message: NotificationEmail) {
    this.#fail();
    const known = this.#ids.get(message.deliveryId);
    if (known) return { providerMessageId: known };
    this.notifications.push(message);
    const id = `fake-notification-${this.notifications.length}`;
    this.#ids.set(message.deliveryId, id);
    return { providerMessageId: id };
  }

  lastCodeFor(email: string): string | undefined {
    return [...this.sent].reverse().find((m) => m.to === email)?.code;
  }
}
