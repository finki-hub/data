import { once } from 'node:events';
import { createWriteStream } from 'node:fs';

import {
  boundedFields,
  historyField,
  instanceIdFields,
  integerFields,
  requiredFields,
  snapshotFields,
  type SnapshotValue,
} from '../../directus/extensions/directus-extension-data-operations/src/snapshot/contract.js';

// The Moodle snapshot side of the generated stress fixture: the scraper
// columns come from the declared header set (snapshotFields and its
// integer, required, bounded and history columns), so a new scraper
// column gets values, a place in the CSV and a place in the oracle without
// an edit here. The history labels come from the course names and year
// labels the caller passes (the rows the fixture creates). Every value is
// invented: synthetic names, .example addresses, generated course labels.

export type SnapshotDeclaration = {
  readonly bounded: readonly string[];
  readonly fields: readonly string[];
  readonly history: string;
  readonly instanceIds: readonly string[];
  readonly integers: readonly string[];
  readonly required: readonly string[];
};

// The declared scraper contract.
export const declaredSnapshot: SnapshotDeclaration = {
  bounded: boundedFields,
  fields: snapshotFields,
  history: historyField,
  instanceIds: instanceIdFields,
  integers: integerFields,
  required: requiredFields,
};

type StressRow = readonly SnapshotValue[];

// A course/year pair of a history label, as indexes into the course names
// and year labels the labels were made from.
type LabelPair = { readonly course: number; readonly year: number };

type StressLabels = {
  readonly labels: readonly string[];
  // The labels that match no rule, in label order.
  readonly nonmatching: readonly string[];
  // The labels shaped `<course name>-<year label>`, the default pattern of
  // a legacy rule, with their pair.
  readonly pairs: ReadonlyMap<string, LabelPair>;
};

const variants = ['Основи', '数据结构', 'Networks 🌐', 'Calculus', 'Дизајн'];

const variantOf = (index: number): string =>
  variants[index % variants.length] ?? 'Synthetic';

// At most this many courses keep distinct four-digit names, so no course
// name is a prefix of another one's label.
const maxCourses = 10_000;

export const courseName = (index: number): string =>
  `Synthetic Stress Course ${String(index).padStart(4, '0')} - ${variantOf(index)}`;

// Exactly `total` distinct labels: every course/year pair (years
// interleaved, so each year gets its share) as `<course>-<year>` up to the
// matching share, then labels that match no rule. At least a fifth never
// match, so nonmatching histories exist at every size.
export const stressLabels = (
  courses: readonly string[],
  years: readonly string[],
  total: number,
): StressLabels => {
  if (courses.length === 0 || years.length === 0 || total < 1) {
    throw new Error('Labels need courses, years and a positive total');
  }
  if (courses.length > maxCourses) {
    throw new Error(`At most ${maxCourses} courses keep distinct labels`);
  }
  const pairCount = courses.length * years.length;
  const nonmatching = Math.max(total - pairCount, Math.ceil(total / 5));
  const matching = total - nonmatching;
  const labels: string[] = [];
  const pairs = new Map<string, LabelPair>();
  const others: string[] = [];
  for (let index = 0; index < matching; index += 1) {
    const year = index % years.length;
    const course = Math.floor(index / years.length);
    const label = `${courses[course] ?? ''}-${years[year] ?? ''}`;
    labels.push(label);
    pairs.set(label, { course, year });
  }
  for (let index = matching; index < total; index += 1) {
    others.push(
      `Synthetic Elective ${String(index).padStart(5, '0')} - ${variantOf(index)}`,
    );
  }
  return { labels: [...labels, ...others], nonmatching: others, pairs };
};

// Which users carry which kind of history.
const nullHistory = (index: number) => index % 400 === 0;
const longHistory = (index: number) => index % 1_000 === 500;
const nonmatchingOnly = (index: number) => index % 19 === 7;
const repeatsLine = (index: number) => index % 13 === 0;
const usesCrLf = (index: number) => index % 11 === 0;

// Lines of a long history: many times a typical history, still far below
// the distinct entries one user may hold.
export const longHistoryLines = 300;

// One user's history lines, as the generator chooses them (null for a
// null history): the first line cycles through every label (so the
// snapshot holds each of them), then further labels; long histories,
// repeated lines, histories of nonmatching labels only and null histories
// are spread over the users. The expected index is counted from these
// lists, never by splitting the raw text again.
const historyLinesOf = (
  index: number,
  { labels, nonmatching }: StressLabels,
): null | readonly string[] => {
  if (nullHistory(index)) {
    return null;
  }
  const pool =
    nonmatchingOnly(index) && nonmatching.length > 0 ? nonmatching : labels;
  const count = longHistory(index) ? longHistoryLines : 1 + (index % 6);
  const lines = Array.from(
    { length: count },
    (_, line) => pool[(index + line * 131) % pool.length] ?? '',
  );
  if (repeatsLine(index)) {
    lines.push(lines[0] ?? '');
  }
  return lines;
};

// One user's raw history: the lines joined by LF, or CRLF every 11th user.
const historyOf = (index: number, labels: StressLabels): null | string =>
  historyLinesOf(index, labels)?.join(usesCrLf(index) ? '\r\n' : '\n') ?? null;

// Every user's history lines, in row order.
export const stressLines = (
  count: number,
  labels: StressLabels,
): ReadonlyArray<null | readonly string[]> =>
  Array.from({ length: count }, (_, index) => historyLinesOf(index, labels));

