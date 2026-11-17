import styles from './pay-marks.module.css';

/**
 * The marks of the ways money moves, so a client recognises them at a glance as it does in its bank's app:
 *
 * - UPI and IMPS: NPCI's own word marks with their orange and green arrows, traced from the files on Wikimedia Commons
 *   (`UPI_logo.svg`, `IMPS_logo.svg`; text logos, public domain), without the tag lines. They mark how a payment
 *   travels — the way a shop's door shows the networks it takes;
 * - USDT: Tether's coin, from `Tether_Logo.svg` (public domain);
 * - TRON: the network's red disc, drawn here;
 * - a bank: its own colours and short name on a tile, from the IFSC's first four letters — a sign the client knows,
 *   not the bank's logo.
 *
 * Decorative: every mark sits beside words that say the same thing.
 */

const UPI_PATHS = [
  { m: 'matrix(0.26458 0 0 0.26458 -135.79198 -53.6231)', d: 'M802.16 300.72H782.62l27.06-98.05h19.54z', tone: 'ink' },
  {
    m: 'matrix(0.26458 0 0 0.26458 73.73419 0.80433)',
    d: 'm0 0c-1.28-1.76-3.37-2.72-6.25-2.72h-107.3l-5.28 19.22h19.54v0h77.99L-26.91 37.01h-77.99v-.16h-19.54l-16.17 58.64h19.38l10.89-39.41h87.76c2.72 0 5.44-.81 7.84-2.73 2.41-1.92 4.01-4.16 4.81-6.89L.8 7.21C1.6 4.33 1.44 1.92 0 0Z',
    tone: 'ink',
  },
  {
    m: 'matrix(0.26458 0 0 0.26458 33.4805 24.33108)',
    d: 'm0 0c-.96 3.84-4.49 6.57-8.49 6.57h-100.73c-2.72 0-4.81-.96-6.09-2.89-1.44-1.92-1.6-4.16-.96-6.88l24.66-88.44H-72.07L-94.01-12.66H-16.02l22.1-78.98h19.38z',
    tone: 'ink',
  },
  { m: 'matrix(0.26458 0 0 0.26458 -135.79198 -53.6231)', d: 'M862.85 202.83 887.68 252.01 835.63 301.2Z', tone: 'green' },
  { m: 'matrix(0.26458 0 0 0.26458 -135.79198 -53.6231)', d: 'm845.56 202.83 24.66 49.18-51.89 49.19z', tone: 'orange' },
] as const;

const IMPS_PATHS = [
  {
    m: 'matrix(0.35278 0 0 -0.35278 94.47088 0.00113)',
    d: 'm0 0c-.104 0-.215-.016-.319-.016-1.93-.068-3.736-.715-5.422-1.961-1.791-1.322-2.96-2.926-3.543-4.817 0 0-8.224-27.358-8.236-27.388-.419-1.729-.172-3.199.746-4.367.593-.771 1.405-1.3 2.388-1.612.575-.179 1.22-.28 1.93-.31.127 0 66.05-.016 66.05-.016l-4.137-13.744h-73.042l-3.952-13.179 73.031-.007h7.228c.151 0 .309.016.457.025 1.883.086 3.657.707 5.332 1.906 1.81 1.276 3.003 2.864 3.577 4.756 0 0 8.124 27.038 8.15 27.154.428 1.713.182 3.168-.753 4.359-.999 1.283-2.523 1.922-4.568 1.922h-65.8l4.269 14.119h73.008l3.966 13.16z',
    tone: 'ink',
  },
  { m: 'matrix(0.35278 0 0 -0.35278 7.39348 23.78344)', d: 'm0 0h-14.571l20.267 67.332h14.583z', tone: 'ink' },
  {
    m: 'matrix(0.35278 0 0 -0.35278 52.15845 0.02935)',
    d: 'm0 0-60.868-47.282-21.221 32.337-9.817 14.945h-.262l-4.627-15.349-15.641-51.983h14.572l10.971 36.439 23.242-36.524 38.479 32.33-9.656-32.245h14.58l14.228 47.259 6.047 20.073z',
    tone: 'ink',
  },
  {
    m: 'matrix(0.35278 0 0 -0.35278 86.89316 0.68199)',
    d: 'm0 0c-1.003 1.292-2.559 1.937-4.677 1.937h-80.14l-3.971-13.191 72.897.015-4.242-14.095-72.865-.03-12.125-40.115h14.587l8.123 26.968h65.561c2.041 0 3.967.639 5.789 1.922 1.797 1.285 2.994 2.873 3.561 4.763l8.116 26.969c.602 1.962.385 3.572-.614 4.857',
    tone: 'ink',
  },
  { m: 'matrix(0.35278 0 0 -0.35278 132.51821 0.09991)', d: 'm0 0 18.361-33.598-38.604-33.584z', tone: 'green' },
  { m: 'matrix(0.35278 0 0 -0.35278 127.97792 0.09991)', d: 'm0 0 18.35-33.598-38.624-33.584z', tone: 'orange' },
] as const;

