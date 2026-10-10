import 'server-only';
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { ResendEmailClient } from '@inrp2p/adapters';
import type { EmailOtpSender } from '@inrp2p/identity';
import { optionalEnv } from './env.ts';

/**
 * Client sign-in OTP delivery.
 *
 * Production: Resend.
 * Development / E2E: optional file sink.
 *
 * OTP values must never be logged or exposed through provider errors.
 */
export function clientOtpSender(): EmailOtpSender {
  const env = (optionalEnv('INRP2P_ENV') ?? '').toLowerCase();
  const sink = optionalEnv('INRP2P_CLIENT_OTP_SINK_FILE');

  /**
   * Test / development file sink.
   * Explicitly forbidden in production.
   */
  if (sink) {
    if (env === 'production') {
      throw new Error(
        'INRP2P_CLIENT_OTP_SINK_FILE must never be set in production',
      );
    }

    return {
      send: async ({ email, otp, type }) => {
        await appendFile(
          sink,
          `${JSON.stringify({
            email,
            otp,
            type,
            at: new Date().toISOString(),
          })}\n`,
          'utf8',
        );
      },
    };
  }

  /**
   * Production email provider.
   */
  const apiKey = optionalEnv('RESEND_API_KEY');
  const from = optionalEnv('RESEND_FROM');

  if (!apiKey || !from) {
    return {
      send: async () => {
        throw new Error(
          'NOTIFICATION_PROVIDER_NOT_CONFIGURED: no email provider is configured for client sign-in codes',
        );
      },
    };
  }

  // The shared Resend client (E1): a timeout per attempt, a few backed-off retries under one idempotency key — so a
  // retried request is the same email — and errors that never carry the code, the address or the key.
  const resend = new ResendEmailClient({ apiKey, from, ...(optionalEnv('RESEND_BASE_URL') ? { baseUrl: optionalEnv('RESEND_BASE_URL')! } : {}) });
  return {
    send: async ({ email, otp }) => {
      await resend.send(
        {
          to: email,
          subject: 'Your INRP2P Exchange sign-in code',
          text: [
            'INRP2P Exchange',
            '',
            `Your sign-in code is: ${otp}`,
            '',
            'This code expires in 10 minutes.',
            '',
            'If you did not request this code, you can ignore this email.',
          ].join('\n'),
          html: signInHtml(otp),
        },
        `client-sign-in/${randomUUID()}`,
      );
    },
  };
}

function signInHtml(otp: string): string {
  return `
            <!doctype html>
            <html>
              <body style="
                margin:0;
                padding:0;
                background:#F7F5F0;
                font-family:Arial,Helvetica,sans-serif;
                color:#171717;
              ">
                <div style="
                  max-width:520px;
                  margin:0 auto;
                  padding:48px 24px;
                ">
                  <div style="
                    font-size:20px;
                    font-weight:700;
                    letter-spacing:-0.3px;
                    margin-bottom:40px;
                  ">
                    INRP2P Exchange
                  </div>

                  <div style="
                    background:#FFFFFF;
                    border:1px solid #E8E5DE;
                    border-radius:16px;
                    padding:32px;
                  ">
                    <div style="
                      font-size:14px;
                      color:#6B6F77;
                      margin-bottom:12px;
                    ">
                      Sign-in code
                    </div>

                    <div style="
                      font-size:34px;
                      line-height:1;
                      font-weight:700;
                      letter-spacing:8px;
                      margin-bottom:24px;
                    ">
                      ${otp}
                    </div>

                    <div style="
                      font-size:14px;
                      line-height:1.6;
                      color:#6B6F77;
                    ">
                      This code expires in 10 minutes.
                      If you did not request this code, you can ignore this email.
                    </div>
                  </div>

                  <div style="
                    margin-top:20px;
                    font-size:12px;
                    color:#8A8D93;
                  ">
                    INRP2P Exchange · USDT ↔ INR OTC
                  </div>
                </div>
              </body>
            </html>
          `;
}
