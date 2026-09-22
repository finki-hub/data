import type {
  AssignmentRow,
  EquivalencyRow,
  PatternRow,
} from './inventory-schemas.js';
import type { CheckpointRows } from './inventory.js';

import { indexLabels, type LabelIndex, nonEmpty } from './labels.js';

export type Indexes = {
  readonly assignmentRows: ReadonlyMap<number, AssignmentRow>;
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

const byId = <T extends { readonly id: number }>(
  rows: readonly T[],
): ReadonlyMap<number, T> => new Map(rows.map((row) => [row.id, row]));

// Every label lookup of the checkpoint derivation, keyed exactly as it was.
export const buildIndexes = (checkpoint: CheckpointRows): Indexes => {
  const patterns = new Map<string, PatternRow[]>();
  for (const row of checkpoint.course_enrollment_patterns) {
    const course = nonEmpty(row.course_name);
    const year = nonEmpty(row.academic_year);
    if (course === null || year === null) {
      continue;
    }
    const key = patternKey(course, year);
    patterns.set(key, [...(patterns.get(key) ?? []), row]);
  }
  return {
    assignmentRows: byId(checkpoint.teaching_assignments),
    assignments: indexLabels(checkpoint.teaching_assignments, (row) =>
      nonEmpty(row.course_name),
    ),
    courses: indexLabels(checkpoint.courses, (row) => nonEmpty(row.name)),
    current: indexLabels(checkpoint.curriculum_2023, (row) =>
      nonEmpty(row.name),
    ),
    equivalencies: indexLabels(checkpoint.course_equivalencies, (row) =>
      nonEmpty(row.course_2023),
    ),
    equivalencyRows: byId(checkpoint.course_equivalencies),
    legacy: indexLabels(checkpoint.curriculum_2018, (row) =>
      nonEmpty(row.name),
    ),
    patterns,
    staff: indexLabels(checkpoint.staff, (row) => nonEmpty(row.name)),
    students: indexLabels(checkpoint.students, (row) =>
      nonEmpty(row.index_number),
    ),
  };
};
