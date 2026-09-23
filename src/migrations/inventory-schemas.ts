import { z } from 'zod';

const id = z.number().int();
const text = z.string().nullable();
const integer = z.number().int().nullable();
const flag = z.boolean().nullable();
const idText = z.union([z.string(), z.number().int()]).transform(String);

// The exact checkpoint columns the preflight reads: the labels that drive
// every lookup, the overrides that take precedence over them, and every
// value column a converter copies into the relational model, so an edit to
// any of them changes the source fingerprint. The raw Moodle histories are
// read for the fingerprint and the legacy-regex-to-mapping proposal
// (follow-up 14) and never written to the report; emails, names of
// students and Moodle profiles are never requested.
export const courseRow = z.object({
  available_2018: flag,
  available_2023: flag,
  credits_2018: integer,
  credits_2023: integer,
  id,
  name: text,
  name_2018_override: text,
  name_2023: text,
  professors_override: text,
});
export const staffRow = z.object({ id, name: text });
export const idRow = z.object({ id });
// A workbook row without a history is written without the column, which
// the database stores as NULL.
export const moodleUserRow = z.object({ Courses: text.default(null), id });
export const studentRow = z.object({ id, index_number: text });
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
export const curriculum2023Row = z.object({
  ...curriculumBase,
  state_ie: text,
  state_ssp: text,
});
export const curriculum2018Row = z.object({
  ...curriculumBase,
  state_ke: text,
});
export const equivalencyRow = z.object({
  course_2013: text,
  course_2018: text,
  course_2023: text,
  id,
});
export const assignmentRow = z.object({
  assistants: text,
  course_name: text,
  id,
  professors: text,
});
// Once the relational model is installed, the role-bearing rows the
// migration adds beside the original text rows carry their provenance in
// `source_collection`; the inventory reads it to keep them out of the
// checkpoint view (and out of the source fingerprint).
export const provenancedAssignmentRow = assignmentRow.extend({
  source_collection: text,
});
export const patternRow = z.object({
  academic_year: text,
  course_name: text,
  id,
  pattern: text,
});
export const discordRow = z.object({ channel: text, course_names: text, id });
export const councilRow = z.object({
  id,
  index_number: text,
  position: text,
  year: integer,
});
export const deansRow = z.object({
  id,
  name: text,
  position: text,
  year: integer,
});
export const flowRow = z.object({
  id: idText,
  name: z.string(),
  operation: idText.nullable(),
  status: z.string(),
  trigger: z.string().nullable(),
});
export const operationRow = z.object({
  flow: idText.nullable(),
  id: idText,
  key: z.string(),
  options: z.json().nullable(),
  reject: idText.nullable(),
  resolve: idText.nullable(),
  type: z.string(),
});
export const entryRow = z.object({
  generation: text,
  id,
  source_collection: text,
  source_id: integer,
});
export const courseCurriculumRow = z.object({
  course: integer,
  entry: integer,
  generation: text,
  id,
});
export const ruleRow = z.object({
  academic_year: integer,
  course: integer,
  id,
  source_collection: text,
  source_id: integer,
});
export const academicYearRow = z.object({ id, label: text });

export type CourseRow = z.infer<typeof courseRow>;
export type EquivalencyRow = z.infer<typeof equivalencyRow>;
export type AssignmentRow = z.infer<typeof assignmentRow>;
export type PatternRow = z.infer<typeof patternRow>;
export type CouncilRow = z.infer<typeof councilRow>;
export type FlowRow = z.infer<typeof flowRow>;
export type OperationRow = z.infer<typeof operationRow>;
