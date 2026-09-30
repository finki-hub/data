import type ExcelJS from 'exceljs';

import {
  curriculumWorksheet,
  type EntrySource,
  ProgramHeaderError,
  type ProgramHeaders,
  type ProgramSeed,
  stateColumns,
  workbookPrograms,
} from './import/generations.js';
import {
  getWorksheet,
  readFirstLine,
  WorkbookDataError,
} from './workbook-values.js';

// The texts heading the program columns of a curriculum sheet, in its
// first row.
const headersOf = (
  workbook: ExcelJS.Workbook,
  sheet: EntrySource,
): readonly string[] => {
  const row = getWorksheet(workbook, curriculumWorksheet(sheet)).getRow(1);
  return stateColumns(sheet).map(({ column }) =>
    readFirstLine(row.getCell(column)).trim(),
  );
};

// The study-program headers of both curriculum sheets: the first line of
// the text heading each program column (plain, rich or linked text), in
// column order.
const readProgramHeaders = (workbook: ExcelJS.Workbook): ProgramHeaders => ({
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
