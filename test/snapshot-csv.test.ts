import { describe, expect, test } from 'vitest';

import { csvLine } from '../directus/extensions/directus-extension-data-operations/src/snapshot/backup.js';
import {
  type SnapshotField,
  snapshotFields,
} from '../directus/extensions/directus-extension-data-operations/src/snapshot/contract.js';
import { readCsv } from '../directus/extensions/directus-extension-data-operations/src/snapshot/csv-parser.js';
import {
  type CsvCell,
  CsvFormatError,
} from '../directus/extensions/directus-extension-data-operations/src/snapshot/csv-types.js';
import {
  headerPositions,
  SnapshotRows,
} from '../directus/extensions/directus-extension-data-operations/src/snapshot/rows.js';

const limits = { maxCellChars: 1_000, maxCells: 8 };

type Chunks =
  AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>;

const cellsOf = async (
  chunks: Chunks,
  bounds = limits,
): Promise<CsvCell[][]> => {
  const records: CsvCell[][] = [];
  const reader = readCsv(chunks, bounds);
  for await (const record of reader) {
    records.push([...record.cells]);
  }
  return records;
};

const failureOf = async (chunks: Chunks, bounds = limits) => {
  try {
    await cellsOf(chunks, bounds);
  } catch (error) {
    if (error instanceof CsvFormatError) {
      return { line: error.line, problem: error.problem };
    }
    throw error;
  }
  throw new Error('expected a CSV refusal');
};

const encoder = new TextEncoder();

// Every way to cut the text into two chunks, as strings and as bytes (a
// cut may split a multi-byte character or a CRLF).
const allSplits = (text: string): Array<Array<string | Uint8Array>> => {
  const bytes = encoder.encode(text);
  const splits: Array<Array<string | Uint8Array>> = [];
  for (let index = 0; index <= text.length; index += 1) {
    splits.push([text.slice(0, index), text.slice(index)]);
  }
  for (let index = 0; index <= bytes.length; index += 1) {
    splits.push([bytes.slice(0, index), bytes.slice(index)]);
  }
  return splits;
};

const tricky = [
  'a,b,c',
  '"Line one\r\nLine two",[Skopje],{note}',
  'true,  padded  ,null',
  '"""quoted""","{""a"": 1}","[1, 2]"',
  ',"",Скопје 漢字 😀',
  '0012,1e3, 42 ',
].join('\r\n');

const trickyCells = [
  ['a', 'b', 'c'],
  ['Line one\r\nLine two', '[Skopje]', '{note}'],
  ['true', '  padded  ', 'null'],
  ['"quoted"', '{"a": 1}', '[1, 2]'],
  [null, '', 'Скопје 漢字 😀'],
  ['0012', '1e3', ' 42 '],
];

