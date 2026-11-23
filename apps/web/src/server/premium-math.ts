/**
 * India's USDT premium, as the public premium page measures it: how far USDT's rupee price in India sits over the
 * dollar's. Pure arithmetic in whole micro-rupees and hundredths of a percent (D-11: no floating point in a figure that is
 * shown) — the reading itself is in `premium.ts`.
 */

/** One working day's dollar from the European Central Bank's reference rates: rupees per dollar, in micro-rupees. */
export interface DollarFix {
  /** `YYYY-MM-DD`, the day the ECB published it for. */
  readonly date: string;
  readonly micro: bigint;
}

/** A plain decimal ("101.85") as millionths, rounded half up past the sixth place; null for anything else. */
export function decimalToMicro(value: string): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return null;
  const fraction = (m[2] ?? '').padEnd(7, '0');
  const micro = BigInt(m[1]!) * 1_000_000n + BigInt(fraction.slice(0, 6));
  return fraction[6]! >= '5' ? micro + 1n : micro;
}

/**
 * The ECB's daily reference rates, as its data API answers `EXR/D.USD+INR.EUR.SP00.A` with `format=csvdata` and
 * `detail=dataonly`: rupees per euro and dollars per euro for each working day. The dollar in rupees is their ratio —
 * the cross rate every user of these rates computes — on each day both were published. Oldest first; a malformed row is
 * skipped rather than guessed at.
 */
export function parseEcbDollar(csv: string): DollarFix[] {
  const [head, ...rows] = csv.trim().split(/\r?\n/);
  if (!head) return [];
  const cols = head.split(',');
  const at = { currency: cols.indexOf('CURRENCY'), date: cols.indexOf('TIME_PERIOD'), value: cols.indexOf('OBS_VALUE') };
  if (at.currency < 0 || at.date < 0 || at.value < 0) return [];
  const inr = new Map<string, bigint>();
  const usd = new Map<string, bigint>();
  for (const row of rows) {
    const cells = row.split(',');
    const date = cells[at.date] ?? '';
    const micro = decimalToMicro(cells[at.value] ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || micro === null || micro <= 0n) continue;
    if (cells[at.currency] === 'INR') inr.set(date, micro);
    else if (cells[at.currency] === 'USD') usd.set(date, micro);
  }
  return [...inr.keys()]
    .filter((date) => usd.has(date))
    .sort()
    .map((date) => {
      const perEuro = inr.get(date)!;
      const dollarsPerEuro = usd.get(date)!;
      return { date, micro: (perEuro * 1_000_000n + dollarsPerEuro / 2n) / dollarsPerEuro };
    });
}

/** The latest fix published for `day` or before it — a weekend or a holiday keeps the last working day's. */
export function fixFor(day: string, fixes: readonly DollarFix[]): DollarFix | null {
  let found: DollarFix | null = null;
  for (const f of fixes) {
    if (f.date > day) break;
    found = f;
  }
  return found;
}

/** The premium of a USDT price over the dollar, in hundredths of a percent, rounded half away from zero. */
export function premiumHundredths(usdtMicro: bigint, dollarMicro: bigint): bigint {
  const scaled = (usdtMicro - dollarMicro) * 10_000n * 2n;
  const half = scaled >= 0n ? dollarMicro : -dollarMicro;
  return (scaled + half) / (2n * dollarMicro);
}

/** Hundredths of a percent as the page shows them: `+11.27%`, `−0.40%`, `0.00%`. */
export function formatPremium(hundredths: bigint): string {
  const sign = hundredths > 0n ? '+' : hundredths < 0n ? '−' : '';
  const abs = hundredths < 0n ? -hundredths : hundredths;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}%`;
}

/** Rupees more than the dollar rate on `dollars` dollars' worth of USDT, in whole rupees (negative when under it). */
export function extraRupees(usdtMicro: bigint, dollarMicro: bigint, dollars: number): bigint {
  const diff = (usdtMicro - dollarMicro) * BigInt(dollars);
  return diff >= 0n ? (diff + 500_000n) / 1_000_000n : -((-diff + 500_000n) / 1_000_000n);
}

/** A micro-rupee figure rounded to the paisa, as micro-rupees. */
export const toPaisa = (micro: bigint): bigint => ((micro + 5_000n) / 10_000n) * 10_000n;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-11-20` as `20 Nov`, or `20 Nov 2026` with the year. */
export function formatDay(day: string, withYear = false): string {
  const [y, m, d] = day.split('-');
  const month = MONTHS[Number(m) - 1] ?? m;
  return `${Number(d)} ${month}${withYear ? ` ${y}` : ''}`;
}
