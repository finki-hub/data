import type {
  EquivalencyRow,
  PatternRow,
  WorkbookRows,
} from './workbook-rows.js';

import { indexLabels, type LabelIndex, nonEmpty } from './labels.js';

export type Indexes = {
  readonly assignments: LabelIndex;
  readonly courses: LabelIndex;
  readonly current: LabelIndex;
  readonly equivalencies: LabelIndex;
  readonly equivalencyRows: ReadonlyMap<number, EquivalencyRow>;
  readonly legacy: LabelIndex;
  readonly patterns: ReadonlyMap<string, readonly PatternRow[]>;
  readonly staff: LabelIndex;
  readonly students: LabelIndex;
};

export const patternKey = (course: string, year: string): string =>
  `${course}\u{0}${year}`;

// Every label lookup of the check, keyed by the exact label.
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
    assignments: indexLabels(rows.teaching_assignments, (row) =>
      nonEmpty(row.course_name),
    ),
    courses: indexLabels(rows.courses, (row) => nonEmpty(row.name)),
    current: indexLabels(rows.curriculum_2023, (row) => nonEmpty(row.name)),
    equivalencies: indexLabels(rows.course_equivalencies, (row) =>
      nonEmpty(row.course_2023),
    ),
    equivalencyRows: new Map(
      rows.course_equivalencies.map((row) => [row.id, row]),
    ),
    legacy: indexLabels(rows.curriculum_2018, (row) => nonEmpty(row.name)),
    patterns,
    staff: indexLabels(rows.staff, (row) => nonEmpty(row.name)),
    students: indexLabels(rows.students, (row) => nonEmpty(row.index_number)),
  };
};
