import { z } from 'zod';

import type { WorkbookData, WorkbookKey } from '../schema.js';

const id = z.number().int();
const text = z.string().nullable();
const integer = z.number().int().nullable();
const flag = z.boolean().nullable();

// The workbook columns the up-front check decides on: the labels that
// drive every lookup, the overrides that take precedence over them, and
// the values a planner moves into another shape. Every row carries its
// ordinal as its id (1 for the first row read), so a finding names it by
// sheet and row. The columns copied as they are (every staff, room,
// student, Discord, dean's office and Moodle user column, and the course
// name, tags and professors override) are read from the workbook data
// directly (plan-content.ts).
const courseRow = z.object({
  available_2018: flag,
  available_2023: flag,
  credits_2018: integer,
  credits_2023: integer,
  id,
  name: text,
  name_2018_override: text,
  name_2023: text,
});
const staffRow = z.object({ id, name: text });
const studentRow = z.object({ id, index_number: text });
const curriculumBase = {
  catalog_order: integer,
  channel: flag,
  code: text,
  id,
  level: integer,
  name: text,
  prerequisites: text,
  semester: integer,
  state_imb: text,
  state_ki: text,
  state_kn: text,
  state_pit: text,
  state_seis: text,
  state_siis: text,
  url: text,
};
const curriculum2023Row = z.object({
  ...curriculumBase,
  state_ie: text,
  state_ssp: text,
});
const curriculum2018Row = z.object({
  ...curriculumBase,
  state_ke: text,
});
const equivalencyRow = z.object({
  course_2013: text,
  course_2018: text,
  course_2023: text,
  id,
});
const assignmentRow = z.object({
  assistants: text,
  course_name: text,
  id,
  professors: text,
});
const patternRow = z.object({
  academic_year: text,
  course_name: text,
  id,
  pattern: text,
});
const councilRow = z.object({
  id,
  index_number: text,
  position: text,
  year: integer,
});
const deansRow = z.object({
  id,
  name: text,
  position: text,
  year: integer,
});

export type CourseRow = z.infer<typeof courseRow>;
export type EquivalencyRow = z.infer<typeof equivalencyRow>;
export type AssignmentRow = z.infer<typeof assignmentRow>;
export type PatternRow = z.infer<typeof patternRow>;
type CouncilRow = z.infer<typeof councilRow>;

export type WorkbookRows = {
  readonly course_enrollment_patterns: readonly PatternRow[];
  readonly course_equivalencies: readonly EquivalencyRow[];
  readonly courses: readonly CourseRow[];
  readonly curriculum_2018: ReadonlyArray<z.infer<typeof curriculum2018Row>>;
  readonly curriculum_2023: ReadonlyArray<z.infer<typeof curriculum2023Row>>;
  readonly deans_office: ReadonlyArray<z.infer<typeof deansRow>>;
  readonly staff: ReadonlyArray<z.infer<typeof staffRow>>;
  readonly student_council: readonly CouncilRow[];
  readonly students: ReadonlyArray<z.infer<typeof studentRow>>;
  readonly teaching_assignments: readonly AssignmentRow[];
};

// The rows of the parsed workbook the check reads, numbered in reading
// order.
export const workbookRows = (data: WorkbookData): WorkbookRows => {
  const rows = <S extends z.ZodType>(key: WorkbookKey, schema: S) =>
    data[key].map((item, index): z.output<S> =>
      schema.parse({ ...item, id: index + 1 }),
    );
  return {
    course_enrollment_patterns: rows('course_enrollment_patterns', patternRow),
    course_equivalencies: rows('course_equivalencies', equivalencyRow),
    courses: rows('courses', courseRow),
    curriculum_2018: rows('curriculum_2018', curriculum2018Row),
    curriculum_2023: rows('curriculum_2023', curriculum2023Row),
    deans_office: rows('deans_office', deansRow),
    staff: rows('staff', staffRow),
    student_council: rows('student_council', councilRow),
    students: rows('students', studentRow),
    teaching_assignments: rows('teaching_assignments', assignmentRow),
  };
};
