/**
 * One CSV writer, for every file this system hands to a person.
 *
 * There is exactly one because quoting is the part that goes wrong: a client called `Acme, "the" Pay`, a note
 * with a newline in it, a bank reference that starts with `=`. Each of those breaks a different naive writer,
 * and a finance export that silently shifts one column is worse than no export at all.
 *
 * RFC 4180 throughout: CRLF line endings, fields quoted when they must be, quotes doubled inside quotes. Values
 * arrive as strings already — an export never formats a number, because the decimal it should carry was decided
 * by the domain, not by a serializer (D-11: machine formats carry ungrouped decimals).
 */
const NEEDS_QUOTES = /[",\r\n]/;

/**
 * Spreadsheets treat a leading `=`, `+`, `-` or `@` as the start of a formula. A bank reference or a client's
 * own name must never become one, so those fields are quoted and prefixed with a tab, which every spreadsheet
 * reads as "this is text" and no parser mistakes for data.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvField(value: string): string {
  const safe = FORMULA_START.test(value) ? `\t${value}` : value;
  return NEEDS_QUOTES.test(safe) || safe !== value ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export const csvRow = (values: readonly string[]): string => values.map(csvField).join(',');

/** A complete file: a header row, the body, CRLF everywhere and a trailing newline. */
export function csvDocument(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [csvRow(header), ...rows.map(csvRow)].join('\r\n') + '\r\n';
}
