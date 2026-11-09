import { DomainError } from './errors.ts';

/**
 * The facts of an Indian bank payment the exchange can check on its own (ADR 0018, "clean INR"): who sent it, under
 * which reference, and how a client can be asked to pay. Pure functions — no database, no clock — so the client's
 * screen, the desk and the statement import all reach the same verdict on the same inputs.
 */

export type InrRail = 'IMPS' | 'NEFT' | 'RTGS' | 'UPI';

// ---------------------------------------------------------------------------------------------------------------
// Payment references (UTR)
// ---------------------------------------------------------------------------------------------------------------

/** Trimmed, upper-cased, spaces removed — exactly how FI-22 compares references. */
export function normalizeUtr(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/**
 * The shape each rail's reference has, as banks print it. UPI and IMPS carry the 12-digit retrieval reference (RRN);
 * NEFT a 16-character UTR (bank code, `N`, then the sequence); RTGS a 22-character one. Some banks print the NEFT
 * reference with a few more characters, so NEFT and RTGS accept 16–22. These are the shapes a client is asked for;
 * the desk, which reads statements, stays free to record what the bank actually printed.
 */
const UTR_SHAPES: Record<InrRail, RegExp> = {
  UPI: /^[0-9]{12}$/,
  IMPS: /^[0-9]{12}$/,
  NEFT: /^[A-Z0-9]{16,22}$/,
  RTGS: /^[A-Z0-9]{16,22}$/,
};

const UTR_HINTS: Record<InrRail, string> = {
  UPI: 'a UPI reference is the 12-digit UTR (also called RRN) in your payment app',
  IMPS: 'an IMPS reference is the 12-digit reference number your bank shows',
  NEFT: 'a NEFT reference is the 16-character UTR your bank shows',
  RTGS: 'an RTGS reference is the 22-character UTR your bank shows',
};

/** Whether a reference has the shape of its rail, and if not, what the client should look for instead. */
export function checkUtrShape(rail: InrRail, raw: string): { readonly ok: true; readonly utr: string } | { readonly ok: false; readonly hint: string } {
  const utr = normalizeUtr(raw);
  return UTR_SHAPES[rail].test(utr) ? { ok: true, utr } : { ok: false, hint: UTR_HINTS[rail] };
}

/** Throws `INVALID_UTR` unless the reference has its rail's shape; returns it normalized. */
export function requireUtrShape(rail: InrRail, raw: unknown): string {
  if (typeof raw !== 'string') throw new DomainError('INVALID_UTR', 'the payment reference is required');
  const checked = checkUtrShape(rail, raw);
  if (!checked.ok) throw new DomainError('INVALID_UTR', `that does not look like a ${rail} reference: ${checked.hint}`, { rail });
  return checked.utr;
}

/**
 * The rails a reference could belong to, judged by its shape alone: 12 digits is UPI or IMPS (the screen asks which),
 * 22 characters is RTGS, 16 is NEFT. An empty list means it is no rail's reference.
 */
export function railsForUtr(raw: string): readonly InrRail[] {
  const utr = normalizeUtr(raw);
  if (/^[0-9]{12}$/.test(utr)) return ['UPI', 'IMPS'];
  if (/^[A-Z0-9]{22}$/.test(utr)) return ['RTGS', 'NEFT'];
  if (/^[A-Z0-9]{16,21}$/.test(utr)) return ['NEFT', 'RTGS'];
  return [];
}

// ---------------------------------------------------------------------------------------------------------------
// UPI
// ---------------------------------------------------------------------------------------------------------------

const VPA = /^[a-z0-9][a-z0-9._-]{1,255}@[a-z][a-z0-9.-]{1,63}$/;

/** A UPI ID (virtual payment address), lower-cased; null when it is not one. */
export function normalizeVpa(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const vpa = raw.trim().toLowerCase();
  return VPA.test(vpa) ? vpa : null;
}

export function requireVpa(raw: unknown, field = 'upiId'): string {
  const vpa = normalizeVpa(raw);
  if (!vpa) throw new DomainError('INVALID_ARGUMENT', `${field} must be a UPI ID such as name@bank`);
  return vpa;
}

/**
 * The `upi://pay` link every UPI app opens (NPCI's linking specification): payee address and name, the exact amount,
 * INR, and a note carrying the trade's payment reference so the credit can be recognised on the statement. Scanned
 * as a QR code or opened on a phone, it fills the payment in; the client only approves it with their UPI PIN.
 */
export function upiPayUri(input: { readonly vpa: string; readonly payeeName: string; readonly amount: string; readonly note: string }): string {
  const vpa = requireVpa(input.vpa, 'vpa');
  if (!/^\d+(\.\d{1,2})?$/.test(input.amount)) throw new DomainError('INVALID_ARGUMENT', 'a UPI amount is rupees with at most two decimals');
  // Exactly two decimals, from the decimal string itself: the amount is never a float on its way to a payment.
  const [whole, fraction = ''] = input.amount.split('.');
  const amount = `${whole}.${fraction.padEnd(2, '0')}`;
  const name = input.payeeName.replace(/[^A-Za-z0-9 .&-]/g, '').trim().slice(0, 50);
  const note = input.note.replace(/[^A-Za-z0-9 -]/g, '').trim().slice(0, 50);
  const params = [`pa=${encodeURIComponent(vpa)}`, `pn=${encodeURIComponent(name)}`, `am=${amount}`, 'cu=INR', `tn=${encodeURIComponent(note)}`];
  return `upi://pay?${params.join('&')}`;
}

/**
 * The UPI address of a bank account itself, by NPCI's account-and-IFSC convention: `<account>@<ifsc>.ifsc.npci`.
 * Every UPI app resolves it to exactly that account — so a payment made by UPI lands in the registered, checked
 * account, never in whatever a separate UPI ID might point to.
 */
export function accountUpiAddress(accountNumber: string, ifsc: string): string {
  const account = accountNumber.replace(/\s+/g, '');
  const code = ifsc.trim().toLowerCase();
  if (!/^[0-9]{9,18}$/.test(account)) throw new DomainError('INVALID_ARGUMENT', 'account number must be 9–18 digits');
  if (!/^[a-z]{4}0[a-z0-9]{6}$/.test(code)) throw new DomainError('INVALID_ARGUMENT', 'invalid IFSC');
  return `${account}@${code}.ifsc.npci`;
}

// ---------------------------------------------------------------------------------------------------------------
// IFSC
// ---------------------------------------------------------------------------------------------------------------

/**
 * Whether a branch code has RBI's IFSC shape — four letters of the bank, a zero, six characters of the branch — and,
 * if not, what is wrong with it. Only the shape: whether the branch exists is the bank's to say.
 */
export function checkIfsc(raw: string): { readonly ok: true; readonly ifsc: string; readonly bank: string; readonly branch: string } | { readonly ok: false; readonly hint: string } {
  const ifsc = raw.replace(/\s+/g, '').toUpperCase();
  if (ifsc.length !== 11) return { ok: false, hint: 'an IFSC is 11 characters, such as HDFC0001234' };
  if (!/^[A-Z]{4}/.test(ifsc)) return { ok: false, hint: 'an IFSC starts with the bank’s four letters' };
  if (ifsc[4] !== '0') return { ok: false, hint: 'the fifth character of an IFSC is always the digit 0' };
  if (!/^[A-Z0-9]{6}$/.test(ifsc.slice(5))) return { ok: false, hint: 'the last six characters of an IFSC are letters and digits' };
  return { ok: true, ifsc, bank: ifsc.slice(0, 4), branch: ifsc.slice(5) };
}

/**
 * The banks most traders settle with, by the four letters every one of their IFSCs starts with — so a form can name the
 * bank from the code instead of asking for it. A bank not here is typed by hand; nothing is decided by this name.
 */
const IFSC_BANKS: Readonly<Record<string, string>> = Object.freeze({
  HDFC: 'HDFC Bank', ICIC: 'ICICI Bank', SBIN: 'State Bank of India', UTIB: 'Axis Bank', KKBK: 'Kotak Mahindra Bank', YESB: 'Yes Bank',
  INDB: 'IndusInd Bank', IDFB: 'IDFC First Bank', FDRL: 'Federal Bank', RATN: 'RBL Bank', BDBL: 'Bandhan Bank', AUBL: 'AU Small Finance Bank',
  PUNB: 'Punjab National Bank', BARB: 'Bank of Baroda', CNRB: 'Canara Bank', UBIN: 'Union Bank of India', BKID: 'Bank of India',
  IDIB: 'Indian Bank', IOBA: 'Indian Overseas Bank', CBIN: 'Central Bank of India', MAHB: 'Bank of Maharashtra', UCBA: 'UCO Bank',
  PSIB: 'Punjab & Sind Bank', JAKA: 'Jammu & Kashmir Bank', KARB: 'Karnataka Bank', SIBL: 'South Indian Bank', KVBL: 'Karur Vysya Bank',
  TMBL: 'Tamilnad Mercantile Bank', CSBK: 'CSB Bank', DLXB: 'Dhanlaxmi Bank', ESFB: 'Equitas Small Finance Bank', UJVN: 'Ujjivan Small Finance Bank',
  SCBL: 'Standard Chartered Bank', HSBC: 'HSBC', CITI: 'Citibank', DBSS: 'DBS Bank India', AIRP: 'Airtel Payments Bank', PYTM: 'Paytm Payments Bank',
  IPOS: 'India Post Payments Bank', FINO: 'Fino Payments Bank',
});

/** The bank an IFSC belongs to, when it is one of the banks above; null otherwise (or for a code not yet four letters long). */
export function bankNameOfIfsc(raw: string): string | null {
  const code = raw.replace(/\s+/g, '').toUpperCase().slice(0, 4);
  return code.length === 4 ? (IFSC_BANKS[code] ?? null) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Which rail suits an amount
// ---------------------------------------------------------------------------------------------------------------

/**
 * The per-payment limits the networks themselves set, in rupees: NPCI caps a person-to-person UPI payment at ₹1 lakh and
 * an IMPS payment at ₹5 lakh; RBI starts RTGS at ₹2 lakh; NEFT has no upper limit. A bank may set lower ones — for a new
 * payee often much lower — which no exchange can see, so these say only what is possible at all.
 */
export const RAIL_LIMITS_INR = Object.freeze({ upiMax: 100_000, impsMax: 500_000, rtgsMin: 200_000 });

/** At this many rupees a payer is reminded that its bank may cap a first payment to a new payee. */
export const NEW_PAYEE_CAUTION_INR = 50_000;

export interface RailOption {
  readonly rail: InrRail;
  /** Whether the network takes a payment of this amount at all. */
  readonly possible: boolean;
  /** Why not, when it does not. */
  readonly limit: string | null;
}

/**
 * The rails for a payment of `inrMinor` paise, best first: UPI up to ₹1 lakh, IMPS up to ₹5 lakh, RTGS from ₹2 lakh, and
 * NEFT for any amount — then, last, the ones the networks would refuse, with the limit that rules them out.
 */
export function railOptions(inrMinor: bigint): readonly RailOption[] {
  const rupees = inrMinor / 100n + (inrMinor % 100n > 0n ? 1n : 0n);
  const upi = rupees <= BigInt(RAIL_LIMITS_INR.upiMax);
  const imps = rupees <= BigInt(RAIL_LIMITS_INR.impsMax);
  const rtgs = rupees >= BigInt(RAIL_LIMITS_INR.rtgsMin);
  const order: InrRail[] = upi ? ['UPI', 'IMPS', 'NEFT', 'RTGS'] : imps ? (rtgs ? ['IMPS', 'RTGS', 'NEFT', 'UPI'] : ['IMPS', 'NEFT', 'RTGS', 'UPI']) : ['RTGS', 'NEFT', 'IMPS', 'UPI'];
  const possible: Record<InrRail, boolean> = { UPI: upi, IMPS: imps, NEFT: true, RTGS: rtgs };
  const limit: Record<InrRail, string> = {
    UPI: 'UPI takes up to ₹1,00,000 in one payment',
    IMPS: 'IMPS takes up to ₹5,00,000 in one payment',
    RTGS: 'RTGS starts at ₹2,00,000',
    NEFT: '',
  };
  return [...order.filter((r) => possible[r]), ...order.filter((r) => !possible[r])].map((rail) => ({ rail, possible: possible[rail], limit: possible[rail] ? null : limit[rail] }));
}

/** The rail a payment of this amount is suggested to go by — the first of `railOptions` (and `inrp2p_p2p_default_rail`). */
export function suggestedRail(inrMinor: bigint): InrRail {
  return railOptions(inrMinor)[0]!.rail;
}

// ---------------------------------------------------------------------------------------------------------------
// Who paid: matching the sender's name against the account it should have come from
// ---------------------------------------------------------------------------------------------------------------

/** Titles that say nothing about who someone is. */
const HONORIFICS = new Set(['MR', 'MRS', 'MS', 'MISS', 'MASTER', 'SHRI', 'SRI', 'SHREE', 'SMT', 'SMTI', 'KUM', 'DR', 'PROF', 'CA', 'ADV', 'CAPT', 'COL', 'MAJ', 'LT', 'SIR', 'MADAM']);
/** Words a company name carries that do not tell two companies apart. */
const WEAK = new Set(['PVT', 'LTD', 'LLP', 'INC', 'CO', 'CORP', 'THE', 'AND', 'OF', 'OPC', 'MS']);
/** One spelling for names Indian banks write several ways. */
const CANONICAL: Record<string, string> = {
  MD: 'MOHAMMED', MOHD: 'MOHAMMED', MOHAMMAD: 'MOHAMMED', MOHAMAD: 'MOHAMMED', MUHAMMAD: 'MOHAMMED', MUHAMMED: 'MOHAMMED', MOHAMED: 'MOHAMMED', MOHAMMEDD: 'MOHAMMED',
  KR: 'KUMAR', KUMAAR: 'KUMAR',
  SK: 'SHAIKH', SHEIKH: 'SHAIKH', SHAIK: 'SHAIKH', SHEKH: 'SHAIKH',
  PRIVATE: 'PVT', LIMITED: 'LTD', COMPANY: 'CO', CORPORATION: 'CORP',
};

/**
 * A name as a list of comparable words: upper-cased, accents and punctuation gone ("R.K." is two initials), titles
 * and the business prefix "M/S" dropped, common spellings made one.
 */
export function nameTokens(raw: string): string[] {
  const cleaned = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\bM\s*\/\s*S\b\.?/g, ' ')
    .replace(/\b[SDW]\s*\/\s*O\b.*$/g, ' ')
    .replace(/[^A-Z\s]/g, ' ');
  return cleaned
    .split(/\s+/)
    .filter((t) => t.length > 0 && !HONORIFICS.has(t))
    .map((t) => CANONICAL[t] ?? t);
}

/** Damerau–Levenshtein distance with a cut-off: typos and transliterations, never a different name. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/** How Indian names sound rather than how they are spelled in Latin letters: LAKSHMI and LAXMI, SHARMA and SARMA. */
function soundKey(t: string): string {
  return t
    .replace(/KSH/g, 'X')
    .replace(/(SH|S)/g, 'S')
    .replace(/PH/g, 'F')
    .replace(/([TDBGKC])H/g, '$1')
    .replace(/W/g, 'V')
    .replace(/Z/g, 'J')
    .replace(/EE|I|Y/g, 'I')
    .replace(/OO|U/g, 'U')
    .replace(/(.)\1+/g, '$1')
    .replace(/A$/g, '');
}

export type NameTokenMatch = 'EXACT' | 'INITIAL' | 'TRUNCATED' | 'SPELLING';

export interface NameMatchPair {
  readonly seen: string;
  readonly expected: string | null;
  readonly how: NameTokenMatch | null;
}

/**
 * - `MATCH` — every word of the sender's name is the account holder's, with at least two full words in common (or the
 *   only word of a one-word name): the client's own money.
 * - `PARTIAL` — nothing contradicts it, but too little is there to be sure ("R SHARMA" for "RAHUL SHARMA" could be
 *   a father) or the bank adds one word the account does not have. A person decides, with the account number.
 * - `MISMATCH` — a word of the sender's name is not the holder's at all: someone else paid ("SURESH SHARMA").
 * - `UNKNOWN` — no sender name to compare.
 */
export type NameVerdict = 'MATCH' | 'PARTIAL' | 'MISMATCH' | 'UNKNOWN';

export interface NameMatch {
  readonly verdict: NameVerdict;
  readonly pairs: readonly NameMatchPair[];
}

function pairOf(seen: string, expected: readonly string[], used: Set<number>, last: boolean): { index: number; how: NameTokenMatch } | null {
  const tries: ((e: string) => NameTokenMatch | null)[] = [
    (e) => (e === seen ? 'EXACT' : null),
    (e) => (seen.length >= 4 && e.length >= 4 && (distance(seen, e, e.length >= 8 ? 2 : 1) <= (e.length >= 8 ? 2 : 1) || soundKey(seen) === soundKey(e)) ? 'SPELLING' : null),
    // A narration cuts the name off at a fixed width, so only its last word may be a stub.
    (e) => (last && seen.length >= 3 && e.length > seen.length && e.startsWith(seen) ? 'TRUNCATED' : null),
    (e) => (seen.length === 1 && e.startsWith(seen) ? 'INITIAL' : null),
    (e) => (e.length === 1 && seen.startsWith(e) ? 'INITIAL' : null),
  ];
  for (const t of tries) {
    for (let i = 0; i < expected.length; i += 1) {
      if (used.has(i)) continue;
      const how = t(expected[i]!);
      if (how) return { index: i, how };
    }
  }
  return null;
}

/**
 * Is the sender the holder of the account? Word by word, in any order, allowing initials, a cut-off last word,
 * one-letter typos and the usual spellings — and nothing else: a word the holder's name does not have is someone
 * else's name.
 */
export function matchNames(expectedName: string, seenName: string): NameMatch {
  const expectedAll = nameTokens(expectedName);
  const seenAll = nameTokens(seenName);
  const expected = expectedAll.filter((t) => !WEAK.has(t));
  const seen = seenAll.filter((t) => !WEAK.has(t));
  if (seen.length === 0) return { verdict: 'UNKNOWN', pairs: [] };
  if (expected.length === 0) return { verdict: 'MISMATCH', pairs: seen.map((s) => ({ seen: s, expected: null, how: null })) };

  const used = new Set<number>();
  const pairs: NameMatchPair[] = seen.map((s, i) => {
    const found = pairOf(s, expected, used, i === seen.length - 1);
    if (!found) return { seen: s, expected: null, how: null };
    used.add(found.index);
    return { seen: s, expected: expected[found.index]!, how: found.how };
  });
  const unmatched = pairs.filter((p) => p.how === null).length;
  const full = pairs.filter((p) => p.how !== null && p.how !== 'INITIAL').length;

  if (unmatched === 0) {
    if (full >= 2) return { verdict: 'MATCH', pairs };
    if (full === 1 && expected.length === 1) return { verdict: 'MATCH', pairs };
    return { verdict: 'PARTIAL', pairs };
  }
  // One word more than the holder's whole name ("… ENTERPRISES") may be how the bank styles the same person; one
  // word instead of one of the holder's ("SURESH" for "RAHUL") is somebody else.
  if (unmatched === 1 && full >= 2 && used.size === expected.length) return { verdict: 'PARTIAL', pairs };
  return { verdict: 'MISMATCH', pairs };
}

/**
 * The sender of a payment, judged against the account it should have come from: the name first, and where the bank
 * shows the sending account's last digits, those too. Matching digits make a thin name certain; different digits
 * make even a matching name only partial — the client's own name, but an account they never registered.
 */
export function judgeSender(expected: { readonly holderName: string; readonly last4: string | null }, seen: { readonly name: string | null; readonly accountDigits: string | null }): NameMatch & { readonly account: 'SAME' | 'DIFFERENT' | 'NOT_SHOWN' } {
  const names = seen.name ? matchNames(expected.holderName, seen.name) : { verdict: 'UNKNOWN' as const, pairs: [] };
  const digits = seen.accountDigits?.replace(/\D/g, '') ?? '';
  const account = digits.length >= 4 && expected.last4 ? (digits.endsWith(expected.last4) ? 'SAME' : 'DIFFERENT') : 'NOT_SHOWN';
  let verdict = names.verdict;
  if (account === 'SAME' && verdict === 'PARTIAL') verdict = 'MATCH';
  if (account === 'DIFFERENT' && verdict === 'MATCH') verdict = 'PARTIAL';
  return { verdict, pairs: names.pairs, account };
}
