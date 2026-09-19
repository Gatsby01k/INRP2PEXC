import 'server-only';
import { appendFile } from 'node:fs/promises';
import type { EmailOtpSender } from '@inrp2p/identity';
import { optionalEnv } from './env.ts';

/**
 * How a client's sign-in code leaves the server.
 *
 * There is no transactional email provider in V1 (TD-04), so the only honest default is a sender that fails.
 * Failing is not a gap to be patched over with a log line: a login code in a log is a login code in whatever
 * reads the logs, and a code that silently goes nowhere leaves a person staring at a form that will never work.
 *
 * The one alternative is a **file sink**, which exists so an end-to-end run can sign a client in through the real
 * form rather than forging a session row. It is off unless a path is named, and it is refused outright in
 * production — the same shape, and the same reasoning, as `INRP2P_ALLOW_INSECURE_COOKIES`.
 */
export function clientOtpSender(): EmailOtpSender {
  const sink = optionalEnv('INRP2P_CLIENT_OTP_SINK_FILE');
  if (!sink) {
    return {
      send: async () => {
        throw new Error('NOTIFICATION_PROVIDER_NOT_CONFIGURED: no email provider is configured for client sign-in codes');
      },
    };
  }
  if ((optionalEnv('INRP2P_ENV') ?? '').toLowerCase() === 'production') {
    throw new Error('INRP2P_CLIENT_OTP_SINK_FILE must never be set in production');
  }
  return {
    send: async ({ email, otp, type }) => {
      await appendFile(sink, `${JSON.stringify({ email, otp, type, at: new Date().toISOString() })}\n`, 'utf8');
    },
  };
}
