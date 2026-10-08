import type ExcelJS from 'exceljs';

import type { CollectionSource, PlacedItem } from './schema.js';

import {
  type CellPlace,
  getWorksheet,
  isFormulaCell,
  readCellText,
  type SheetCell,
  sheetPlace,
  WorkbookDataError,
} from './workbook-values.js';

// Column A is the course; the year groups start at column B. A group is
// three columns, its patterns in the third.
const firstGroupColumn = 2;
const groupWidth = 3;

// An academic-year label: two consecutive calendar years, such as
// 2025/2026. Such labels order chronologically as text, and courses.json
// keys its counts by them.
const yearLabelPattern = /^(?<start>\d{4})\/(?<end>\d{4})$/u;

export const isYearLabel = (label: string): boolean => {
  const groups = yearLabelPattern.exec(label)?.groups;
  return Number(groups?.['end']) === Number(groups?.['start']) + 1;
};

const assertPattern = (pattern: string, { row, sheet }: CellPlace): void => {
  try {
    new RegExp(pattern, 'u');
  } catch (error) {
    throw new WorkbookDataError(
      `${sheetPlace(sheet, row)}: invalid enrollment pattern`,
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

// A typed pattern, or null for an empty cell and a formula cell (the
// import reports the latter by its place, readFormulaPatternCells).
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
      `${sheetPlace(context.sheet, context.rowNumber)}: missing course name`,
    );
  }

  assertPattern(pattern, { row: context.rowNumber, sheet: context.sheet });
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

// A group's label: its year, column and sheet.
type YearGroup = {
  readonly academicYear: string;
  readonly label: number;
  readonly sheet: string;
};

const headerText = (worksheet: ExcelJS.Worksheet, column: number): string =>
  readCellText(worksheet.getRow(1).getCell(column)).trim();

// The two row-1 cells after a group's label must read empty: a merged
// label leaves them empty, and a header there would shift the group.
const assertGroupEmpty = (
  worksheet: ExcelJS.Worksheet,
  { academicYear, label, sheet }: YearGroup,
): void => {
  for (let column = label + 1; column < label + groupWidth; column += 1) {
    if (headerText(worksheet, column) !== '') {
      throw new WorkbookDataError(
        `${sheetPlace(sheet, 1, column)}: not empty inside the ${academicYear} group`,
      );
    }
  }
};

// Every academic-year column group of the sheet, in sheet order. Row 1 is
// scanned from column B to the sheet's last column (columnCount, which a
// fully empty column inside the sheet does not shorten): an academic-year
// label starts a group, an empty cell outside a group is skipped, and any
// other text, a year heading two groups or a sheet without a group is
// refused.
const yearColumns = (
  worksheet: ExcelJS.Worksheet,
  sheet: string,
): readonly YearColumn[] => {
  const columns: YearColumn[] = [];
  const lastColumn = worksheet.columnCount;
  let label = firstGroupColumn;
  while (label <= lastColumn) {
    const academicYear = headerText(worksheet, label);
    if (academicYear === '') {
      label += 1;
      continue;
    }
    if (!isYearLabel(academicYear)) {
      throw new WorkbookDataError(
        `${sheetPlace(sheet, 1, label)}: not an academic year`,
      );
    }
    if (columns.some((column) => column.academicYear === academicYear)) {
      throw new WorkbookDataError(
        `${sheetPlace(sheet, 1)}: academic year ${academicYear} heads two column groups`,
      );
    }
    assertGroupEmpty(worksheet, { academicYear, label, sheet });
    columns.push({ academicYear, patternColumn: label + groupWidth - 1 });
    label += groupWidth;
  }
  if (columns.length === 0) {
    throw new WorkbookDataError(`${sheetPlace(sheet, 1)}: no academic year`);
  }
  return columns;
};

// The academic years the enrollment sheet's column groups name, in sheet
// order (newest first in the workbook): the one-time import seeds exactly
// these years and one fallback rule per course and year.
export const readEnrollmentYears = (
  workbook: ExcelJS.Workbook,
  source: PatternSource,
): readonly string[] =>
  yearColumns(getWorksheet(workbook, source.sheet), source.sheet).map(
    ({ academicYear }) => academicYear,
  );

// Every pattern cell below row 1, group by group in sheet order and row by
// row, with its year. The group's other two columns are never read.
const patternCells = (
  worksheet: ExcelJS.Worksheet,
  sheet: string,
): readonly PatternCellContext[] =>
  yearColumns(worksheet, sheet).flatMap(({ academicYear, patternColumn }) =>
    Array.from(
      { length: Math.max(worksheet.actualRowCount - 1, 0) },
      (_, index) => ({
        academicYear,
        patternColumn,
        rowNumber: index + 2,
        sheet,
        worksheet,
      }),
    ),
  );

// The typed patterns of every year group: each pattern cell that holds
// text rather than a formula, with its course and year.
export const readCourseEnrollmentPatterns = (
  workbook: ExcelJS.Workbook,
  source: PatternSource,
): readonly PlacedItem[] =>
  patternCells(getWorksheet(workbook, source.sheet), source.sheet).flatMap(
    (context) => {
      const item = readPatternCell(context);
      return item === null ? [] : [item];
    },
  );

// The pattern cells that hold a formula, which the import does not read:
// each by its sheet, row and year (its group's header), never by its
// formula or result.
export const readFormulaPatternCells = (
  workbook: ExcelJS.Workbook,
  source: PatternSource,
): readonly SheetCell[] =>
  patternCells(getWorksheet(workbook, source.sheet), source.sheet).flatMap(
    ({ academicYear, patternColumn, rowNumber, worksheet }) =>
      isFormulaCell(worksheet.getRow(rowNumber).getCell(patternColumn))
        ? [{ column: academicYear, row: rowNumber, sheet: source.sheet }]
        : [],
  );
