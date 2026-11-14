import type ExcelJS from 'exceljs';

import type { CollectionSource, PlacedItem } from './schema.js';

import {
  getWorksheet,
  readCellText,
  sheetPlace,
  WorkbookDataError,
} from './workbook-values.js';

type StudentColumnContext = {
  readonly sheet: string;
  readonly sourceGroup: string;
  readonly worksheet: ExcelJS.Worksheet;
};

const readStudentColumn = (
  context: StudentColumnContext,
  columnNumber: number,
): readonly PlacedItem[] => {
  const items: PlacedItem[] = [];

  for (
    let rowNumber = 3;
    rowNumber <= context.worksheet.actualRowCount;
    rowNumber += 1
  ) {
    const indexNumber = readCellText(
      context.worksheet.getRow(rowNumber).getCell(columnNumber),
    ).trim();
    const name = readCellText(
      context.worksheet.getRow(rowNumber).getCell(columnNumber + 1),
    ).trim();
    if (name !== '') {
      if (indexNumber === '') {
        throw new WorkbookDataError(
          `${sheetPlace(context.sheet, rowNumber)}: missing student index`,
        );
      }

      items.push({
        item: {
          index_number: indexNumber,
          name,
          source_group: context.sourceGroup,
        },
        place: { row: rowNumber, sheet: context.sheet },
      });
    }
  }

  return items;
};

const readStudentSheet = (
  workbook: ExcelJS.Workbook,
  sheet: string,
): readonly PlacedItem[] => {
  const worksheet = getWorksheet(workbook, sheet);
  const items: PlacedItem[] = [];

  for (
    let columnNumber = 1;
    columnNumber <= worksheet.actualColumnCount;
    columnNumber += 2
  ) {
    const sourceGroup = readCellText(
      worksheet.getRow(1).getCell(columnNumber),
    ).trim();
    if (sourceGroup === '') {
      throw new WorkbookDataError(
        `${sheetPlace(sheet, 1, columnNumber)}: missing student source group`,
      );
    }

    items.push(
      ...readStudentColumn({ sheet, sourceGroup, worksheet }, columnNumber),
    );
  }

  return items;
};

export const readStudentPairs = (
  workbook: ExcelJS.Workbook,
  source: Extract<CollectionSource, { readonly kind: 'student-pairs' }>,
): readonly PlacedItem[] =>
  source.sheets.flatMap((sheet) => readStudentSheet(workbook, sheet));
