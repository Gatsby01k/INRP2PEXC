import type { NotificationAdapter, OtpEmail } from '../notifications.ts';

/** Captures sent codes in memory for tests. */
export class FakeNotificationAdapter implements NotificationAdapter {
  readonly provider = 'fake-email';
  readonly sent: OtpEmail[] = [];
  failNext = false;

  async sendAcceptanceCode(message: OtpEmail) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('fake provider outage');
    }
    this.sent.push(message);
    return { providerMessageId: `fake-${this.sent.length}` };
  }

  lastCodeFor(email: string): string | undefined {
    return [...this.sent].reverse().find((m) => m.to === email)?.code;
  }
}
