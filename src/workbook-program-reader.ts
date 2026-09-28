import type ExcelJS from 'exceljs';

import type { CollectionSource } from './schema.js';

import {
  type EntrySource,
  ProgramHeaderError,
  type ProgramHeaders,
  type ProgramSeed,
  stateColumns,
  workbookPrograms,
} from './migrations/generations.js';
import { workbookSpecs } from './specs/workbook.js';
import {
  getWorksheet,
  readFirstLine,
  WorkbookDataError,
} from './workbook-values.js';

// The sheet and header row of a curriculum sheet, as its workbook spec
// reads it.
const sourceOf = (
  sheet: EntrySource,
): Extract<CollectionSource, { readonly kind: 'rows' }> => {
  const source: CollectionSource | undefined = workbookSpecs.find(
    ({ key }) => key === sheet,
  )?.source;
  if (source?.kind !== 'rows') {
    throw new TypeError(`${sheet} is not read from a sheet of rows`);
  }
  return source;
};

const headersOf = (
  workbook: ExcelJS.Workbook,
  sheet: EntrySource,
): readonly string[] => {
  const source = sourceOf(sheet);
  const row = getWorksheet(workbook, source.sheet).getRow(
    source.headerRow ?? 1,
  );
  return stateColumns(sheet).map(({ column }) =>
    readFirstLine(row.getCell(column)).trim(),
  );
};

// The study-program headers of both curriculum sheets: the first line of
// the text heading each program column (plain, rich or linked text), in
// column order.
export const readProgramHeaders = (
  workbook: ExcelJS.Workbook,
): ProgramHeaders => ({
  curriculum_2018: headersOf(workbook, 'curriculum_2018'),
  curriculum_2023: headersOf(workbook, 'curriculum_2023'),
});

// The study programs the curriculum sheets head; a header outside the
// closed mapping fails here, before anything reaches Directus.
export const readStudyPrograms = (
  workbook: ExcelJS.Workbook,
): readonly ProgramSeed[] => {
  try {
    return workbookPrograms(readProgramHeaders(workbook));
  } catch (error) {
    if (error instanceof ProgramHeaderError) {
      throw new WorkbookDataError(error.message, { cause: error });
    }
    throw error;
  }
};
