import type { CourseRow } from './inventory-schemas.js';
import type { CheckpointRows } from './inventory.js';
import type { Indexes } from './preflight-indexes.js';
import type { CourseCandidate, Finding } from './report.js';

import { finding, metacharacterPattern, nonEmpty, quote } from './labels.js';
import { currentOf, legacyOf } from './preflight-course-links.js';
import { assignmentOf, rulesOf } from './preflight-course-values.js';

const nameFindings = (course: CourseRow, name: string): readonly Finding[] => {
  if (name === '') {
    return [
      finding('invalid_source_row', {
        collection: 'courses',
        ids: [course.id],
        label: null,
        message: `course ${String(course.id)} has no name; the current derivation refuses such a row.`,
      }),
    ];
  }
  if (metacharacterPattern.test(name)) {
    return [
      finding('label_metacharacters', {
        collection: 'courses',
        ids: [course.id],
        label: name,
        message: `${quote(name)} contains regular-expression or LIKE metacharacters; its default enrollment pattern and any LIKE lookup read differently than the label. Review before cutover.`,
      }),
    ];
  }
  return [];
};

const candidateOf = (
  course: CourseRow,
  indexes: Indexes,
): {
  readonly candidate: CourseCandidate;
  readonly findings: readonly Finding[];
} => {
  const name = nonEmpty(course.name) ?? '';
  const current = currentOf(course, indexes);
  const legacy = legacyOf(course, name, indexes);
  const assignment = assignmentOf(name, indexes);
  const rules = rulesOf(course, name, indexes);
  return {
    candidate: {
      assignment: assignment.value,
      current: current.value,
      id: course.id,
      legacy: legacy.value,
      name,
      professorsOverride: nonEmpty(course.professors_override),
      rules: rules.value,
      staff: assignment.staff,
    },
    findings: [
      ...nameFindings(course, name),
      ...current.findings,
      ...legacy.findings,
      ...assignment.findings,
      ...rules.findings,
    ],
  };
};

// One candidate decision set per course: the current and legacy entry the
// checkpoint derivation would pick, the assignment and staff text, and the
// enrollment rule per academic year, each with its precedence recorded.
export const courseCandidates = (
  checkpoint: CheckpointRows,
  indexes: Indexes,
): {
  readonly candidates: readonly CourseCandidate[];
  readonly findings: readonly Finding[];
} => {
  const results = checkpoint.courses.map((course) =>
    candidateOf(course, indexes),
  );
  return {
    candidates: results.map(({ candidate }) => candidate),
    findings: results.flatMap(({ findings }) => findings),
  };
};
