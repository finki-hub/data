import type { ImportPlan } from './import/plan.js';
import type { UnstorableValue } from './import/storable.js';
import type { WorkbookContent, WorkbookPlaces } from './workbook.js';

import { countByCode, countKeys } from './import/findings.js';
import { fixPlaces } from './import/fix-places.js';
import { displayKey } from './import/planned.js';
import { refusalText } from './import/refusal-text.js';
import { workbookRows } from './import/workbook-rows.js';

const columnOf = ({ collection, field }: UnstorableValue): string =>
  `${collection}.${field}`;

// What both import commands print on stdout: counts and places only,
// never a value of the workbook. The rows are those the import writes per
// collection; the blocking cases, the skipped rows and the warnings are
// counted per code, the values no column can hold per column; `fixes`
// places each case of a rule fix by sheet, row and column, per code with
// a case.
export const checkSummary = (
  plan: ImportPlan,
  { places }: Pick<WorkbookContent, 'places'>,
) => ({
  blockers: countByCode(plan.blockers),
  fixes: fixPlaces(plan.warnings, places),
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
export const rowPlaceOf = (
  {
    collection,
    key,
    origin,
  }: Pick<UnstorableValue, 'collection' | 'key' | 'origin'>,
  places: WorkbookPlaces,
): string => {
  const place =
    origin === null ? undefined : places[origin.source][origin.id - 1];
  return place === undefined
    ? `${collection} ${displayKey(key)}`
    : `${place.sheet} row ${String(place.row)}`;
};

// What blocks the import, for stderr, one line per case in one layout,
// `- [<code>] <place>: <fact>`: each value no column can hold, coded
// `unstorable` (the stdout key) and placed by sheet, row and column, never
// quoted; then each blocking case by its code, sheet, row and course
// (src/import/refusal-text.ts).
export const refusalLines = (
  { blockers, unstorable }: ImportPlan,
  { data, places }: Pick<WorkbookContent, 'data' | 'places'>,
): readonly string[] => {
  const context = { places, rows: workbookRows(data) };
  return [
    ...unstorable.map(
      (value) =>
        `- [unstorable] ${rowPlaceOf(value, places)}, ${columnOf(value)}: ${value.problem}`,
    ),
    ...blockers.map(
      (blocker) => `- [${blocker.code}] ${refusalText(blocker, context)}`,
    ),
  ];
};
