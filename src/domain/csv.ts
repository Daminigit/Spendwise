/**
 * src/domain/csv.ts
 *
 * RFC 4180 CSV helpers with spreadsheet formula-injection protection.
 * Merchant names and descriptions come from receipts (via Claude) and from
 * users, so a value like `=HYPERLINK(...)` must never execute in Excel/Sheets.
 */

/** Characters that make Excel / Sheets / LibreOffice treat a cell as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Escape one cell. Text cells starting with a formula character are prefixed
 * with a single quote. Pass `{ numeric: true }` for amounts so "-12.50" stays a number.
 */
export function csvCell(value: unknown, opts: { numeric?: boolean } = {}): string {
  let s = value == null ? '' : String(value);
  if (!opts.numeric && FORMULA_START.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(cells: string[]): string {
  return `${cells.join(',')}\r\n`;
}
