/**
 * Redaction applied to every audit before/after payload (SECURITY §5, §8). Raw bank account
 * numbers, UTRs, secrets, OTPs and tokens never reach the audit log.
 */
const DROP_KEYS = /^(password|password_hash|secret|totp_secret|backup_codes|otp|code|token|session_token|access_token|refresh_token|id_token|private_key|mnemonic|seed)$/i;
const LAST4_KEYS = /^(account_number|accountnumber|bank_account_number|utr|utr_normalized|card_number|phone|phone_number|whatsapp_number)$/i;
const EMAIL_KEYS = /^(email|contact_email)$/i;

export const REDACTED = '[REDACTED]';

export function maskLast4(value: string): string {
  const s = String(value);
  return s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
}

export function maskEmail(value: string): string {
  const [local = '', domain = ''] = String(value).split('@');
  if (!domain) return REDACTED;
  return `${local.slice(0, 1)}•••@${domain}`;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 20) return REDACTED;
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (typeof (value as { toJSON?: unknown }).toJSON === 'function') return redact((value as { toJSON: () => unknown }).toJSON(), depth + 1);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DROP_KEYS.test(k)) out[k] = REDACTED;
      else if (LAST4_KEYS.test(k) && v !== null && v !== undefined) out[k] = maskLast4(String(v));
      else if (EMAIL_KEYS.test(k) && typeof v === 'string') out[k] = maskEmail(v);
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return value;
}
