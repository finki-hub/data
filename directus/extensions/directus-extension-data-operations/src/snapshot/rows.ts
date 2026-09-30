import type { CsvCell, CsvRecord } from './csv-types.js';

import {
  labelBytes,
  maxLabelBytes,
  splitHistoryLines,
} from '../history-contract.js';
import { boundedText, countText, listMax, listText } from '../text.js';
import {
  boundedFields,
  boundedLength,
  historyField,
  instanceIdFields,
  integerFields,
  maxInteger,
  requiredFields,
  type SnapshotField,
  snapshotFields,
  type SnapshotRow,
  type SnapshotValue,
} from './contract.js';
import { snapshotError } from './errors.js';

const knownFields: ReadonlySet<string> = new Set(snapshotFields);

const unexpectedPart = (names: readonly string[], count: number): string => {
  if (count === 0) {
    return '';
  }
  const id = names.includes('id') ? ' (includes id)' : '';
  return `unexpected columns: ${String(count)}${id}`;
};

// Maps the header record onto the snapshot fields: the file must name each
// of them exactly once, in any order, and nothing else (least of all the
// internal `id`, which would make rows address existing records). The
// refusal names only the expected field names and counts, never a header
// text, because a file without a header row would put a person's data
// there.
export const headerPositions = (cells: readonly CsvCell[]): number[] => {
  const names = cells.map((cell) => cell ?? '');
  const missing = snapshotFields.filter((field) => !names.includes(field));
  const repeated = snapshotFields.filter(
    (field) => names.indexOf(field) !== names.lastIndexOf(field),
  );
  const unexpected = names.filter((name) => !knownFields.has(name)).length;
  if (missing.length + repeated.length + unexpected === 0) {
    return snapshotFields.map((field) => names.indexOf(field));
  }
  const parts = [
    missing.length > 0 ? `missing ${listText(missing)}` : '',
    repeated.length > 0 ? `repeated ${listText(repeated)}` : '',
    unexpectedPart(names, unexpected),
  ].filter((part) => part !== '');
  throw snapshotError(
    'INVALID_HEADERS',
    `Invalid header: ${parts.join('; ')}`,
    { missing, repeated, unexpected },
  );
};

type RowProblem = {
  readonly field: null | SnapshotField;
  readonly line: number;
  readonly reason: string;
  readonly row: number;
};

const positiveId = /^[1-9]\d*$/u;
const countPattern = /^(?:0|[1-9]\d*)$/u;

// Characters as PostgreSQL counts them (code points).
const codePoints = (text: string): number => {
  let index = 0;
  let length = 0;
  while (index < text.length) {
    index += (text.codePointAt(index) ?? 0) > 0xff_ff ? 2 : 1;
    length += 1;
  }
  return length;
};

// A UTF-16 unit encodes to at most three UTF-8 bytes, so only a line
// longer than a third of the bound needs to be measured.
const overlongLine = (line: string): boolean =>
  line.length * 3 > maxLabelBytes && labelBytes(line) > maxLabelBytes;

const describeProblem = ({ field, line, reason, row }: RowProblem): string =>
  [`row ${row} (line ${line})`, field, reason]
    .filter((part) => part !== null)
    .join(' ');

// The flagged rows the import answer names; the refusal and the warning
// text name the first listMax of them (text.ts).
const shownFlags = 20;

export type SnapshotWarnings = {
  readonly historyLinesOverLimit: {
    readonly count: number;
    readonly rows: readonly number[];
  };
};

