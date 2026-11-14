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
  sheetPlace,
  WorkbookDataError,
} from './workbook-values.js';

type RowContext = {
  readonly fields: readonly FieldSpec[];
  readonly filledValues: Map<string, string>;
  // Per `id` field, the row each id was first read on.
  readonly firstRows: ReadonlyMap<string, Map<string, number>>;
  readonly headerPositions: ReadonlyMap<string, number>;
  readonly sheet: string;
};

// The column of each header text in a sheet's first row (a repeated text,
// its last column).
export const readHeaders = (row: ExcelJS.Row): ReadonlyMap<string, number> => {
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
  { headerRow, sheet }: { readonly headerRow: number; readonly sheet: string },
  fields: readonly FieldSpec[],
  headerPositions: ReadonlyMap<string, number>,
): void => {
  for (const fieldSpec of fields) {
    if (
      fieldSpec.sourceColumn === undefined &&
      !headerPositions.has(fieldSpec.source)
    ) {
      throw new WorkbookDataError(
        `${sheetPlace(sheet, headerRow)}: missing column ${JSON.stringify(fieldSpec.source)}`,
      );
    }
  }
};

// An `id` field holds each id once in its column: a repeat names the row
// of the first, never the id.
const assertFirstId = (
  fieldSpec: FieldSpec,
  { row, text }: { readonly row: number; readonly text: string },
  context: RowContext,
): void => {
  const firstRows = context.firstRows.get(fieldSpec.target);
  if (firstRows === undefined || text.trim() === '') {
    return;
  }
  const first = firstRows.get(text);
  if (first !== undefined) {
    throw new WorkbookDataError(
      `${sheetPlace(context.sheet, row, fieldSpec.source)}: repeats the id of row ${String(first)}`,
    );
  }
  firstRows.set(text, row);
};

// The column of a field: its fixed column, else the one its header heads.
const columnOf = (fieldSpec: FieldSpec, context: RowContext): number => {
  const columnNumber =
    fieldSpec.sourceColumn ?? context.headerPositions.get(fieldSpec.source);
  if (columnNumber === undefined) {
    throw new WorkbookDataError(
      `${context.sheet}: no column position for ${JSON.stringify(fieldSpec.source)} (internal)`,
    );
  }
  return columnNumber;
};

// A row none of whose read cells holds text: a gap or a trailing row the
// sheet only formats. It is not read, so it neither fills down nor misses
// a required value.
const isBlankRow = (row: ExcelJS.Row, context: RowContext): boolean =>
  context.fields.every(
    (fieldSpec) =>
      readCellText(row.getCell(columnOf(fieldSpec, context))).trim() === '',
  );

const readRow = (
  row: ExcelJS.Row,
  rowNumber: number,
  context: RowContext,
): null | WorkbookItem => {
  const item: Record<string, Scalar> = {};
  let hasContent = false;

  for (const fieldSpec of context.fields) {
    const columnNumber = columnOf(fieldSpec, context);

    // A `fillMerged` field reads a cell a merged range covers as the
    // range's top-left cell (its master; an unmerged cell is its own).
    const cell =
      fieldSpec.fillMerged === true
        ? row.getCell(columnNumber).master
        : row.getCell(columnNumber);
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

    item[fieldSpec.target] = convertCell(text, fieldSpec, {
      row: rowNumber,
      sheet: context.sheet,
    });
    assertFirstId(fieldSpec, { row: rowNumber, text }, context);
    hasContent ||= text.trim() !== '';
  }

  return hasContent ? item : null;
};

// A sheet of rows: its headers in the header row (the first unless the
// source names another), its data below.
export const readRows = (
  workbook: ExcelJS.Workbook,
  spec: WorkbookSpec,
  source: Extract<CollectionSource, { readonly kind: 'rows' }>,
): readonly PlacedItem[] => {
  const worksheet = getWorksheet(workbook, source.sheet);
  const headerRow = source.headerRow ?? 1;
  const headerPositions = readHeaders(worksheet.getRow(headerRow));
  validateHeaders(
    { headerRow, sheet: source.sheet },
    spec.fields,
    headerPositions,
  );

  const items: PlacedItem[] = [];
  const context: RowContext = {
    fields: spec.fields,
    filledValues: new Map(),
    firstRows: new Map(
      spec.fields.flatMap(({ kind, target }) =>
        kind === 'id' ? [[target, new Map<string, number>()] as const] : [],
      ),
    ),
    headerPositions,
    sheet: source.sheet,
  };
  for (
    let rowNumber = headerRow + 1;
    // rowCount is the last row's number; actualRowCount counts only the
    // rows holding a value, so a gap above the data would cut the end off.
    rowNumber <= worksheet.rowCount;
    rowNumber += 1
  ) {
    const row = worksheet.getRow(rowNumber);
    if (isBlankRow(row, context)) {
      continue;
    }
    const item = readRow(row, rowNumber, context);
    if (item !== null) {
      items.push({ item, place: { row: rowNumber, sheet: source.sheet } });
    }
  }

  return items;
};
