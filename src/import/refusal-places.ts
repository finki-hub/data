import type { SheetRow, WorkbookKey } from '../schema.js';
import type { WorkbookPlaces } from '../workbook.js';
import type { WorkbookRows } from './workbook-rows.js';

import { workbookSpecs } from '../specs/workbook.js';
import { listText, pluralText } from '../text.js';
import { nonEmpty } from './labels.js';

// What a refusal line may name: the sheet and row of every row read and
// the rows the check read them into. A line quotes course and curriculum
// names, curriculum codes, 2018 labels, credits and availabilities only,
// never a staff or student value.
export type RefusalContext = {
  readonly places: WorkbookPlaces;
  readonly rows: WorkbookRows;
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
  `${pluralText(rows.length, 'row', 'rows')} ${listText(rows.map(({ row }) => String(row)))}`;

// Rows by sheet: "Наставен Кадар rows 12, 13", several sheets joined by
// ", ".
export const rowsAt = (
  collection: WorkbookKey,
  ids: readonly number[],
  context: RefusalContext,
): string =>
  bySheet(collection, ids, context)
    .map(([sheet, rows]) => `${sheet} ${numbered(rows)}`)
    .join(', ');

export const courseRow = (id: number, { rows }: RefusalContext) =>
  rows.courses[id - 1];

// A course by its row, then its name: Предмети (Export) row 2 «Alpha Course».
export const courseRowNamed = (id: number, context: RefusalContext): string =>
  `${rowsAt('courses', [id], context)} ${quoted(nonEmpty(courseRow(id, context)?.name))}`;
