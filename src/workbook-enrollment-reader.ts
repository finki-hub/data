import type ExcelJS from 'exceljs';

import type { CollectionSource, PlacedItem } from './schema.js';

import {
  getWorksheet,
  isFormulaCell,
  readCellText,
  WorkbookDataError,
} from './workbook-values.js';

const firstYearColumn = 3;
const firstPatternColumn = 5;
const columnStride = 3;

const assertPattern = (pattern: string, rowNumber: number): void => {
  try {
    new RegExp(pattern, 'u');
  } catch (error) {
    throw new WorkbookDataError(
      `Invalid enrollment pattern at row ${rowNumber}`,
      { cause: error },
    );
  }
};

type PatternCellContext = {
  readonly academicYear: string;
  readonly patternColumn: number;
  readonly rowNumber: number;
  readonly sheet: string;
  readonly worksheet: ExcelJS.Worksheet;
};

const readPatternCell = (context: PatternCellContext): null | PlacedItem => {
  const row = context.worksheet.getRow(context.rowNumber);
  const patternCell = row.getCell(context.patternColumn);
  if (isFormulaCell(patternCell)) {
    return null;
  }

  const pattern = readCellText(patternCell).trim();
  if (pattern === '') {
    return null;
  }

  const courseName = readCellText(row.getCell(1)).trim();
  if (courseName === '') {
    throw new WorkbookDataError(
      `Missing course name for enrollment pattern at row ${context.rowNumber}`,
    );
  }

  assertPattern(pattern, context.rowNumber);
  return {
    item: {
      academic_year: context.academicYear,
      course_name: courseName,
      pattern,
    },
    place: { row: context.rowNumber, sheet: context.sheet },
  };
};

type PatternSource = Extract<
  CollectionSource,
  { readonly kind: 'course-enrollment-patterns' }
>;

type YearColumn = {
  readonly academicYear: string;
  readonly patternColumn: number;
};

// Every academic-year column group of the sheet, in sheet order: the year
// label in row 1 and the pattern column two to its right. A group without
// a label, or a label named twice, is refused.
const yearColumns = (
  worksheet: ExcelJS.Worksheet,
  sheet: string,
): readonly YearColumn[] => {
  const columns: YearColumn[] = [];
  for (
    let patternColumn = firstPatternColumn;
    patternColumn <= worksheet.actualColumnCount;
    patternColumn += columnStride
  ) {
    const yearColumn = patternColumn - firstPatternColumn + firstYearColumn;
    const academicYear = readCellText(
      worksheet.getRow(1).getCell(yearColumn),
    ).trim();
    if (academicYear === '') {
      throw new WorkbookDataError(
        `Missing academic year in ${sheet} column ${yearColumn}`,
      );
    }
    if (columns.some((column) => column.academicYear === academicYear)) {
      throw new WorkbookDataError(
        `Academic year ${academicYear} heads two column groups of ${sheet}`,
      );
    }
    columns.push({ academicYear, patternColumn });
  }
  return columns;
};

// The academic years the enrollment sheet names, in its order (newest
// first in the workbook): the one-time import seeds exactly these years
// and one fallback rule per course and year.
export const readEnrollmentYears = (
  workbook: ExcelJS.Workbook,
  source: PatternSource,
): readonly string[] =>
  yearColumns(getWorksheet(workbook, source.sheet), source.sheet).map(
    ({ academicYear }) => academicYear,
  );

export const readCourseEnrollmentPatterns = (
  workbook: ExcelJS.Workbook,
  source: PatternSource,
): readonly PlacedItem[] => {
  const worksheet = getWorksheet(workbook, source.sheet);
  const items: PlacedItem[] = [];

  for (const { academicYear, patternColumn } of yearColumns(
    worksheet,
    source.sheet,
  )) {
    for (
      let rowNumber = 2;
      rowNumber <= worksheet.actualRowCount;
      rowNumber += 1
    ) {
      const item = readPatternCell({
        academicYear,
        patternColumn,
        rowNumber,
        sheet: source.sheet,
        worksheet,
      });
      if (item !== null) {
        items.push(item);
      }
    }
  }

  return items;
};
