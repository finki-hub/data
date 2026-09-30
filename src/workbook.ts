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
} from './workbook-enrollment-reader.js';
import { readDiscordPairs, readStudentPairs } from './workbook-pair-reader.js';
import { readStudyPrograms } from './workbook-program-reader.js';
import { readRows } from './workbook-row-reader.js';
import { sheetPlace, WorkbookDataError } from './workbook-values.js';

const readSource = (
  workbook: ExcelJS.Workbook,
  spec: WorkbookSpec,
): readonly PlacedItem[] => {
  switch (spec.source.kind) {
    case 'course-enrollment-patterns':
      return readCourseEnrollmentPatterns(workbook, spec.source);
    case 'discord-pairs':
      return readDiscordPairs(workbook, spec.source);
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
// sheet names, in sheet order, and the study programs its curriculum
// sheets head their program columns with.
export type WorkbookContent = {
  readonly academicYears: readonly string[];
  readonly data: WorkbookData;
  readonly places: WorkbookPlaces;
  readonly studyPrograms: readonly ProgramSeed[];
};

// An academic-year header: two consecutive calendar years, such as
// 2025/2026. Such labels order chronologically as text.
const yearLabelPattern = /^(?<start>\d{4})\/(?<end>\d{4})$/u;

const isYearLabel = (label: string): boolean => {
  const groups = yearLabelPattern.exec(label)?.groups;
  return Number(groups?.['end']) === Number(groups?.['start']) + 1;
};

// Refuses headers the import could not sort: the import sorts each year by
// its column group, so the groups must run newest first. Names the first
// such header of the sheet's header row.
const assertChronological = (sheet: string, years: readonly string[]): void => {
  const place = sheetPlace(sheet, 1);
  const malformed = years.find((year) => !isYearLabel(year));
  if (malformed !== undefined) {
    throw new WorkbookDataError(
      `${place}: column group header ${JSON.stringify(malformed.slice(0, 40))} not an academic year (YYYY/YYYY+1)`,
    );
  }
  for (const [index, year] of years.entries()) {
    const newer = years[index - 1];
    if (newer !== undefined && year >= newer) {
      throw new WorkbookDataError(
        `${place}: academic year ${year} after ${newer} (column groups not newest first)`,
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

export const readWorkbookContent = (
  workbook: ExcelJS.Workbook,
): WorkbookContent => ({
  academicYears: readAcademicYears(workbook),
  ...readParts(workbook),
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
