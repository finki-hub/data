import type ExcelJS from 'exceljs';

import type { CollectionSource, MigrationItem } from './schema.js';

import {
  getWorksheet,
  readCellText,
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
): readonly MigrationItem[] => {
  const items: MigrationItem[] = [];

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
          `Missing student index in ${context.sheet} at row ${rowNumber}`,
        );
      }

      items.push({
        index_number: indexNumber,
        name,
        source_group: context.sourceGroup,
      });
    }
  }

  return items;
};

const readStudentSheet = (
  workbook: ExcelJS.Workbook,
  sheet: string,
): readonly MigrationItem[] => {
  const worksheet = getWorksheet(workbook, sheet);
  const items: MigrationItem[] = [];

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
        `Missing student source group in ${sheet} column ${columnNumber}`,
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
): readonly MigrationItem[] =>
  source.sheets.flatMap((sheet) => readStudentSheet(workbook, sheet));

type DiscordColumnContext = {
  readonly endRow: number;
  readonly sheet: string;
  readonly worksheet: ExcelJS.Worksheet;
};

const readDiscordColumn = (
  context: DiscordColumnContext,
  channelColumn: number,
): readonly MigrationItem[] => {
  const items: MigrationItem[] = [];
  const semester = (channelColumn + 1) / 2;

  for (let rowNumber = 2; rowNumber <= context.endRow; rowNumber += 1) {
    const channel = readCellText(
      context.worksheet.getRow(rowNumber).getCell(channelColumn),
    ).trim();
    const courseNames = readCellText(
      context.worksheet.getRow(rowNumber).getCell(channelColumn + 1),
    ).trim();
    if (channel !== '' || courseNames !== '') {
      if (channel === '' || courseNames === '') {
        throw new WorkbookDataError(
          `Incomplete Discord channel pair in ${context.sheet} at row ${rowNumber}`,
        );
      }

      items.push({ channel, course_names: courseNames, semester });
    }
  }

  return items;
};

export const readDiscordPairs = (
  workbook: ExcelJS.Workbook,
  source: Extract<CollectionSource, { readonly kind: 'discord-pairs' }>,
): readonly MigrationItem[] => {
  const worksheet = getWorksheet(workbook, source.sheet);
  const context: DiscordColumnContext = {
    endRow: source.endRow,
    sheet: source.sheet,
    worksheet,
  };
  const items: MigrationItem[] = [];

  for (
    let channelColumn = 1;
    channelColumn <= worksheet.actualColumnCount;
    channelColumn += 2
  ) {
    items.push(...readDiscordColumn(context, channelColumn));
  }

  return items;
};