type MarkProps = { className?: string | undefined };

/** UPI's word mark, its arrows in their colours. `mono` draws it in one colour (white on the orange field). */
export function UpiMark({ className, mono = false }: MarkProps & { mono?: boolean }) {
  return (
    <svg className={`${styles.word} ${className ?? ''}`} data-mono={mono || undefined} viewBox="2.62 0 96.45 26.07" aria-hidden="true" focusable="false">
      {UPI_PATHS.map((p) => (
        <path key={p.d.slice(0, 24)} transform={p.m} d={p.d} data-tone={p.tone} />
      ))}
    </svg>
  );
}

/** IMPS's word mark, as NPCI draws it. */
export function ImpsMark({ className, mono = false }: MarkProps & { mono?: boolean }) {
  return (
    <svg className={`${styles.word} ${className ?? ''}`} data-mono={mono || undefined} viewBox="2.25 0 136.75 23.82" aria-hidden="true" focusable="false">
      {IMPS_PATHS.map((p) => (
        <path key={p.d.slice(0, 24)} transform={p.m} d={p.d} data-tone={p.tone} />
      ))}
    </svg>
  );
}

/** Tether's coin. */
export function TetherMark({ className, size = 40 }: MarkProps & { size?: number }) {
  return (
    <svg className={`${styles.coin} ${className ?? ''}`} width={size} height={size} viewBox="4.465 13.693 124.4 124.4" aria-hidden="true" focusable="false">
      <circle cx="66.665" cy="75.893" r="62.2" fill="#26a17b" />
      <path
        fill="#fff"
        d="m73.295 81.633v-.01c-.43.03-2.65.16-7.59.16-3.95 0-6.72-.11-7.7-.16v.01c-15.19-.67-26.52-3.31-26.52-6.48 0-3.16 11.34-5.81 26.52-6.48v10.33c.99.07 3.84.24 7.77.24 4.72 0 7.08-.2 7.52-.24v-10.32c15.16.68 26.46 3.32 26.46 6.48s-11.31 5.8-26.46 6.48m0-14.03v-9.24h21.15v-14.09h-57.58v14.09h21.15v9.24c-17.19.79-30.11 4.19-30.11 8.27s12.93 7.48 30.11 8.28v29.62h15.29v-29.62c17.16-.79 30.06-4.19 30.06-8.27 0-4.07-12.9-7.48-30.06-8.27"
      />
    </svg>
  );
}

/** The TRON network's red disc. */
export function TronMark({ className, size = 16 }: MarkProps & { size?: number }) {
  return (
    <svg className={`${styles.coin} ${className ?? ''}`} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <circle cx="16" cy="16" r="16" fill="#eb0029" />
      <g fill="none" stroke="#fff" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round">
        <path d="M7.4 7.8 24.9 11.9 14.9 25.4Z" />
        <path d="M7.4 7.8 19.9 14.2 14.9 25.4M19.9 14.2l5-2.3" />
      </g>
    </svg>
  );
}

/** USDT on TRON: Tether's coin with the network's disc on its shoulder, as exchanges show a token on its chain. */
export function UsdtOnTron({ className, size = 44 }: MarkProps & { size?: number }) {
  return (
    <span className={`${styles.token} ${className ?? ''}`} style={{ ['--size' as string]: `${size}px` }} aria-hidden="true">
      <TetherMark size={size} />
      <TronMark className={styles.chain} size={Math.round(size * 0.42)} />
    </span>
  );
}

/** A bank's sign: its colours and the short name its customers use, from the IFSC's first four letters. */
interface BankBrand {
  readonly short: string;
  readonly bg: string;
  /** A second colour from the bank's own sign, as a corner of the tile. */
  readonly accent?: string;
  readonly fg?: string;
}

