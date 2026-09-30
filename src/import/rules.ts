import type { CourseCandidate, RuleCandidate } from './candidates.js';

import { ruleMode } from '../../directus/extensions/directus-extension-data-operations/src/rule-modes.js';
import { compositeKey, planned, type PlannedRow, ref } from './planned.js';

// The academic years of the workbook (newest first), sorted
// chronologically (the oldest year sorts first) and published: the
// imported years are the ones courses.json carries.
export const planAcademicYears = (
  academicYears: readonly string[],
): readonly PlannedRow[] =>
  academicYears.map((label, index) =>
    planned(label, {
      label,
      published: true,
      sort: academicYears.length - index,
    }),
  );

// The mode every seeded rule gets, taken from its declaration
// (rule-modes.ts): a mode retired or renamed there fails to compile here
// instead of seeding rules the enrollments planner refuses.
const seededMode = ruleMode('legacy_regex').mode;

// Where the rule's pattern came from, in one form: `Import[ fallback]:
// <source>[, <detail>]`. The pattern itself is the rule's own field.
const reviewNote = (rule: RuleCandidate): string => {
  if (rule.source === 'default') {
    return 'Import fallback: default pattern (course name-academic year), stored literally; no workbook pattern';
  }
  return rule.overrides.length > 1
    ? `Import: workbook pattern, last of ${String(rule.overrides.length)} for this course and year`
    : 'Import: workbook pattern';
};

// One legacy_regex rule per course and academic year of the workbook: the
// pattern it names, or the default, recorded literally, with a note that
// says which.
export const planEnrollmentRules = (
  courses: readonly CourseCandidate[],
): readonly PlannedRow[] =>
  courses.flatMap((course) =>
    course.rules.map((rule) =>
      planned(
        compositeKey(course.id, rule.academicYear),
        {
          academic_year: ref('academic_years', rule.academicYear),
          course: ref('courses', course.id),
          mode: seededMode,
          pattern: rule.pattern,
          review_note: reviewNote(rule),
        },
        { id: course.id, source: 'courses' },
      ),
    ),
  );
