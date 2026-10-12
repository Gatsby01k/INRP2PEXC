/**
 * What the Bank & wallets forms can tell the client before anything is sent, so a mistake is caught at the field
 * that made it. The server checks all of it again (`@inrp2p/kernel` validation, `parseTronAddress`) and is the only
 * judge; these mirror its rules and never loosen them.
 */

/** IFSC: four letters for the bank, a zero, six letters or digits for the branch (RBI format). */
export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/** An Indian account number: nine to eighteen digits (`normalizeIndianAccountNumber`). */
export const ACCOUNT_PATTERN = /^[0-9]{9,18}$/;

export const normalizeIfsc = (raw: string): string => raw.replace(/\s+/g, '').toUpperCase().slice(0, 11);
export const normalizeAccount = (raw: string): string => raw.replace(/\D/g, '').slice(0, 18);

/**
 * The bank behind an IFSC's first four letters, for the banks clients most often settle to. It only fills in a
 * name the client can still change — an unlisted code simply leaves the field for them to type.
 */
const BANKS: Record<string, string> = {
  AIRP: 'Airtel Payments Bank',
  AUBL: 'AU Small Finance Bank',
  BARB: 'Bank of Baroda',
  BDBL: 'Bandhan Bank',
  BKID: 'Bank of India',
  BOFA: 'Bank of America',
  CBIN: 'Central Bank of India',
  CITI: 'Citibank',
  CIUB: 'City Union Bank',
  CNRB: 'Canara Bank',
  COSB: 'Cosmos Bank',
  CSBK: 'CSB Bank',
  DBSS: 'DBS Bank India',
  DCBL: 'DCB Bank',
  DEUT: 'Deutsche Bank',
  DLXB: 'Dhanlaxmi Bank',
  ESFB: 'Equitas Small Finance Bank',
  ESMF: 'ESAF Small Finance Bank',
  FDRL: 'Federal Bank',
  HDFC: 'HDFC Bank',
  HSBC: 'HSBC',
  IBKL: 'IDBI Bank',
  ICIC: 'ICICI Bank',
  IDFB: 'IDFC FIRST Bank',
  IDIB: 'Indian Bank',
  INDB: 'IndusInd Bank',
  IOBA: 'Indian Overseas Bank',
  JAKA: 'Jammu & Kashmir Bank',
  KARB: 'Karnataka Bank',
  KKBK: 'Kotak Mahindra Bank',
  KVBL: 'Karur Vysya Bank',
  MAHB: 'Bank of Maharashtra',
  PSIB: 'Punjab & Sind Bank',
  PUNB: 'Punjab National Bank',
  RATN: 'RBL Bank',
  SBIN: 'State Bank of India',
  SCBL: 'Standard Chartered Bank',
  SIBL: 'South Indian Bank',
  SRCB: 'Saraswat Bank',
  TMBL: 'Tamilnad Mercantile Bank',
  UBIN: 'Union Bank of India',
  UCBA: 'UCO Bank',
  UJVN: 'Ujjivan Small Finance Bank',
  UTIB: 'Axis Bank',
  YESB: 'Yes Bank',
};

export function bankForIfsc(ifsc: string): string | null {
  return ifsc.length >= 4 ? (BANKS[ifsc.slice(0, 4)] ?? null) : null;
}

/** Two letters for a bank's monogram: "HDFC Bank" → HB, "State Bank of India" → SB. */
export function monogram(name: string): string {
  const words = name.replace(/&/g, ' ').split(/\s+/).filter((w) => w.length > 0 && !/^(of|the|and)$/i.test(w));
  const letters = words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0]?.slice(0, 2) ?? '··');
  return letters.toUpperCase();
}

// ——— TRON addresses: base58check, version 0x41, double-SHA-256 checksum ———

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** The shape alone: a T and thirty-three base58 characters. */
export const TRON_SHAPE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

function base58Decode(value: string): Uint8Array | null {
  let n = 0n;
  for (const ch of value) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const ch of value) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** Whether an address is a real TRON address — its checksum included, so one mistyped character is caught. */
export async function isTronAddress(value: string): Promise<boolean> {
  if (!TRON_SHAPE.test(value)) return false;
  const bytes = base58Decode(value);
  if (!bytes || bytes.length !== 25 || bytes[0] !== 0x41) return false;
  const payload = bytes.slice(0, 21);
  const once = new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
  const twice = new Uint8Array(await crypto.subtle.digest('SHA-256', once));
  return twice[0] === bytes[21] && twice[1] === bytes[22] && twice[2] === bytes[23] && twice[3] === bytes[24];
}

/** An address in groups of four, so it can be checked against the wallet character by character. */
export const groupAddress = (address: string): string[] => address.match(/.{1,4}/g) ?? [];
