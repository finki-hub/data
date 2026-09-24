import ExcelJS from 'exceljs';

import type { ProgramSeed } from './migrations/generations.js';

import { collectionSpecs } from './model.js';
import {
  assertNever,
  type CollectionSpec,
  type MigrationData,
  type MigrationItem,
} from './schema.js';
import { academicYears } from './specs/public.js';
import {
  readCourseEnrollmentPatterns,
  readEnrollmentYears,
} from './workbook-enrollment-reader.js';
import { readDiscordPairs, readStudentPairs } from './workbook-pair-reader.js';
import { readStudyPrograms } from './workbook-program-reader.js';
import { readRows } from './workbook-row-reader.js';
import { WorkbookDataError } from './workbook-values.js';

// A Directus string column is varchar(255); integers are PostgreSQL int4.
const maxStringLength = 255;
const minInteger = -2_147_483_648;
const maxInteger = 2_147_483_647;

const readSource = (
  workbook: ExcelJS.Workbook,
  spec: CollectionSpec,
): readonly MigrationItem[] => {
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

// The source rows of every collection, read with the checkpoint readers
// (literal cells only where a formula would copy a derived value).
export const readMigrationData = (
  workbook: ExcelJS.Workbook,
): MigrationData => {
  const data: Record<keyof MigrationData, readonly MigrationItem[]> = {
    course_enrollment_patterns: [],
    course_equivalencies: [],
    courses: [],
    curriculum_2018: [],
    curriculum_2023: [],
    deans_office: [],
    discord_channels: [],
    moodle_users: [],
    rooms: [],
    staff: [],
    student_council: [],
    students: [],
    teaching_assignments: [],
  };

  for (const spec of collectionSpecs) {
    data[spec.key] = readSource(workbook, spec);
  }

  return data;
};

// What the one-time import reads from the workbook: the rows of every
// checkpoint collection, the academic years its enrollment sheet names, in
// sheet order, and the study programs its curriculum sheets head their
// program columns with.
export type WorkbookContent = {
  readonly academicYears: readonly string[];
  readonly data: MigrationData;
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
// its column group, so the groups must run newest first.
const assertChronological = (years: readonly string[]): void => {
  const malformed = years.filter((year) => !isYearLabel(year));
  if (malformed.length > 0) {
    throw new WorkbookDataError(
      `The enrollment sheet heads a column group with ${malformed.map((year) => JSON.stringify(year.slice(0, 40))).join(', ')}, which is not an academic year such as 2025/2026.`,
    );
  }
  for (const [index, year] of years.entries()) {
    const newer = years[index - 1];
    if (newer !== undefined && year >= newer) {
      throw new WorkbookDataError(
        `The enrollment sheet lists the academic year ${year} after ${newer}; order its column groups newest first, since each year sorts by its position.`,
      );
    }
  }
};

// The academic years of the enrollment sheet, newest first. Every year the
// checkpoint counts (its enrollment_* columns) must be among them, so no
// year disappears silently; a later year is one more column group, placed
// before the years it follows.
export const readAcademicYears = (
  workbook: ExcelJS.Workbook,
): readonly string[] => {
  const years = collectionSpecs.flatMap((spec) =>
    spec.source.kind === 'course-enrollment-patterns'
      ? readEnrollmentYears(workbook, spec.source)
      : [],
  );
  const missing = academicYears.filter((year) => !years.includes(year));
  if (missing.length > 0) {
    throw new WorkbookDataError(
      `The enrollment sheet names no column group for the academic year(s) ${missing.join(', ')}; every year the checkpoint counts must stay.`,
    );
  }
  assertChronological(years);
  return years;
};

export const readWorkbookContent = (
  workbook: ExcelJS.Workbook,
): WorkbookContent => ({
  academicYears: readAcademicYears(workbook),
  data: readMigrationData(workbook),
  studyPrograms: readStudyPrograms(workbook),
});

export const loadWorkbook = async (
  workbookPath: string,
): Promise<WorkbookContent> => {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(workbookPath);
  } catch (error) {
    throw new WorkbookDataError(
      `The workbook ${workbookPath} could not be read as an .xlsx file: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return readWorkbookContent(workbook);
};

export const countMigrationData = (
  data: MigrationData,
): Readonly<Record<keyof MigrationData, number>> => ({
  course_enrollment_patterns: data.course_enrollment_patterns.length,
  course_equivalencies: data.course_equivalencies.length,
  courses: data.courses.length,
  curriculum_2018: data.curriculum_2018.length,
  curriculum_2023: data.curriculum_2023.length,
  deans_office: data.deans_office.length,
  discord_channels: data.discord_channels.length,
  moodle_users: data.moodle_users.length,
  rooms: data.rooms.length,
  staff: data.staff.length,
  student_council: data.student_council.length,
  students: data.students.length,
  teaching_assignments: data.teaching_assignments.length,
});

// Characters as PostgreSQL counts them in a varchar: code points, so a
// surrogate pair is one character, not two UTF-16 units.
const characterCount = (value: string): number => {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    // The second half of a surrogate pair was counted with the first.
    const point = value.codePointAt(index) ?? 0;
    if (point < 0xdc_00 || point > 0xdf_ff) {
      count += 1;
    }
  }
  return count;
};

const unstorable = (
  kind: CollectionSpec['fields'][number]['kind'],
  value: unknown,
): null | string => {
  if (kind === 'string' && typeof value === 'string') {
    const length = characterCount(value);
    return length > maxStringLength
      ? `holds ${String(length)} characters, but the column stores at most ${String(maxStringLength)}`
      : null;
  }
  if (kind === 'integer' && typeof value === 'number') {
    return Number.isSafeInteger(value) &&
      value >= minInteger &&
      value <= maxInteger
      ? null
      : 'holds an integer outside the range of the column';
  }
  return null;
};

// Rejects a value the checkpoint columns cannot hold before anything is
// written: the database would refuse that row halfway through the import,
// after earlier batches were stored. The message names the collection,
// column and row position, never the value.
export const assertStorable = (data: MigrationData): void => {
  for (const spec of collectionSpecs) {
    const rows = data[spec.key].entries();
    for (const [index, item] of rows) {
      for (const field of spec.fields) {
        const problem = unstorable(field.kind, item[field.target]);
        if (problem !== null) {
          throw new WorkbookDataError(
            `${spec.key} row ${String(index + 1)} of the workbook: ${field.target} ${problem}. Correct the cell before importing.`,
          );
        }
      }
    }
  }
};
