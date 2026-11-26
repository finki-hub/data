import { splitHistory } from './history.js';

// The matching users as a CSV file for a spreadsheet: a byte order mark so
// Excel reads the Cyrillic as UTF-8, CRLF rows, every cell quoted.

export type ExportRow = {
  readonly Courses?: null | string | undefined;
  readonly 'Courses Count'?: null | number | undefined;
  readonly Mail?: null | string | undefined;
  readonly matched: readonly string[];
  readonly Name: string;
  readonly Profile_new?: null | string | undefined;
  readonly Profile_old?: null | string | undefined;
};

const header = [
  'Name',
  'Mail',
  'Moodle profile (new)',
  'Moodle profile (old)',
  'Courses count',
  'Matched courses',
  'Course history',
];

// A cell a spreadsheet would read as a formula starts with one of these.
const formulaStart = /^[\t\r=+\-@]/u;

const cell = (value: null | number | string | undefined): string => {
  const text = value === null || value === undefined ? '' : String(value);
  const safe = formulaStart.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
};

export const toCsv = (rows: readonly ExportRow[]): string =>
  `\u{FEFF}${[
    header,
    ...rows.map((row) => [
      row.Name,
      row.Mail,
      row.Profile_new,
      row.Profile_old,
      row['Courses Count'],
      row.matched.join('\n'),
      splitHistory(row.Courses).join('\n'),
    ]),
  ]
    .map((line) => line.map(cell).join(','))
    .join('\r\n')}\r\n`;
