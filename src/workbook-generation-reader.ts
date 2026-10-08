import type ExcelJS from 'exceljs';

import type {
  CollectionSource,
  FieldSpec,
  PlacedItem,
  WorkbookSpec,
} from './schema.js';

import { workbookGenerations } from './import/generations.js';
import { readHeaders, readRows } from './workbook-row-reader.js';
import {
  getWorksheet,
  readCellText,
  sheetPlace,
  WorkbookDataError,
} from './workbook-values.js';

type GenerationColumnsSource = Extract<
  CollectionSource,
  { readonly kind: 'generation-columns' }
>;

// Whether the workbook generation whose equivalency column a field reads
// has a curriculum.
const hasCurriculum = (field: FieldSpec): boolean => {
  const generation = workbookGenerations.find(
    ({ equivalencyColumn }) => equivalencyColumn === field.target,
  );
  if (generation === undefined) {
    throw new TypeError(`${field.target}: no workbook generation`);
  }
  return generation.has_curriculum;
};

// The fields to read: those whose column the sheet heads, and those of a
// generation with a curriculum, whose missing column the rows reader
// refuses. Any other non-blank header fails the read; a label-only
// generation's column may be missing.
const readableFields = (
  worksheet: ExcelJS.Worksheet,
  spec: WorkbookSpec,
  sheet: string,
): readonly FieldSpec[] => {
  const headers = readHeaders(worksheet.getRow(1));
  const known = new Set(spec.fields.map(({ source }) => source));
  for (const [header, column] of headers) {
    if (header.trim() !== '' && !known.has(header)) {
      throw new WorkbookDataError(
        `${sheetPlace(sheet, 1, column)}: header ${JSON.stringify(header.slice(0, 40))} names no known generation`,
      );
    }
  }
  return spec.fields.filter(
    (field) => headers.has(field.source) || hasCurriculum(field),
  );
};

const isBlank = (cell: ExcelJS.Cell): boolean =>
  readCellText(cell).trim() === '';

// The first row below the header that fills a column, if any.
const firstFilledRow = (
  worksheet: ExcelJS.Worksheet,
  column: number,
): number | undefined => {
  for (let row = 2; row <= worksheet.actualRowCount; row += 1) {
    if (!isBlank(worksheet.getRow(row).getCell(column))) {
      return row;
    }
  }
  return undefined;
};

// A column with a blank header is not read, so it must hold nothing: a
// cleared generation header over its labels fails rather than reading as a
// missing column. Row 1 is scanned to the sheet's last column (columnCount).
const assertUnheadedEmpty = (
  worksheet: ExcelJS.Worksheet,
  sheet: string,
): void => {
  const header = worksheet.getRow(1);
  for (let column = 1; column <= worksheet.columnCount; column += 1) {
    const row = isBlank(header.getCell(column))
      ? firstFilledRow(worksheet, column)
      : undefined;
    if (row !== undefined) {
      throw new WorkbookDataError(
        `${sheetPlace(sheet, row, column)}: not empty under an empty header`,
      );
    }
  }
};

// A sheet of rows with one label column per workbook generation, each
// headed as its field names it (Еквиваленции: "Предмет (2018)"). A
// missing label-only column reads as empty on every row.
export const readGenerationColumns = (
  workbook: ExcelJS.Workbook,
  spec: WorkbookSpec,
  { sheet }: GenerationColumnsSource,
): readonly PlacedItem[] => {
  const worksheet = getWorksheet(workbook, sheet);
  const fields = readableFields(worksheet, spec, sheet);
  const rows = readRows(workbook, { ...spec, fields }, { kind: 'rows', sheet });
  assertUnheadedEmpty(worksheet, sheet);
  return rows.map(({ item, place }) => ({
    item: Object.fromEntries(
      spec.fields.map(({ target }) => [target, item[target] ?? null]),
    ),
    place,
  }));
};