// Checks and converts data records one at a time and remembers only what
// the checks need: the first row of every populated id per instance
// column, the first problems and flagged rows, and the counts.
export class SnapshotRows {
  public flagged = 0;
  public readonly flaggedRows: number[] = [];
  public problems = 0;
  public rows = 0;
  public readonly shown: RowProblem[] = [];
  readonly #positions: readonly number[];
  readonly #seen = new Map<SnapshotField, Map<number, number>>(
    instanceIdFields.map((field) => [field, new Map()]),
  );

  public constructor(positions: readonly number[]) {
    this.#positions = positions;
  }

  // The staged values of a valid record, or null when it is invalid.
  public accept(record: CsvRecord): null | SnapshotRow {
    this.rows += 1;
    if (record.cells.length !== snapshotFields.length) {
      this.#problem(
        record,
        null,
        `has ${record.cells.length} cells, not ${snapshotFields.length}`,
      );
      return null;
    }
    const before = this.problems;
    const values = snapshotFields.map((field, index) =>
      this.#value(record, field, record.cells[this.#positions[index] ?? -1]),
    );
    return this.problems === before ? values : null;
  }

  public describe(): string {
    const listed = boundedText(
      this.shown.map((problem) => describeProblem(problem)),
      { separator: '; ', total: this.problems },
    );
    return `Invalid rows: ${countText(this.problems, 'problem', 'problems')} in ${countText(this.rows, 'row', 'rows')}: ${listed}`;
  }

  #integer(record: CsvRecord, field: SnapshotField, cell: CsvCell) {
    if (cell === null || cell === '') {
      return null;
    }
    const id = (instanceIdFields as readonly string[]).includes(field);
    const value = Number(cell);
    if (!(id ? positiveId : countPattern).test(cell) || value > maxInteger) {
      const kind = id ? 'a positive integer id' : 'a non-negative integer';
      this.#problem(record, field, `is not ${kind}`);
      return null;
    }
    if (id) {
      this.#unique(record, field, value);
    }
    return value;
  }

  #problem(record: CsvRecord, field: null | SnapshotField, reason: string) {
    this.problems += 1;
    if (this.shown.length < listMax) {
      this.shown.push({ field, line: record.line, reason, row: record.record });
    }
  }

  #text(record: CsvRecord, field: SnapshotField, value: CsvCell) {
    if (requiredFields.includes(field) && (value === null || value === '')) {
      this.#problem(record, field, 'is required');
    }
    if (
      value !== null &&
      boundedFields.includes(field) &&
      value.length > boundedLength &&
      codePoints(value) > boundedLength
    ) {
      this.#problem(
        record,
        field,
        `is longer than ${boundedLength} characters`,
      );
    }
    if (
      field === historyField &&
      value !== null &&
      splitHistoryLines(value).some((line) => overlongLine(line))
    ) {
      this.flagged += 1;
      if (this.flaggedRows.length < shownFlags) {
        this.flaggedRows.push(record.record);
      }
    }
    return value;
  }

  #unique(record: CsvRecord, field: SnapshotField, value: number): void {
    const seen = this.#seen.get(field);
    const first = seen?.get(value);
    if (first === undefined) {
      seen?.set(value, record.record);
      return;
    }
    this.#problem(record, field, `repeats the id of row ${first}`);
  }

  #value(
    record: CsvRecord,
    field: SnapshotField,
    cell: CsvCell = null,
  ): SnapshotValue {
    const value: SnapshotValue = integerFields.includes(field)
      ? this.#integer(record, field, cell)
      : this.#text(record, field, cell);
    return value;
  }
}

// The flag on rows whose raw history holds a line the history index
// cannot hold (maxLabelBytes). The raw text is staged unchanged; the
// index run will refuse those users, naming them, until the line is
// shortened at the source.
export const warningsOf = (rows: SnapshotRows): null | SnapshotWarnings =>
  rows.flagged === 0
    ? null
    : {
        historyLinesOverLimit: {
          count: rows.flagged,
          rows: rows.flaggedRows,
        },
      };

export const describeWarnings = (warnings: SnapshotWarnings): string => {
  const { count: flagged, rows } = warnings.historyLinesOverLimit;
  return `HISTORY_LINE_TOO_LONG: ${countText(flagged, 'row', 'rows')} over ${String(maxLabelBytes)} bytes: ${boundedText(rows.map(String), { total: flagged })}`;
};
