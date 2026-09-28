import type ExcelJS from 'exceljs';

import type {
  CollectionSource,
  FieldSpec,
  PlacedItem,
  Scalar,
  WorkbookItem,
  WorkbookSpec,
} from './schema.js';

import {
  convertCell,
  getWorksheet,
  isFormulaCell,
  readCellText,
  WorkbookDataError,
} from './workbook-values.js';

type RowContext = {
  readonly fields: readonly FieldSpec[];
  readonly filledValues: Map<string, string>;
  readonly headerPositions: ReadonlyMap<string, number>;
};

const readHeaders = (row: ExcelJS.Row): ReadonlyMap<string, number> => {
  const positions = new Map<string, number>();
  row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    const text = readCellText(cell);
    if (text !== '') {
      positions.set(text, columnNumber);
    }
  });
  return positions;
};

const validateHeaders = (
  sheet: string,
  fields: readonly FieldSpec[],
  headerPositions: ReadonlyMap<string, number>,
): void => {
  for (const fieldSpec of fields) {
    if (
      fieldSpec.sourceColumn === undefined &&
      !headerPositions.has(fieldSpec.source)
    ) {
      throw new WorkbookDataError(
        `Worksheet ${JSON.stringify(sheet)} is missing column ${JSON.stringify(fieldSpec.source)}`,
      );
    }
  }
};

const readRow = (
  row: ExcelJS.Row,
  rowNumber: number,
  context: RowContext,
): null | WorkbookItem => {
  const item: Record<string, Scalar> = {};
  let hasContent = false;

  for (const fieldSpec of context.fields) {
    const columnNumber =
      fieldSpec.sourceColumn ?? context.headerPositions.get(fieldSpec.source);
    if (columnNumber === undefined) {
      throw new WorkbookDataError(
        `Column position disappeared for ${fieldSpec.source}`,
      );
    }

    const cell = row.getCell(columnNumber);
    const cellText =
      fieldSpec.sourceMode === 'literal' && isFormulaCell(cell)
        ? ''
        : readCellText(cell);
    const text =
      cellText.trim() === '' && fieldSpec.fillDown === true
        ? (context.filledValues.get(fieldSpec.target) ?? '')
        : cellText;
    if (fieldSpec.fillDown === true && cellText.trim() !== '') {
      context.filledValues.set(fieldSpec.target, cellText);
    }

    item[fieldSpec.target] = convertCell(text, fieldSpec, rowNumber);
    hasContent ||= text.trim() !== '';
  }

  return hasContent ? item : null;
};

// A sheet of rows: its headers in the first row, its data below.
export const readRows = (
  workbook: ExcelJS.Workbook,
  spec: WorkbookSpec,
  source: Extract<CollectionSource, { readonly kind: 'rows' }>,
): readonly PlacedItem[] => {
  const worksheet = getWorksheet(workbook, source.sheet);
  const headerPositions = readHeaders(worksheet.getRow(1));
  validateHeaders(source.sheet, spec.fields, headerPositions);

  const items: PlacedItem[] = [];
  const context: RowContext = {
    fields: spec.fields,
    filledValues: new Map(),
    headerPositions,
  };
  for (
    let rowNumber = 2;
    rowNumber <= worksheet.actualRowCount;
    rowNumber += 1
  ) {
    const item = readRow(worksheet.getRow(rowNumber), rowNumber, context);
    if (item !== null) {
      items.push({ item, place: { row: rowNumber, sheet: source.sheet } });
    }
  }

  return items;
};
