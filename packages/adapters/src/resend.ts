import { NotificationDeliveryError, type NotificationAdapter, type NotificationEmail, type OtpEmail, UnconfiguredNotificationAdapter } from './notifications.ts';

/**
 * Email through Resend's HTTP API (production task E1, TD-04).
 *
 * What a send guarantees, and what it never does:
 * - **One email per delivery.** Every request carries an `Idempotency-Key` derived from the caller's delivery id, so
 *   a send retried — here, after a timeout, or by the outbox after a crash — is answered with the original email,
 *   never a second one.
 * - **Bounded.** Each attempt has a timeout and the retries are few and backed off; past them the failure goes back
 *   to the caller, whose delivery row stays pending and visible, and the outbox tries again later.
 * - **Honest.** Success is a provider message id. An answer without one is ambiguous and is a retryable failure, not
 *   a delivery. A refusal (validation, authentication, a domain not verified) is permanent: retrying will not help.
 * - **Quiet.** Nothing here logs, and no error carries the message, the code inside it, the address or the API key:
 *   errors are a status and the provider's error name.
 */
export interface ResendOptions {
  readonly apiKey: string;
  /** `Name <address@domain>` — an address on a domain verified with Resend. */
  readonly from: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly retryBaseDelayMs?: number;
}

export interface ResendEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
/** Resend's 409s: one is "the same key is still being processed" (wait), the other "the key was used for another email" (never). */
const RETRYABLE_409 = new Set(['concurrent_idempotent_requests']);

export class ResendEmailClient {
  readonly #opts: ResendOptions;
  constructor(opts: ResendOptions) {
    if (!opts.apiKey || !opts.from) throw new Error('Resend needs an API key and a from address');
    this.#opts = opts;
  }

  async send(email: ResendEmail, idempotencyKey: string): Promise<{ readonly id: string }> {
    if (!/^[\w:/.-]{8,256}$/.test(idempotencyKey)) throw new NotificationDeliveryError('INVALID_IDEMPOTENCY_KEY', false);
    const fetchImpl = this.#opts.fetchImpl ?? fetch;
    const retries = this.#opts.retries ?? 2;
    const url = `${(this.#opts.baseUrl ?? 'https://api.resend.com').replace(/\/$/, '')}/emails`;
    const body = JSON.stringify({ from: this.#opts.from, to: [email.to], subject: email.subject, text: email.text, ...(email.html ? { html: email.html } : {}) });
    let last = new NotificationDeliveryError('PROVIDER_UNREACHABLE', true);
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, (this.#opts.retryBaseDelayMs ?? 250) * 2 ** (attempt - 1)));
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.#opts.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey, 'User-Agent': 'inrp2p-exchange' },
          body,
          signal: AbortSignal.timeout(this.#opts.timeoutMs ?? 8_000),
        });
      } catch (e) {
        // A timeout is ambiguous — the email may have been accepted — and the idempotency key makes retrying safe.
        last = new NotificationDeliveryError((e as Error).name === 'TimeoutError' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNREACHABLE', true);
        continue;
      }
      let parsed: { id?: unknown; name?: unknown } = {};
      try {
        parsed = (await res.json()) as typeof parsed;
      } catch {
        parsed = {};
      }
      const name = typeof parsed.name === 'string' && /^[a-z_]{1,60}$/.test(parsed.name) ? parsed.name : '';
      if (res.ok) {
        if (typeof parsed.id === 'string' && parsed.id.length > 0 && parsed.id.length <= 200) return { id: parsed.id };
        last = new NotificationDeliveryError('PROVIDER_AMBIGUOUS', true, `status ${res.status} without a message id`);
        continue;
      }
      if (res.status === 409 && RETRYABLE_409.has(name)) {
        last = new NotificationDeliveryError('PROVIDER_BUSY', true, name);
        continue;
      }
      if (RETRYABLE_STATUS.has(res.status)) {
        last = new NotificationDeliveryError(res.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_UNAVAILABLE', true, `status ${res.status}${name ? ` ${name}` : ''}`);
        continue;
      }
      throw new NotificationDeliveryError(`PROVIDER_REJECTED_${res.status}`, false, name);
    }
    throw last;
  }
}

const IST = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * The worker's email channel through Resend: acceptance codes (only the code, the quote reference and the expiry —
 * SECURITY §2.3, no amount, bank or wallet detail) and client notifications (the inbox's own words and a link back).
 */
export class ResendNotificationAdapter implements NotificationAdapter {
  readonly provider = 'resend';
  readonly #client: ResendEmailClient;
  constructor(opts: ResendOptions) {
    this.#client = new ResendEmailClient(opts);
  }

  async sendAcceptanceCode(message: OtpEmail): Promise<{ readonly providerMessageId: string }> {
    const until = `${IST.format(message.expiresAt)} IST`;
    const text = [
      'INRP2P Exchange',
      '',
      `Your code to decide on quote ${message.quoteRef} is: ${message.code}`,
      '',
      `It works until ${until}, once. Enter it on the quote page; nobody from INRP2P will ever ask you for it.`,
      '',
      'If you did not ask for this code, ignore this email and tell your INRP2P contact.',
    ].join('\n');
    const sent = await this.#client.send({ to: message.to, subject: `Your code for quote ${message.quoteRef}`, text }, `otp-delivery/${message.deliveryId}`);
    return { providerMessageId: sent.id };
  }

  async sendClientNotification(message: NotificationEmail): Promise<{ readonly providerMessageId: string }> {
    const text = [message.body, ...(message.link ? ['', `Open it: ${message.link}`] : []), '', '— INRP2P Exchange'].join('\n');
    const sent = await this.#client.send({ to: message.to, subject: message.subject, text }, `client-notification-email/${message.deliveryId}`);
    return { providerMessageId: sent.id };
  }
}

/**
 * The email channel the environment configures: Resend when `RESEND_API_KEY` and `RESEND_FROM` are set, otherwise the
 * unconfigured adapter that fails every send loudly. Production never gets a fake or a sink from here, and refuses a
 * provider base URL that is not HTTPS.
 */
export function notificationAdapterFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): NotificationAdapter {
  const apiKey = (env.RESEND_API_KEY ?? '').trim();
  const from = (env.RESEND_FROM ?? '').trim();
  if (!apiKey || !from) return new UnconfiguredNotificationAdapter();
  const baseUrl = (env.RESEND_BASE_URL ?? '').trim() || undefined;
  if (baseUrl && (env.INRP2P_ENV ?? '').toLowerCase() === 'production' && !baseUrl.startsWith('https://')) {
    throw new Error('RESEND_BASE_URL must be https in production');
  }
  return new ResendNotificationAdapter({ apiKey, from, ...(baseUrl ? { baseUrl } : {}), ...(fetchImpl ? { fetchImpl } : {}) });
}
