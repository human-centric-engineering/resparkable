/**
 * CSV escaping with formula-injection protection.
 *
 * RFC 4180 quoting rules cover commas, quotes, and line breaks — a lone
 * CR included, since spreadsheets read one as a record break. They do
 * NOT cover the leading characters spreadsheet applications interpret
 * as the start of a formula. Excel, LibreOffice Calc and Google Sheets
 * all evaluate cells that begin with `=`, `+`, `-`, `@`, tab (`\t`) or
 * carriage return (`\r`), which lets a malicious value placed anywhere
 * in an exported CSV invoke `HYPERLINK()` for data exfiltration,
 * `cmd|...!A1` for OS command execution on Windows + DDE-enabled
 * spreadsheets, or any number of other side-channels.
 *
 * Mitigation: prefix any cell whose first character is one of those
 * triggers with a single quote. The leading quote is treated as a
 * literal text marker by every major spreadsheet and is rendered as
 * the original string when the cell is read by a CSV parser.
 *
 * That only protects the first character of a cell as the reader splits
 * it. A spreadsheet opened in a semicolon-separator locale, or a user
 * who picks `;` or tab in the import dialog, splits on those instead of
 * the comma. So a cell containing either is quoted as well, which keeps
 * the text after it inside the neutralised cell (#947).
 *
 * @see https://owasp.org/www-community/attacks/CSV_Injection
 */
const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Escape a single value for inclusion in a CSV row. Applies both
 * formula-injection neutralisation (leading-character prefix) and
 * RFC 4180 quoting (for commas, quotes, CR and LF). A lone CR is
 * quoted too: spreadsheets treat it as a record break, so left bare it
 * would start a new cell whose first character the neutraliser never
 * saw. Semicolons and tabs are quoted for the same reason, for readers
 * that split on them.
 */
export function csvEscape(value: string): string {
  const neutralised =
    value.length > 0 && FORMULA_TRIGGERS.includes(value.charAt(0)) ? `'${value}` : value;
  if (/[",;\t\r\n]/.test(neutralised)) {
    return `"${neutralised.replace(/"/g, '""')}"`;
  }
  return neutralised;
}

/**
 * A whole CSV document — a header row, then one row per record.
 *
 * Line endings are CRLF, which is what RFC 4180 specifies and what Excel on
 * Windows expects. Every reader that accepts LF accepts CRLF too, so this is the
 * strictly wider choice rather than a preference.
 *
 * Rows are padded to the header width rather than trusted to match it. A short
 * row shifts every value after the gap into the wrong column, which produces a
 * file that opens cleanly and is wrong — the worst available failure.
 */
export function csvDocument(
  headers: readonly string[],
  rows: readonly (readonly string[])[]
): string {
  const lines = [headers.map(csvEscape).join(',')];

  for (const row of rows) {
    const cells = headers.map((_, index) => csvEscape(row[index] ?? ''));
    lines.push(cells.join(','));
  }

  return `${lines.join('\r\n')}\r\n`;
}
