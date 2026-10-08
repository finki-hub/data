import ExcelJS from 'exceljs';
import { z } from 'zod';

import type { FieldSpec, Scalar } from './schema.js';

import { isPositiveId } from '../directus/extensions/directus-extension-data-operations/src/snapshot/contract.js';

const integerSchema = z
  .string()
  .regex(/^-?\d+$/u)
  .transform(Number);
const booleanSchema = z
  .string()
  .toUpperCase()
  .pipe(z.enum(['0', '1', 'FALSE', 'TRUE']))
  .transform((value) => value === '1' || value === 'TRUE');

// The workbook cannot be read as the import reads it. The message is
// `<place>: <fact>`, the place a sheet, row and column (sheetPlace).
export class WorkbookDataError extends Error {
  public override readonly name = 'WorkbookDataError';

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

// A place in the workbook: `<sheet> row N`, with `, column "<header>"` for
// a column named by its header or `, column N` for one by its number.
export const sheetPlace = (
  sheet: string,
  row: number,
  column?: number | string,
): string => {
  const place = `${sheet} row ${String(row)}`;
  if (column === undefined) {
    return place;
  }
  return typeof column === 'number'
    ? `${place}, column ${String(column)}`
    : `${place}, column ${JSON.stringify(column)}`;
};

// A cell's sheet and row.
export type CellPlace = { readonly row: number; readonly sheet: string };

// Rich text: runs of formatted text, read as their joined text.
const richTextSchema = z
  .object({ richText: z.array(z.object({ text: z.string() })) })
  .transform(({ richText }) => richText.map(({ text }) => text).join(''));

// A hyperlink cell: its text, plain or rich (a linked header of a
// curriculum sheet is rich text).
const hyperlinkSchema = z
  .object({
    hyperlink: z.string(),
    text: z.union([z.string(), richTextSchema]),
  })
  .transform(({ text }) => text);

const linkedTextSchema = z.union([richTextSchema, hyperlinkSchema]);

export const readCellText = (cell: ExcelJS.Cell): string => {
  if (cell.type === ExcelJS.ValueType.Merge) {
    return '';
  }

  const formulaResult: unknown = cell.result;
  if (typeof formulaResult === 'number') {
    return String(formulaResult);
  }

  if (typeof formulaResult === 'boolean') {
    return formulaResult ? 'TRUE' : 'FALSE';
  }

  if (typeof formulaResult === 'string') {
    return formulaResult;
  }

  const linked = linkedTextSchema.safeParse(cell.value);
  if (linked.success) {
    return linked.data;
  }

  const cellText: unknown = cell.text;
  return typeof cellText === 'string' ? cellText : '';
};

const lineBreak = /\r?\n/u;

// The first line of a cell's text: a curriculum sheet heads a program
// column with its code on the first line and its duration below.
export const readFirstLine = (cell: ExcelJS.Cell): string =>
  readCellText(cell).split(lineBreak, 1)[0] ?? '';

export const isFormulaCell = (cell: ExcelJS.Cell): boolean =>
  cell.type === ExcelJS.ValueType.Formula;

export const convertCell = (
  value: string,
  fieldSpec: FieldSpec,
  { row, sheet }: CellPlace,
): Scalar => {
  const place = sheetPlace(sheet, row, fieldSpec.source);
  if (value.trim() === '') {
    if (fieldSpec.required) {
      throw new WorkbookDataError(`${place}: missing required value`);
    }

    return null;
  }

  if (fieldSpec.kind === 'boolean') {
    const parsed = booleanSchema.safeParse(value);
    if (!parsed.success) {
      throw new WorkbookDataError(
        `${place}: invalid boolean ${JSON.stringify(value)}`,
        { cause: parsed.error },
      );
    }

    return parsed.data;
  }

  // The snapshot import's id rule; uniqueness is the row reader's check.
  if (fieldSpec.kind === 'id') {
    if (!isPositiveId(value)) {
      throw new WorkbookDataError(`${place}: not a positive id`);
    }

    return Number(value);
  }

  if (fieldSpec.kind === 'integer') {
    const parsed = integerSchema.safeParse(value);
    if (!parsed.success) {
      throw new WorkbookDataError(
        `${place}: invalid integer ${JSON.stringify(value)}`,
        { cause: parsed.error },
      );
    }

    return parsed.data;
  }

  return value;
};

export const getWorksheet = (
  workbook: ExcelJS.Workbook,
  sheet: string,
): ExcelJS.Worksheet => {
  const worksheet = workbook.getWorksheet(sheet);
  if (worksheet === undefined) {
    throw new WorkbookDataError(
      `workbook: missing worksheet ${JSON.stringify(sheet)}`,
    );
  }

  return worksheet;
};
