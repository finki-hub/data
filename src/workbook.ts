import ExcelJS from 'exceljs';

import type { ProgramSeed } from './import/generations.js';

import {
  assertNever,
  perWorkbookKey,
  type PlacedItem,
  type SheetRow,
  type WorkbookData,
  type WorkbookKey,
  type WorkbookSpec,
} from './schema.js';
import { workbookSpecs } from './specs/workbook.js';
import {
  readCourseEnrollmentPatterns,
  readEnrollmentYears,
  readFormulaPatternCells,
} from './workbook-enrollment-reader.js';
import { readGenerationColumns } from './workbook-generation-reader.js';
import { readDiscordPairs, readStudentPairs } from './workbook-pair-reader.js';
import { readStudyPrograms } from './workbook-program-reader.js';
import { readRows } from './workbook-row-reader.js';
import {
  type SheetCell,
  sheetPlace,
  WorkbookDataError,
} from './workbook-values.js';

const readSource = (
  workbook: ExcelJS.Workbook,
  spec: WorkbookSpec,
): readonly PlacedItem[] => {
  switch (spec.source.kind) {
    case 'course-enrollment-patterns':
      return readCourseEnrollmentPatterns(workbook, spec.source);
    case 'discord-pairs':
      return readDiscordPairs(workbook, spec.source);
    case 'generation-columns':
      return readGenerationColumns(workbook, spec, spec.source);
    case 'rows':
      return readRows(workbook, spec, spec.source);
    case 'student-pairs':
      return readStudentPairs(workbook, spec.source);
    default:
      return assertNever(spec.source);
  }
};

// The sheet and row of every row read, per part of the workbook, in the
// order of its rows.
export type WorkbookPlaces = Readonly<Record<WorkbookKey, readonly SheetRow[]>>;

// The rows of every part of the workbook (literal cells only where a
// formula would copy a calculated value), each with its sheet and row.
const readParts = (
  workbook: ExcelJS.Workbook,
): { readonly data: WorkbookData; readonly places: WorkbookPlaces } => {
  const read = new Map<WorkbookKey, readonly PlacedItem[]>(
    workbookSpecs.map((spec) => [spec.key, readSource(workbook, spec)]),
  );
  const partOf = (key: WorkbookKey) => read.get(key) ?? [];
  return {
    data: perWorkbookKey((key) => partOf(key).map(({ item }) => item)),
    places: perWorkbookKey((key) => partOf(key).map(({ place }) => place)),
  };
};

// What the one-time import reads from the workbook: the rows of every
// part with the sheet and row of each, the academic years its enrollment
// sheet names, in sheet order, the places of the enrollment sheet's
// pattern cells that hold a formula (not read; no value), and the study
// programs its curriculum sheets head their program columns with.
export type WorkbookContent = {
  readonly academicYears: readonly string[];
  readonly data: WorkbookData;
  readonly formulaPatternCells: readonly SheetCell[];
  readonly places: WorkbookPlaces;
  readonly studyPrograms: readonly ProgramSeed[];
};

// Refuses year groups out of order: the import reads the first column
// group as the newest workbook year (pattern-proof.ts), so the groups must
// run newest first. Names the first year out of that order.
const assertChronological = (sheet: string, years: readonly string[]): void => {
  for (const [index, year] of years.entries()) {
    const newer = years[index - 1];
    if (newer !== undefined && year >= newer) {
      throw new WorkbookDataError(
        `${sheetPlace(sheet, 1)}: academic year ${year} after ${newer} (column groups not newest first)`,
      );
    }
  }
};

// The academic years of the enrollment sheet, newest first: a later year
// is one more column group, placed before the years it follows.
const readAcademicYears = (workbook: ExcelJS.Workbook): readonly string[] =>
  workbookSpecs.flatMap((spec) => {
    if (spec.source.kind !== 'course-enrollment-patterns') {
      return [];
    }
    const years = readEnrollmentYears(workbook, spec.source);
    assertChronological(spec.source.sheet, years);
    return years;
  });

// The enrollment sheet's pattern cells that hold a formula.
const readFormulaCells = (workbook: ExcelJS.Workbook): readonly SheetCell[] =>
  workbookSpecs.flatMap((spec) =>
    spec.source.kind === 'course-enrollment-patterns'
      ? readFormulaPatternCells(workbook, spec.source)
      : [],
  );

export const readWorkbookContent = (
  workbook: ExcelJS.Workbook,
): WorkbookContent => ({
  academicYears: readAcademicYears(workbook),
  ...readParts(workbook),
  formulaPatternCells: readFormulaCells(workbook),
  studyPrograms: readStudyPrograms(workbook),
});

// Why ExcelJS could not read the file, without the path it repeats.
const readerCause = (workbookPath: string, error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replaceAll(`: ${workbookPath}`, '')
    .replaceAll(workbookPath, '');
};

export const loadWorkbook = async (
  workbookPath: string,
): Promise<WorkbookContent> => {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(workbookPath);
  } catch (error) {
    throw new WorkbookDataError(
      `workbook ${workbookPath}: not readable as .xlsx (${readerCause(workbookPath, error)})`,
      { cause: error },
    );
  }
  return readWorkbookContent(workbook);
};
