import type { SheetRow, WorkbookKey } from '../schema.js';
import type { WorkbookPlaces } from '../workbook.js';
import type { WorkbookRows } from './workbook-rows.js';

import { workbookSpecs } from '../specs/workbook.js';
import { nonEmpty } from './labels.js';

// What a refusal line may name: the sheet and row of every row read and
// the rows the check read them into. A line quotes course and curriculum
// names, curriculum codes, 2018 labels, credits and availabilities only,
// never a staff or student value.
export type RefusalContext = {
  readonly places: WorkbookPlaces;
  readonly rows: WorkbookRows;
};

// "a", "a and b", "a, b and c".
export const joined = (items: readonly string[]): string => {
  const last = items.at(-1) ?? '';
  return items.length < 2
    ? last
    : `${items.slice(0, -1).join(', ')} and ${last}`;
};

export const quoted = (text: null | string): string => `«${text ?? ''}»`;

// The sheet a workbook part is read from.
export const sheetOf = (key: WorkbookKey): string => {
  const source = workbookSpecs.find((spec) => spec.key === key)?.source;
  if (source === undefined) {
    return key;
  }
  return 'sheet' in source ? source.sheet : source.sheets.join(', ');
};

const bySheet = (
  collection: WorkbookKey,
  ids: readonly number[],
  { places }: RefusalContext,
): ReadonlyArray<readonly [string, readonly SheetRow[]]> => [
  ...Map.groupBy(
    ids.flatMap((id) => places[collection][id - 1] ?? []),
    ({ sheet }) => sheet,
  ),
];

const numbered = (rows: readonly SheetRow[]): string =>
  `${rows.length === 1 ? 'row' : 'rows'} ${joined(rows.map(({ row }) => String(row)))}`;

// Rows as the subject of a sentence: "Наставен Кадар rows 12 and 13".
export const rowsAt = (
  collection: WorkbookKey,
  ids: readonly number[],
  context: RefusalContext,
): string =>
  bySheet(collection, ids, context)
    .map(([sheet, rows]) => `${sheet} ${numbered(rows)}`)
    .join(', ');

// Rows as the object of a sentence: "rows 34 and 74 of Предмети - 2023".
export const rowsOf = (
  collection: WorkbookKey,
  ids: readonly number[],
  context: RefusalContext,
): string =>
  bySheet(collection, ids, context)
    .map(([sheet, rows]) => `${numbered(rows)} of ${sheet}`)
    .join(', ');

export const courseRow = (id: number, { rows }: RefusalContext) =>
  rows.courses[id - 1];

// A course named first: «Alpha Course» (Предмети (Export) row 2).
export const courseNamed = (id: number, context: RefusalContext): string =>
  `${quoted(nonEmpty(courseRow(id, context)?.name))} (${rowsAt('courses', [id], context)})`;

// A course row named first: Предмети (Export) row 2 «Alpha Course».
export const courseRowNamed = (id: number, context: RefusalContext): string =>
  `${rowsAt('courses', [id], context)} ${quoted(nonEmpty(courseRow(id, context)?.name))}`;
