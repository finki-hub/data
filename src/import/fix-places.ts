import type { SheetRow, WorkbookKey, WorkbookSpec } from '../schema.js';
import type { WorkbookPlaces } from '../workbook.js';

import { workbookSpecs } from '../specs/workbook.js';
import { sheetPlace } from '../workbook-values.js';
import {
  type Finding,
  isPlacedCode,
  type PlacedCode,
  relatedIds,
} from './findings.js';
import { channelNameAt, headerOf, linesText } from './refusal-places.js';

// Where each rule fix of the import applies, and where each Дискорд course
// name that matches no course stands, for the summary's `fixes`, from the
// workbook places: `<sheet> row N[, column "X"][, line L][ (used: row M)]`,
// or for a Дискорд name `Дискорд row N, column C, name K[ (used: row M[,
// column C'])]`. A place names sheets, rows, columns, lines and name
// positions, never a value.

type FixPlace = SheetRow & { readonly text: string };

type Placer = (finding: Finding, places: WorkbookPlaces) => FixPlace | null;

const rowOf = (
  collection: WorkbookKey,
  id: number | undefined,
  places: WorkbookPlaces,
): null | SheetRow =>
  (id === undefined ? undefined : places[collection][id - 1]) ?? null;

// A typed pattern cell: its Слушатели row, its column named by its year.
const patternCell: Placer = ({ academicYear, collection, ids }, places) => {
  const row = rowOf(collection, ids[0], places);
  return row === null || academicYear === undefined
    ? null
    : { ...row, text: sheetPlace(row.sheet, row.row, academicYear) };
};

// A Дискорд course name: its channel row, the column of its cell and its
// position there.
const namePlace: Placer = ({ channelName, collection, ids }, places) => {
  const row = rowOf(collection, ids[0], places);
  return row === null || channelName === undefined
    ? null
    : { ...row, text: channelNameAt(row, channelName) };
};

const placers: Readonly<Record<PlacedCode, Placer>> = {
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
  // The later name of the course, and the channel row it keeps; that row's
  // column only when it differs.
  duplicate_course_channel: (finding, places) => {
    const place = namePlace(finding, places);
    const { channelName, usedChannel } = finding;
    const used = rowOf('discord_channels', usedChannel?.id, places);
    if (place === null || used === null || usedChannel === undefined) {
      return place;
    }
    const column =
      usedChannel.column === channelName?.column
        ? ''
        : `, column ${String(usedChannel.column)}`;
    return {
      ...place,
      text: `${place.text} (used: row ${String(used.row)}${column})`,
    };
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
  // The newest year's cell of the course's Слушатели row.
  newest_year_widened: patternCell,
  // The cell whose line breaks were removed.
  pattern_line_break: patternCell,
  // The teaching cell, and the lines that repeat a name.
  repeated_staff_name: ({ collection, field, ids, lines }, places) => {
    const row = rowOf(collection, ids[0], places);
    if (row === null || field === undefined) {
      return null;
    }
    const cell = sheetPlace(row.sheet, row.row, headerOf(collection, field));
    return { ...row, text: `${cell}, ${linesText(lines ?? [])}` };
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
  // The name, which links nothing.
  unmatched_channel_course: namePlace,
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

// The places of the placed warnings among the findings, per code
// (sorted), each list in sheet order, then row order; codes without a case
// are left out.
export const fixPlaces = (
  findings: readonly Finding[],
  places: WorkbookPlaces,
): Readonly<Record<string, readonly string[]>> => {
  const placed = findings.flatMap((finding) => {
    const { code } = finding;
    if (!isPlacedCode(code)) {
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
