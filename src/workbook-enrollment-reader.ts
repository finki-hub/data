import type ExcelJS from 'exceljs';

import type { CollectionSource, MigrationItem } from './schema.js';

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
  readonly worksheet: ExcelJS.Worksheet;
};

const readPatternCell = (context: PatternCellContext): MigrationItem | null => {
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
    academic_year: context.academicYear,
    course_name: courseName,
    pattern,
  };
};

export const readCourseEnrollmentPatterns = (
  workbook: ExcelJS.Workbook,
  source: Extract<
    CollectionSource,
    { readonly kind: 'course-enrollment-patterns' }
  >,
): readonly MigrationItem[] => {
  const worksheet = getWorksheet(workbook, source.sheet);
  const items: MigrationItem[] = [];

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
        `Missing academic year in ${source.sheet} column ${yearColumn}`,
      );
    }

    for (
      let rowNumber = 2;
      rowNumber <= worksheet.actualRowCount;
      rowNumber += 1
    ) {
      const item = readPatternCell({
        academicYear,
        patternColumn,
        rowNumber,
        worksheet,
      });
      if (item !== null) {
        items.push(item);
      }
    }
  }

  return items;
};
