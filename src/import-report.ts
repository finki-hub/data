import type { ImportPlan } from './import/plan.js';
import type { UnstorableValue } from './import/storable.js';
import type { WorkbookPlaces } from './workbook.js';

import { countByCode, countKeys, type Finding } from './import/findings.js';

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

// The sheet and rows of one case, such as "Наставен Кадар rows 12, 13".
const placeOf = (
  { collection, ids }: Finding,
  places: WorkbookPlaces,
): string => {
  const bySheet = Map.groupBy(
    ids.flatMap((id) => places[collection][id - 1] ?? []),
    ({ sheet }) => sheet,
  );
  return [...bySheet]
    .map(
      ([sheet, rows]) =>
        `${sheet} ${rows.length === 1 ? 'row' : 'rows'} ${rows.map(({ row }) => String(row)).join(', ')}`,
    )
    .join(', ');
};

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
// hold, named by sheet, row and column, then one line per code of the
// blocking cases, each case named by its sheet and rows. Never a value.
export const refusalLines = (
  { blockers, unstorable }: ImportPlan,
  places: WorkbookPlaces,
): readonly string[] => [
  ...unstorable.map(
    (value) =>
      `- ${rowPlaceOf(value, places)}: ${columnOf(value)} ${value.problem}`,
  ),
  ...[...Map.groupBy(blockers, ({ code }) => code)].map(
    ([code, cases]) =>
      `- ${code}: ${cases.map((item) => placeOf(item, places)).join('; ')}`,
  ),
];
