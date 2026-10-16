import { normalizeVpa } from '@inrp2p/kernel';

/**
 * Who sent a credit, as far as a bank statement's narration says (ADR 0018). Indian banks follow no one template —
 * `UPI/412345678901/RAHUL KUMAR/rahul@okhdfcbank/Payment`, `IMPS/P2A/612345678901/RAJESH K/SBIN0001234`,
 * `NEFT-HDFCN52026101612345-RAHUL KUMAR SHARMA-…` — but they all put the same few facts between separators: the rail,
 * a reference, the remitter's name, a UPI ID or an IFSC, sometimes a masked account. This reads those facts and
 * nothing more; what it cannot place it leaves null, and the desk sees the narration itself beside the verdict.
 */
export interface NarrationSender {
  readonly name: string | null;
  readonly vpa: string | null;
  /** Digits of the sending account the bank printed (often masked: `XXXXXX1234` → `1234`). */
  readonly accountDigits: string | null;
}

/** Words that are the rail, the direction or the bank — never the person. */
const NOT_A_NAME = new Set([
  'UPI', 'IMPS', 'NEFT', 'RTGS', 'MMT', 'P2A', 'P2P', 'P2M', 'CR', 'DR', 'CREDIT', 'DEBIT', 'TRANSFER', 'TRF', 'FT', 'INB', 'MOB', 'NET',
  'PAYMENT', 'PAY', 'SENT', 'RECEIVED', 'FROM', 'TO', 'BY', 'VIA', 'REF', 'NO', 'NA', 'NULL', 'UPIINTENT', 'COLLECT', 'INTENT', 'REQUEST',
  'HDFC', 'ICICI', 'ICIC', 'SBI', 'SBIN', 'AXIS', 'UTIB', 'KOTAK', 'KKBK', 'YESB', 'YES', 'PUNB', 'PNB', 'BARB', 'BOB', 'CNRB', 'CANARA',
  'UBIN', 'IDIB', 'IOBA', 'BKID', 'INDB', 'FDRL', 'IDFB', 'IDFC', 'AIRP', 'PYTM', 'PAYTM', 'PHONEPE', 'GPAY', 'GOOGLE', 'BHIM', 'AU', 'AUBL',
]);
/** Words of a remark, which a person's name never contains ("Payment from Ph", "Sent via GPay"). */
const REMARK = new Set(['PAYMENT', 'FROM', 'SENT', 'RECEIVED', 'TRANSFER', 'REQUEST', 'COLLECT', 'INTENT', 'VIA', 'REF', 'RENT']);
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const MASKED_ACCOUNT = /^(?:A\/?C\s*)?[X*]{2,}\d{3,6}$|^\d{9,18}$/i;

function isNameLike(part: string): boolean {
  const words = part.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  if (!words.every((w) => /^[A-Z.]+$/.test(w))) return false;
  if (words.every((w) => NOT_A_NAME.has(w.replace(/\./g, '')))) return false;
  if (words.some((w) => w.includes('BANK') || REMARK.has(w.replace(/\./g, '')))) return false;
  if (words.length === 1 && IFSC.test(words[0]!)) return false;
  return words.join('').replace(/\./g, '').length >= 2;
}

export function readNarration(description: string | null | undefined): NarrationSender {
  if (!description) return { name: null, vpa: null, accountDigits: null };
  // Separators: slashes, pipes and colons always; hyphens only between fields (a hyphen inside a word stays).
  const parts = description
    .split(/[/|:]|\s-\s|-(?=[A-Z0-9]{3,})|(?<=[A-Z0-9]{3,})-/i)
    .map((p) => p.trim())
    .filter(Boolean);
  let vpa: string | null = null;
  let accountDigits: string | null = null;
  const names: string[] = [];
  for (const part of parts) {
    const asVpa = normalizeVpa(part.replace(/\s+/g, ''));
    if (!vpa && asVpa) {
      vpa = asVpa;
      continue;
    }
    if (!accountDigits && MASKED_ACCOUNT.test(part.replace(/\s+/g, '')) && !/^\d{12}$/.test(part)) {
      const digits = part.replace(/\D/g, '');
      accountDigits = digits.slice(-4);
      continue;
    }
    if (isNameLike(part)) names.push(part.trim().toUpperCase().replace(/\s+/g, ' '));
  }
  // The remitter is the longest name-like field: a bank code or a remark ("RENT") is shorter than a person's name.
  const name = names.sort((a, b) => b.length - a.length)[0] ?? null;
  return { name, vpa, accountDigits };
}
