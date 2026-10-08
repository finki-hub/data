import type { SheetRow, WorkbookKey, WorkbookSpec } from '../schema.js';
import type { WorkbookPlaces } from '../workbook.js';

import { workbookSpecs } from '../specs/workbook.js';
import { sheetPlace } from '../workbook-values.js';
import {
  type Finding,
  isRuleFixCode,
  relatedIds,
  type RuleFixCode,
} from './findings.js';
import { headerOf } from './refusal-places.js';

// Where each rule fix of the import applies, for the summary's `fixes`:
// `<sheet> row N[, column "X"][, line L][ (used: row M)]`, from the
// workbook places. A place names sheets, rows, column headers and lines,
// never a value.

type FixPlace = SheetRow & { readonly text: string };

type Placer = (finding: Finding, places: WorkbookPlaces) => FixPlace | null;

const rowOf = (
  collection: WorkbookKey,
  id: number | undefined,
  places: WorkbookPlaces,
): null | SheetRow =>
  (id === undefined ? undefined : places[collection][id - 1]) ?? null;

const placers: Readonly<Record<RuleFixCode, Placer>> = {
  // The later teaching row, and the row used instead.
  duplicate_assignment: (finding, places) => {
    const row = rowOf('teaching_assignments', finding.ids[0], places);
    if (row === null) {
      return null;
    }
    const used = rowOf(
      'teaching_assignments',
      relatedIds(finding, 'teaching_assignments')[0],
      places,
    );
    const usedText = used === null ? '' : ` (used: row ${String(used.row)})`;
    return { ...row, text: `${sheetPlace(row.sheet, row.row)}${usedText}` };
  },
  // The pattern cell, its column named by its year.
  formula_pattern_cell: ({ cell }) =>
    cell === undefined
      ? null
      : {
          row: cell.row,
          sheet: cell.sheet,
          text: sheetPlace(cell.sheet, cell.row, cell.column),
        },
  // The course's availability cell of that generation.
  unlinked_availability: ({ generation, ids }, places) => {
    const row = rowOf('courses', ids[0], places);
    if (row === null || generation === undefined) {
      return null;
    }
    const column = headerOf('courses', `available_${generation}`);
    return { ...row, text: sheetPlace(row.sheet, row.row, column) };
  },
};

const sheetsOf = ({ source }: WorkbookSpec): readonly string[] =>
  'sheet' in source ? [source.sheet] : source.sheets;

// A sheet's position in the order the import reads the workbook.
const sheetRank = (sheet: string): number => {
  const index = workbookSpecs.findIndex((spec) =>
    sheetsOf(spec).includes(sheet),
  );
  return index === -1 ? workbookSpecs.length : index;
};

const collator = new Intl.Collator('en');

// The places of the rule fixes among the findings, per code (sorted), each
// list in sheet order, then row order; codes without a case are left out.
export const fixPlaces = (
  findings: readonly Finding[],
  places: WorkbookPlaces,
): Readonly<Record<string, readonly string[]>> => {
  const placed = findings.flatMap((finding) => {
    const { code } = finding;
    if (!isRuleFixCode(code)) {
      return [];
    }
    const place = placers[code](finding, places);
    return place === null ? [] : [{ code, place }];
  });
  return Object.fromEntries(
    Map.groupBy(placed, ({ code }) => code)
      .entries()
      .toArray()
      .toSorted(([left], [right]) => collator.compare(left, right))
      .map(([code, items]) => [
        code,
        items
          .map(({ place }) => place)
          .toSorted(
            (left, right) =>
              sheetRank(left.sheet) - sheetRank(right.sheet) ||
              left.row - right.row,
          )
          .map(({ text }) => text),
      ]),
  );
};
