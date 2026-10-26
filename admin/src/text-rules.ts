// Text rules shared by the server and the console (pure, so the console bundle can import them).

// Spreadsheet formula neutralising for CSV cells, shared by the server export and the console download.
// OWASP "CSV Injection" (https://owasp.org/www-community/attacks/CSV_Injection) lists = + - @, tab, carriage
// return, line feed and their full-width variants (＝ ＋ － ＠) as formula triggers. A trigger after leading
// whitespace is treated the same, because spreadsheets may trim the space before reading the cell.
const FORMULA_START = /^[\s\u3000]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]|^[\t\r\n]/;

// Prefixes a risky value with an apostrophe so it is read as text.
export function neutraliseFormula(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

// A name shown in reports and CSV files (ADMIN-5): visible text, no control characters or line breaks
// (C0, DEL, C1, U+2028/9), at most `max` characters.
export const isDisplayName = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length <= max && /\S/.test(v) && !/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/.test(v);