const BANK_BRANDS: Record<string, BankBrand> = {
  AIRP: { short: 'airtel', bg: '#e40000' },
  AUBL: { short: 'AU', bg: '#6d2077', accent: '#f37021' },
  BARB: { short: 'BOB', bg: '#f26522', accent: '#162d6d' },
  BDBL: { short: 'Bandhan', bg: '#e31e24' },
  BKID: { short: 'BOI', bg: '#0055a5', accent: '#f57f20' },
  BOFA: { short: 'BofA', bg: '#012169', accent: '#e31837' },
  CBIN: { short: 'CBI', bg: '#1d4f91', accent: '#e31e24' },
  CITI: { short: 'citi', bg: '#056dae', accent: '#ee1c25' },
  CIUB: { short: 'CUB', bg: '#123c8c' },
  CNRB: { short: 'Canara', bg: '#0091d5', accent: '#ffd200' },
  COSB: { short: 'Cosmos', bg: '#1b3f8b' },
  CSBK: { short: 'CSB', bg: '#00539f' },
  DBSS: { short: 'DBS', bg: '#ff3e3e' },
  DCBL: { short: 'DCB', bg: '#00427a' },
  DEUT: { short: 'DB', bg: '#0018a8' },
  DLXB: { short: 'Dhan', bg: '#7b1f2b' },
  ESFB: { short: 'Equitas', bg: '#f37021', accent: '#1c3f94' },
  ESMF: { short: 'ESAF', bg: '#00843d' },
  FDRL: { short: 'Federal', bg: '#004a8f', accent: '#f7a800' },
  HDFC: { short: 'HDFC', bg: '#004c8f', accent: '#ed232a' },
  HSBC: { short: 'HSBC', bg: '#db0011' },
  IBKL: { short: 'IDBI', bg: '#00836c', accent: '#f37021' },
  ICIC: { short: 'ICICI', bg: '#b02a30', accent: '#f37e20' },
  IDFB: { short: 'IDFC', bg: '#9c1d26' },
  IDIB: { short: 'Indian', bg: '#0b4ea2', accent: '#f7941d' },
  INDB: { short: 'IndusInd', bg: '#8b1d1e' },
  IOBA: { short: 'IOB', bg: '#0054a6' },
  JAKA: { short: 'J&K', bg: '#c8102e' },
  KARB: { short: 'KBL', bg: '#7a1a3a' },
  KKBK: { short: 'kotak', bg: '#ed1c24', accent: '#003874' },
  KVBL: { short: 'KVB', bg: '#00703c' },
  MAHB: { short: 'BoM', bg: '#1a4d9c' },
  PSIB: { short: 'PSB', bg: '#00703c' },
  PUNB: { short: 'PNB', bg: '#a20a3a', accent: '#fbbc09' },
  RATN: { short: 'RBL', bg: '#21409a' },
  SBIN: { short: 'SBI', bg: '#22409a', accent: '#00b5ef' },
  SCBL: { short: 'SC', bg: '#0072aa', accent: '#38d200' },
  SIBL: { short: 'SIB', bg: '#d2232a' },
  SRCB: { short: 'Saraswat', bg: '#00377b' },
  TMBL: { short: 'TMB', bg: '#00539f' },
  UBIN: { short: 'Union', bg: '#e31e24', accent: '#004a99' },
  UCBA: { short: 'UCO', bg: '#0b3c8c' },
  UJVN: { short: 'Ujjivan', bg: '#5c2d91' },
  UTIB: { short: 'AXIS', bg: '#97144d' },
  YESB: { short: 'YES', bg: '#0060aa', accent: '#e31837' },
};

/** The bank's colour, for a card that wants a hint of it. The product's own ink when the bank is not one we know. */
export const bankTint = (ifsc: string): string => BANK_BRANDS[ifsc.slice(0, 4)]?.bg ?? '#1b1d22';

/** A bank known only by its name ("HDFC Bank •••• 8219" on a trade): the brand whose short name opens it. */
const brandByName = (name: string): BankBrand | undefined => {
  const first = name.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
  return first.length >= 3 ? Object.values(BANK_BRANDS).find((b) => b.short.toUpperCase() === first) : undefined;
};

/** Two letters for a bank we have no sign for: "Saraswat Co-operative Bank" → SC. */
function initials(name: string): string {
  const words = name.replace(/&/g, ' ').split(/\s+/).filter((w) => w.length > 0 && !/^(of|the|and|bank|ltd|limited)$/i.test(w));
  const letters = words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0]?.slice(0, 2) ?? '··');
  return letters.toUpperCase();
}

export function BankMark({ ifsc, name, className, size = 44 }: { ifsc: string; name: string; className?: string | undefined; size?: number }) {
  const brand = BANK_BRANDS[ifsc.slice(0, 4)] ?? brandByName(name);
  const short = brand?.short ?? initials(name);
  return (
    <span
      className={`${styles.bank} ${className ?? ''}`}
      data-len={short.length > 5 ? 'long' : short.length > 3 ? 'mid' : undefined}
      style={{
        ['--size' as string]: `${size}px`,
        ['--bank' as string]: brand?.bg ?? '#1b1d22',
        ...(brand?.accent ? { ['--bank-accent' as string]: brand.accent } : {}),
        ...(brand?.fg ? { ['--bank-fg' as string]: brand.fg } : {}),
      }}
      aria-hidden="true"
    >
      {short}
    </span>
  );
}

/** A rail's mark: NPCI's for UPI and IMPS; NEFT and RTGS are the RBI's, which shows them as words. */
export function RailMark({ rail, className }: { rail: string; className?: string | undefined }) {
  return (
    <span className={`${styles.rail} ${className ?? ''}`} data-rail={rail}>
      {rail === 'UPI' ? <UpiMark /> : rail === 'IMPS' ? <ImpsMark /> : <span className={styles.railWord}>{rail}</span>}
      <span className="ix-visually-hidden">{rail}</span>
    </span>
  );
}
