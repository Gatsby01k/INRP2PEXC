/**
 * Deterministic time display. IST is UTC+05:30 with no daylight saving, so no Intl or
 * runtime timezone data is involved.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, '0');

function ist(date: Date): Date {
  return new Date(date.getTime() + IST_OFFSET_MS);
}

export function formatIstTime(date: Date, opts: { suffix?: boolean } = {}): string {
  const d = ist(date);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${opts.suffix === false ? '' : ' IST'}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatIstDate(date: Date): string {
  const d = ist(date);
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function formatIstDateTime(date: Date): string {
  return `${formatIstDate(date)}, ${formatIstTime(date)}`;
}

/** Remaining time as mm:ss, floored to whole seconds, never negative. */
export function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.floor(remainingMs / 1000));
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** "3 min" / "1 h 12 min" for settlement duration. */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
