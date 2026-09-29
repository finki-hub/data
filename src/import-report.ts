import type { ImportPlan } from './import/plan.js';
import type { UnstorableValue } from './import/storable.js';
import type { WorkbookContent, WorkbookPlaces } from './workbook.js';

import { countByCode, countKeys } from './import/findings.js';
import { refusalText } from './import/refusal-text.js';
import { workbookRows } from './import/workbook-rows.js';

const columnOf = ({ collection, field }: UnstorableValue): string =>
  `${collection}.${field}`;

// What both import commands print on stdout: counts only, never a value
// of the workbook. The rows are those the import writes per collection;
// the blocking cases, the skipped rows and the warnings are counted per
// code, the values no column can hold per column.
export const checkSummary = (plan: ImportPlan) => ({
  blockers: countByCode(plan.blockers),
  rows: Object.fromEntries(
    plan.collections.map(({ collection, rows }) => [collection, rows.length]),
  ),
  skipped: countByCode(plan.skipped),
  unstorable: countKeys(plan.unstorable.map(columnOf)),
  warnings: countByCode(plan.warnings),
});

// The cases that refuse the import: the blocking cases and the values no
// column can hold.
export const refusalCount = ({ blockers, unstorable }: ImportPlan): number =>
  blockers.length + unstorable.length;

// The sheet and row a planned row comes from, or, for a row no workbook
// row gave (a seed), its collection and plan key.
const rowPlaceOf = (
  { collection, key, origin }: UnstorableValue,
  places: WorkbookPlaces,
): string => {
  const place =
    origin === null ? undefined : places[origin.source][origin.id - 1];
  return place === undefined
    ? `${collection} ${key}`
    : `${place.sheet} row ${String(place.row)}`;
};

// What refuses the import, for stderr: one line per value no column can
// hold, named by sheet, row and column (never the value), then one line
// per blocking case, headed by its code and explained in plain words with
// the course and the rows it concerns (src/import/refusal-text.ts).
export const refusalLines = (
  { blockers, unstorable }: ImportPlan,
  { data, places }: Pick<WorkbookContent, 'data' | 'places'>,
): readonly string[] => {
  const context = { places, rows: workbookRows(data) };
  return [
    ...unstorable.map(
      (value) =>
        `- ${rowPlaceOf(value, places)}: ${columnOf(value)} ${value.problem}`,
    ),
    ...blockers.map(
      (blocker) => `- [${blocker.code}] ${refusalText(blocker, context)}`,
    ),
  ];
};
