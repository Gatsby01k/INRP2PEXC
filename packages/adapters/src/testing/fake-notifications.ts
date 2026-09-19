import type { NotificationAdapter, NotificationEmail, OtpEmail } from '../notifications.ts';

/** Captures sent codes and notifications in memory for tests. */
export class FakeNotificationAdapter implements NotificationAdapter {
  readonly provider = 'fake-email';
  readonly sent: OtpEmail[] = [];
  readonly notifications: NotificationEmail[] = [];
  failNext = false;

  async sendAcceptanceCode(message: OtpEmail) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('fake provider outage');
    }
    this.sent.push(message);
    return { providerMessageId: `fake-${this.sent.length}` };
  }

  async sendClientNotification(message: NotificationEmail) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('fake provider outage');
    }
    this.notifications.push(message);
    return { providerMessageId: `fake-notification-${this.notifications.length}` };
  }

  lastCodeFor(email: string): string | undefined {
    return [...this.sent].reverse().find((m) => m.to === email)?.code;
  }
}
