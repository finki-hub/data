import type {
  AssignmentRow,
  EquivalencyRow,
  PatternRow,
  WorkbookRows,
} from './workbook-rows.js';

import { type CurriculumIndex, indexCurriculum } from './curriculum-labels.js';
import { indexLabels, type LabelIndex, nonEmpty } from './labels.js';

export type Indexes = {
  readonly assignmentRows: ReadonlyMap<number, AssignmentRow>;
  readonly assignments: LabelIndex;
  readonly courses: LabelIndex;
  readonly current: CurriculumIndex;
  readonly equivalencies: LabelIndex;
  readonly equivalencyRows: ReadonlyMap<number, EquivalencyRow>;
  readonly legacy: CurriculumIndex;
  readonly patterns: ReadonlyMap<string, readonly PatternRow[]>;
  readonly staff: LabelIndex;
  readonly students: LabelIndex;
};

export const patternKey = (course: string, year: string): string =>
  `${course}\u{0}${year}`;

// Every label lookup of the check, keyed by the exact label; the two
// curriculum sheets with the code of each row.
export const buildIndexes = (rows: WorkbookRows): Indexes => {
  const patterns = new Map<string, PatternRow[]>();
  for (const row of rows.course_enrollment_patterns) {
    const course = nonEmpty(row.course_name);
    const year = nonEmpty(row.academic_year);
    if (course === null || year === null) {
      continue;
    }
    const key = patternKey(course, year);
    patterns.set(key, [...(patterns.get(key) ?? []), row]);
  }
  return {
    assignmentRows: new Map(
      rows.teaching_assignments.map((row) => [row.id, row]),
    ),
    assignments: indexLabels(rows.teaching_assignments, (row) =>
      nonEmpty(row.course_name),
    ),
    courses: indexLabels(rows.courses, (row) => nonEmpty(row.name)),
    current: indexCurriculum(rows.curriculum_2023),
    equivalencies: indexLabels(rows.course_equivalencies, (row) =>
      nonEmpty(row.course_2023),
    ),
    equivalencyRows: new Map(
      rows.course_equivalencies.map((row) => [row.id, row]),
    ),
    legacy: indexCurriculum(rows.curriculum_2018),
    patterns,
    staff: indexLabels(rows.staff, (row) => nonEmpty(row.name)),
    students: indexLabels(rows.students, (row) => nonEmpty(row.index_number)),
  };
};