describe('snapshot CSV reader', () => {
  test('keeps every cell exactly as written, however the input is chunked', async () => {
    for (const chunks of allSplits(tricky)) {
      await expect(cellsOf(chunks)).resolves.toEqual(trickyCells);
    }
  });

  test('reads the backup convention back losslessly', async () => {
    const values = [
      [null, 7, ''],
      ['a,b', 'x"y', 'line\nfeed'],
    ];
    const written = values.map((row) => csvLine(row)).join('');

    await expect(cellsOf([written])).resolves.toEqual([
      [null, '7', ''],
      ['a,b', 'x"y', 'line\nfeed'],
    ]);
  });

  test('drops a byte order mark and trailing empty lines but refuses an empty line inside', async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);

    await expect(cellsOf([bom, encoder.encode('a,b\n\n\n')])).resolves.toEqual([
      ['a', 'b'],
    ]);
    await expect(failureOf(['a,b\n\n\r\nc,d'])).resolves.toEqual({
      line: 2,
      problem: 'empty_line',
    });
    await expect(cellsOf(['a,b\r\nc,d'])).resolves.toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  test('holds no record for empty lines, however many the file carries', async () => {
    const blankChunk = encoder.encode('\n'.repeat(65_536));
    const lines = 2_000_000;
    let peak = 0;
    const source = async function* (tail: string) {
      yield encoder.encode('a,b\n');
      for (let sent = 0; sent < lines; sent += blankChunk.length) {
        peak = Math.max(peak, process.memoryUsage().heapUsed);
        yield blankChunk;
      }
      yield encoder.encode(tail);
    };
    const before = process.memoryUsage().heapUsed;
    const trailing = [];
    const records = readCsv(source(''), limits);
    for await (const record of records) {
      trailing.push(record.cells);
    }

    expect(trailing).toEqual([['a', 'b']]);
    // Two million retained empty records would take several hundred MB.
    expect(peak - before).toBeLessThan(96 * 1_024 * 1_024);
    await expect(failureOf(source('c,d\n'))).resolves.toEqual({
      line: 2,
      problem: 'empty_line',
    });
  });

  test('refuses malformed CSV and names the line', async () => {
    await expect(failureOf(['a,b\n"open,c\nd,e\n'])).resolves.toEqual({
      line: 2,
      problem: 'unterminated_quote',
    });
    await expect(failureOf(['a,b\n"x"y,c\n'])).resolves.toEqual({
      line: 2,
      problem: 'text_after_quote',
    });
    await expect(failureOf(['a,b\nx"y,c\n'])).resolves.toEqual({
      line: 2,
      problem: 'quote_in_unquoted_cell',
    });
    await expect(failureOf(['a,b\rc,d\n'])).resolves.toEqual({
      line: 1,
      problem: 'bare_carriage_return',
    });
    await expect(failureOf(['a,b\nc\u{0},d\n'])).resolves.toEqual({
      line: 2,
      problem: 'nul_character',
    });
    await expect(failureOf(['a,b,c,d,e,f,g,h,i\n'])).resolves.toEqual({
      line: 1,
      problem: 'too_many_cells',
    });
    await expect(failureOf([`a,${'x'.repeat(1_001)}\n`])).resolves.toEqual({
      line: 1,
      problem: 'cell_too_long',
    });
    await expect(
      failureOf([encoder.encode('a,b\n'), new Uint8Array([0x63, 0xff, 0x0a])]),
    ).resolves.toMatchObject({ problem: 'encoding' });
    await expect(
      failureOf([new Uint8Array([0x61, 0xd0])]),
    ).resolves.toMatchObject({ problem: 'encoding' });
  });

  test('counts lines inside quoted cells for later records', async () => {
    const records = [];
    const reader = readCsv(['h\n"one\ntwo\nthree"\nnext\n'], limits);
    for await (const record of reader) {
      records.push([record.record, record.line]);
    }

    expect(records).toEqual([
      [0, 1],
      [1, 2],
      [2, 5],
    ]);
  });
});

// One CSV line of a snapshot whose header is the contract order: the given
// values in their fields, every other cell empty.
const snapshotLine = (values: Readonly<Record<string, string>>): string =>
  `${snapshotFields.map((field) => values[field] ?? '').join(',')}\n`;

// The staged values of the data rows, checked as the import checks them.
const stagedOf = async (lines: readonly string[]) => {
  const reader = readCsv([`${snapshotFields.join(',')}\n`, ...lines], {
    maxCellChars: 1_000,
    maxCells: 64,
  });
  let rows: null | SnapshotRows = null;
  const staged = [];
  for await (const record of reader) {
    if (rows === null) {
      rows = new SnapshotRows(headerPositions(record.cells));
    } else {
      staged.push(rows.accept(record));
    }
  }
  return { problems: rows?.problems, staged };
};

const valueIn = (field: SnapshotField) => snapshotFields.indexOf(field);

describe('the scraper formula guard', () => {
  // The scraper writes a ' before a text value whose start matches the
  // Python pattern \s*[=+\-@]; Google Sheets drops it on the workbook path.
  test('is removed before the checks, and every other value stays as written', async () => {
    const values: ReadonlyArray<readonly [string, string]> = [
      ["'=SUM(1)", '=SUM(1)'],
      ["' -5", ' -5'],
      ["'@x", '@x'],
      ["'+1", '+1'],
      ["'\t\u{1C}\u{3000}=x", '\t\u{1C}\u{3000}=x'],
      ["'abc", "'abc"],
      ["'\u{FEFF}=x", "'\u{FEFF}=x"],
      ["it's =", "it's ="],
      ['=raw', '=raw'],
      ["'", "'"],
    ];
    const { problems, staged } = await stagedOf(
      values.map(([written], index) =>
        snapshotLine({ Interests_new: written, Name: `User ${String(index)}` }),
      ),
    );

    expect(problems).toBe(0);
    expect(staged.map((row) => row?.[valueIn('Interests_new')])).toEqual(
      values.map(([, kept]) => kept),
    );
  });

  test('is removed from a guarded first history line and a guarded Name', async () => {
    const { problems, staged } = await stagedOf([
      snapshotLine({
        Courses: '"\'=Synthetic Course-2025/2026\nOther Course-2024/2025"',
        Name: "'@Synthetic",
      }),
    ]);

    expect(problems).toBe(0);
    expect(staged[0]?.[valueIn('Courses')]).toBe(
      '=Synthetic Course-2025/2026\nOther Course-2024/2025',
    );
    expect(staged[0]?.[valueIn('Name')]).toBe('@Synthetic');
  });
});
