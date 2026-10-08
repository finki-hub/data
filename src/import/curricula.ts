import type { WorkbookRows } from './workbook-rows.js';

import {
  type EntrySource,
  generationOfSheet,
  programKey,
  programOfColumn,
  stateColumns,
} from './generations.js';
import { compositeKey, planned, type PlannedRow, ref } from './planned.js';

type CurriculumRow =
  | WorkbookRows['curriculum_2018'][number]
  | WorkbookRows['curriculum_2023'][number];

// The plan key of the entry of a curriculum sheet row.
export const entryKey = (sheet: EntrySource, id: number): string =>
  compositeKey(sheet, id);

const sheetsOf = (
  rows: WorkbookRows,
): ReadonlyArray<readonly [EntrySource, readonly CurriculumRow[]]> => [
  ['curriculum_2023', rows.curriculum_2023],
  ['curriculum_2018', rows.curriculum_2018],
];

// One curriculum_entries row per curriculum sheet row, orphans and
// duplicates included: every column read copied literally (an empty string
// stays an empty string; the projection decides what a public file
// omits), in the generation of its sheet. The sheet's Ниво is not read:
// the level is the one the code gives. Every 2023 row, then every 2018
// row, in workbook order.
export const planCurriculumEntries = (
  rows: WorkbookRows,
): readonly PlannedRow[] =>
  sheetsOf(rows).flatMap(([sheet, sheetRows]) =>
    sheetRows.map((row) =>
      planned(
        entryKey(sheet, row.id),
        {
          catalog_order: row.catalog_order,
          channel: row.channel,
          code: row.code,
          generation: ref('curriculum_generations', generationOfSheet(sheet)),
          name: row.name,
          prerequisites: row.prerequisites,
          semester: row.semester,
          url: row.url,
        },
        { id: row.id, source: sheet },
      ),
    ),
  );

const cellOf = (row: CurriculumRow, column: string): unknown =>
  Object.entries(row).find(([key]) => key === column)?.[1];

// One state row per nonempty program cell of every curriculum row, for
// the program of the entry's generation that column names; an empty cell
// writes none, which the projection publishes like the empty column it
// was (the key is omitted).
export const planProgramStates = (rows: WorkbookRows): readonly PlannedRow[] =>
  sheetsOf(rows).flatMap(([sheet, sheetRows]) => {
    const generation = generationOfSheet(sheet);
    const columns = stateColumns(sheet);
    return sheetRows.flatMap((row) =>
      columns.flatMap(({ target }) => {
        const state = cellOf(row, target);
        if (typeof state !== 'string' || state === '') {
          return [];
        }
        const entry = entryKey(sheet, row.id);
        const program = programKey(generation, programOfColumn(target));
        return [
          planned(
            compositeKey(entry, program),
            {
              entry: ref('curriculum_entries', entry),
              program: ref('study_programs', program),
              state,
            },
            { id: row.id, source: sheet },
          ),
        ];
      }),
    );
  });
