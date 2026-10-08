import ExcelJS from 'exceljs';

import { workbookGenerations } from '../src/import/generations.js';
import { workbookSpecs } from '../src/specs/workbook.js';
import { readGenerationColumns } from '../src/workbook-generation-reader.js';
import { WorkbookDataError } from '../src/workbook-values.js';

// Sheets of one label column per generation, as Еквиваленции lays them out,
// and what the generation-columns reader makes of them.

export const sheet = 'Еквиваленции';

export const equivalencySpec = () => {
  const spec = workbookSpecs.find(({ key }) => key === 'course_equivalencies');
  if (spec?.source.kind !== 'generation-columns') {
    throw new TypeError(
      'No generation-columns spec reads course_equivalencies',
    );
  }
  return { ...spec, source: spec.source };
};

export const headerOf = (code: string): string => `Предмет (${code})`;

// The headers the workbook generations give, newest first, as the sheet
// lays them out.
export const generationHeaders = workbookGenerations
  .toReversed()
  .map(({ code }) => headerOf(code));

// An Еквиваленции sheet of the given rows, the first its header row.
export const sheetOfRows = (
  rows: ReadonlyArray<ReadonlyArray<null | string>>,
): ExcelJS.Workbook => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(sheet);
  for (const row of rows) {
    worksheet.addRow([...row]);
  }
  return workbook;
};

// An Еквиваленции sheet headed by the given texts, one row per record.
export const sheetOf = (
  headers: readonly string[],
  records: ReadonlyArray<Readonly<Record<string, string>>> = [],
): ExcelJS.Workbook =>
  sheetOfRows([
    headers,
    ...records.map((record) => headers.map((header) => record[header] ?? null)),
  ]);

export const itemsOf = (workbook: ExcelJS.Workbook) => {
  const spec = equivalencySpec();
  return readGenerationColumns(workbook, spec, spec.source).map(
    ({ item }) => item,
  );
};

// What a read gives: its result, or the message of the workbook data error
// it fails with.
export const outcomeOf = <T>(read: () => T): string | T => {
  try {
    return read();
  } catch (error) {
    if (error instanceof WorkbookDataError) {
      return error.message;
    }
    throw error;
  }
};

// One label per generation column, named after its header.
export const labelled = (headers: readonly string[], row: number) =>
  Object.fromEntries(
    headers.map((header) => [header, `Label ${String(row)} ${header}`]),
  );

// A sheet with every generation column but the given generation's, one
// labelled row: what its column reads on that row, or the refusal.
export const readWithout = ({
  code,
  equivalencyColumn,
}: (typeof workbookGenerations)[number]) => {
  const headers = generationHeaders.filter(
    (header) => header !== headerOf(code),
  );
  return outcomeOf(() =>
    itemsOf(sheetOf(headers, [labelled(headers, 2)])).map(
      (item) => item[equivalencyColumn],
    ),
  );
};
