/** Masking helpers — the only way components render sensitive identifiers (SECURITY §5). */
export function maskUtr(utr: string): string {
  const s = utr.trim();
  return s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
}

export function maskAccount(last4: string): string {
  if (!/^\d{4}$/.test(last4)) throw new Error('maskAccount expects the last four digits only');
  return `•••• ${last4}`;
}

export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return domain ? `${local.slice(0, 1)}•••@${domain}` : '•••';
}

/** TRON address: first 3, last 4 — "TXq…9fA2". */
export function shortenAddress(address: string, head = 3, tail = 4): string {
  return address.length <= head + tail + 1 ? address : `${address.slice(0, head)}…${address.slice(-tail)}`;
}

/** Transaction hash: "7c1e…a90b". */
export function shortenHash(hash: string): string {
  const h = hash.replace(/^0x/, '');
  return h.length <= 9 ? h : `${h.slice(0, 4)}…${h.slice(-4)}`;
}
