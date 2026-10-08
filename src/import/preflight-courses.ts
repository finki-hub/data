import type { CourseCandidate } from './candidates.js';
import type { Indexes } from './preflight-indexes.js';
import type { CourseRow, WorkbookRows } from './workbook-rows.js';

import { type Finding, finding } from './findings.js';
import { metacharacterPattern, nonEmpty } from './labels.js';
import { currentOf, legacyOf } from './preflight-course-links.js';
import { rulesOf } from './preflight-course-values.js';
import { teachingOf } from './preflight-teaching.js';

// A course without a name violates the required courses.name; a name with
// metacharacters matches its default pattern differently than it reads.
const nameFindings = (course: CourseRow, name: string): readonly Finding[] => {
  if (name === '') {
    return [finding('invalid_source_row', 'courses', [course.id])];
  }
  return metacharacterPattern.test(name)
    ? [finding('label_metacharacters', 'courses', [course.id])]
    : [];
};

type CourseContext = {
  readonly academicYears: readonly string[];
  readonly indexes: Indexes;
};

const candidateOf = (
  course: CourseRow,
  { academicYears, indexes }: CourseContext,
): {
  readonly candidate: CourseCandidate;
  readonly findings: readonly Finding[];
} => {
  const name = nonEmpty(course.name) ?? '';
  const current = currentOf(course, indexes);
  const legacy = legacyOf(course, name, indexes);
  const rules = rulesOf(course, { academicYears, indexes, name });
  const teaching = teachingOf(course, name, indexes);
  return {
    candidate: {
      current: current.value,
      id: course.id,
      legacy: legacy.value,
      rules: rules.value,
      teaching: teaching.value,
    },
    findings: [
      ...nameFindings(course, name),
      ...current.findings,
      ...legacy.findings,
      ...teaching.findings,
      ...rules.findings,
    ],
  };
};

// One candidate decision set per course: its 2023 and 2018 entry, its
// enrollment rule per academic year, each with its precedence recorded,
// and its teaching status and staff links.
export const courseCandidates = (
  rows: WorkbookRows,
  context: CourseContext,
): {
  readonly candidates: readonly CourseCandidate[];
  readonly findings: readonly Finding[];
} => {
  const results = rows.courses.map((course) => candidateOf(course, context));
  return {
    candidates: results.map(({ candidate }) => candidate),
    findings: results.flatMap(({ findings }) => findings),
  };
};