// Value shapes of scraper columns whose meaning a generic text would hide:
// the address (null, empty or a .example address) and the two profile
// links. Every other column, including one the scraper adds later, gets
// a generic value.
const shapedValue = (
  field: string,
  index: number,
  offset: number,
): SnapshotValue | undefined => {
  switch (field) {
    case 'Mail':
      if (index % 4 === 0) return null;
      return index % 9 === 0 ? '' : `stress${offset + index}@snapshot.example`;
    case 'Profile_new':
    case 'Profile_old':
      return index % 3 === 0
        ? null
        : `https://profiles.example/${field.toLowerCase()}/${offset + index}`;
    default:
      return undefined;
  }
};

const names = [
  (index: number) => `Synthetic Stress Student ${index}`,
  (index: number) => `Синтетички Студент ${index}`,
  (index: number) => `合成学生 ${index}`,
  (index: number) => `"Quoted" Student, ${index}`,
  (index: number) => `Synthetic 😀 Student ${index}`,
];

const requiredValue = (field: string, index: number, offset: number): string =>
  field === 'Name'
    ? (names[index % names.length]?.(offset + index) ?? `Synthetic ${index}`)
    : `${field} ${variantOf(index)} ${offset + index}`;

// A generic text: absent, empty, Unicode, quoted, and in unbounded columns
// sometimes two lines.
const textValue = (
  field: string,
  index: number,
  bounded: boolean,
): null | string => {
  if (index % 7 === 3) return null;
  if (index % 29 === 5) return '';
  // Far below the 255 characters of a bounded column.
  const text = `${field} ${variantOf(index + field.length)} "${index}", value`;
  return !bounded && index % 250 === 3 ? `${text}\r\nsecond line` : text;
};

// The two instance ids: both, old only, new only, none; each unique in its
// own column, never matched with the other.
const instanceId = (
  field: string,
  index: number,
  { declaration, offset }: RowContext,
): null | number => {
  const position = declaration.instanceIds.indexOf(field);
  const combination = index % 4;
  const present =
    combination === 0 ||
    (combination === 1 && position === 0) ||
    (combination === 2 && position === 1);
  return present ? offset + (position + 1) * 100_000 + index : null;
};

type RowContext = {
  readonly declaration: SnapshotDeclaration;
  readonly labels: StressLabels;
  readonly offset: number;
};

const lineBreak = /\r?\n/u;

const cellValue = (
  field: string,
  index: number,
  {
    context,
    history,
  }: { readonly context: RowContext; readonly history: null | string },
): SnapshotValue => {
  const { declaration, offset } = context;
  if (field === declaration.history) return history;
  if (declaration.instanceIds.includes(field)) {
    return instanceId(field, index, context);
  }
  if (declaration.integers.includes(field)) {
    // The scraper's own line count; absent now and then.
    return history === null || index % 50 === 0
      ? null
      : history.split(lineBreak).length;
  }
  if (declaration.required.includes(field)) {
    return requiredValue(field, index, offset);
  }
  const shaped = shapedValue(field, index, offset);
  return shaped === undefined
    ? textValue(field, index, declaration.bounded.includes(field))
    : shaped;
};

// One user, in declaration order.
const stressRow = (index: number, context: RowContext): StressRow => {
  const history = historyOf(index, context.labels);
  return context.declaration.fields.map((field) =>
    cellValue(field, index, { context, history }),
  );
};

export const stressRows = (
  count: number,
  context: RowContext,
): readonly StressRow[] =>
  Array.from({ length: count }, (_, index) => stressRow(index, context));

// The column order of the generated CSV: the declaration reversed (the
// import maps columns by name, never by position).
export const csvOrder = (fields: readonly unknown[]): readonly number[] =>
  fields.map((_, index) => fields.length - 1 - index);

const needsQuotes = /[\n\r",]/u;

// A cell as a spreadsheet export writes it: quoted only when needed, an
// empty text quoted so it stays distinct from an absent value.
const cell = (value: SnapshotValue | undefined): string => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return text === '' || needsQuotes.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
};

const csvRecord = (values: ReadonlyArray<SnapshotValue | undefined>): string =>
  `${csvOrder(values)
    .map((index) => cell(values[index]))
    .join(',')}\n`;

export const csvHeader = (fields: readonly string[]): string =>
  csvRecord(fields);

// Streams the header and the rows into a file, 1,000 rows per write;
// `raw` replaces the line of a row with literal text (a malformed row).
export const writeStressCsv = async (
  file: string,
  {
    fields,
    raw = new Map(),
    rows,
  }: {
    readonly fields: readonly string[];
    readonly raw?: ReadonlyMap<number, string>;
    readonly rows: readonly StressRow[];
  },
): Promise<void> => {
  const stream = createWriteStream(file, { encoding: 'utf8' });
  stream.write(csvHeader(fields));
  for (let start = 0; start < rows.length; start += 1_000) {
    const chunk = rows
      .slice(start, start + 1_000)
      .map((row, offset) => raw.get(start + offset) ?? csvRecord(row))
      .join('');
    if (!stream.write(chunk)) await once(stream, 'drain');
  }
  stream.end();
  await once(stream, 'finish');
};

// The raw histories of the rows, in row order.
export const historiesOf = (
  declaration: SnapshotDeclaration,
  rows: readonly StressRow[],
): ReadonlyArray<null | string> => {
  const position = declaration.fields.indexOf(declaration.history);
  return rows.map((row) => {
    const value = row[position];
    return typeof value === 'string' ? value : null;
  });
};

// The distinct entries of every history (what the index holds) and the
// membership count (one per user and distinct entry), from the lines the
// generator chose (stressLines), independent of the history contract's
// splitter that the installed index runs.
export const indexOf = (users: ReadonlyArray<null | readonly string[]>) => {
  const labels = new Set<string>();
  let memberships = 0;
  for (const lines of users) {
    const entries = new Set(lines);
    memberships += entries.size;
    for (const entry of entries) labels.add(entry);
  }
  return { labels, memberships };
};
