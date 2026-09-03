import ExcelJS from 'exceljs';

import { collectionSpecs } from './model.js';
import {
  assertNever,
  type CollectionSpec,
  type MigrationData,
  type MigrationItem,
} from './schema.js';
import { readCourseEnrollmentPatterns } from './workbook-enrollment-reader.js';
import { readDiscordPairs, readStudentPairs } from './workbook-pair-reader.js';
import { readRows } from './workbook-row-reader.js';

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

export const loadMigrationData = async (
  workbookPath: string,
): Promise<MigrationData> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookPath);

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
