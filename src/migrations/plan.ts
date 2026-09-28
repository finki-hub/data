import type { WorkbookContent } from '../workbook.js';

import { planTeachingAssignments } from './assignments.js';
import { planCourseCurricula } from './course-links.js';
import { planCurriculumEntries, planProgramStates } from './curricula.js';
import { planEquivalencyMembers } from './equivalency-members.js';
import { type Finding, isBlocker, isSkipped, isWarning } from './findings.js';
import { planGenerations, planPrograms } from './generations.js';
import { contentRows, councilLinks, equivalencyLinks } from './plan-content.js';
import { type PlannedCollection } from './planned.js';
import { preflight } from './preflight.js';
import { planAcademicYears, planEnrollmentRules } from './rules.js';
import { type UnstorableValue, unstorableValues } from './storable.js';
import { workbookRows } from './workbook-rows.js';

// The workbook parts copied into a collection of the same name as they are.
const copiedParts = [
  'staff',
  'rooms',
  'students',
  'discord_channels',
  'deans_office',
  'moodle_users',
] as const;

// What the one-time import would do with a workbook: every relational row
// it writes, in dependency order, and the findings of the up-front check,
// split into the cases that refuse the import (`blockers`, and every
// planned value its column cannot hold, `unstorable`), the rows it skips
// and the warnings.
export type ImportPlan = {
  readonly blockers: readonly Finding[];
  readonly collections: readonly PlannedCollection[];
  readonly skipped: readonly Finding[];
  readonly unstorable: readonly UnstorableValue[];
  readonly warnings: readonly Finding[];
};

// Pure: the up-front check `npm run import` and `npm run import:dry-run`
// share, before anything reaches Directus, and the plan of the parsed
// workbook. The seeds come first, then the content rows, the courses, the
// curriculum entries and their program states, the course links, the
// enrollment rules, the teaching role rows, the equivalencies with their
// members and the council.
export const planImport = ({
  academicYears,
  data,
  studyPrograms,
}: WorkbookContent): ImportPlan => {
  const rows = workbookRows(data);
  const { candidates, findings } = preflight(rows, academicYears);
  const collections: readonly PlannedCollection[] = [
    { collection: 'academic_years', rows: planAcademicYears(academicYears) },
    { collection: 'curriculum_generations', rows: planGenerations() },
    { collection: 'study_programs', rows: planPrograms(studyPrograms) },
    ...copiedParts.map((part) => ({
      collection: part,
      rows: contentRows({ collection: part, source: part }, data[part]),
    })),
    {
      collection: 'courses',
      rows: contentRows(
        { collection: 'courses', source: 'courses' },
        data.courses,
      ),
    },
    { collection: 'curriculum_entries', rows: planCurriculumEntries(rows) },
    {
      collection: 'curriculum_entry_program_states',
      rows: planProgramStates(rows),
    },
    {
      collection: 'course_curricula',
      rows: planCourseCurricula(candidates.courses, rows.courses),
    },
    {
      collection: 'course_enrollment_rules',
      rows: planEnrollmentRules(candidates.courses),
    },
    {
      collection: 'teaching_assignments',
      rows: planTeachingAssignments(candidates.assignments),
    },
    {
      collection: 'course_equivalencies',
      rows: contentRows(
        { collection: 'course_equivalencies', source: 'course_equivalencies' },
        data.course_equivalencies,
        equivalencyLinks(candidates.equivalencies),
      ),
    },
    {
      collection: 'course_equivalency_members',
      rows: planEquivalencyMembers(
        rows.course_equivalencies,
        candidates.equivalencies,
      ),
    },
    {
      collection: 'student_council',
      rows: contentRows(
        { collection: 'student_council', source: 'student_council' },
        data.student_council,
        councilLinks(candidates.council),
      ),
    },
  ];
  return {
    blockers: findings.filter(isBlocker),
    collections,
    skipped: findings.filter(isSkipped),
    unstorable: unstorableValues(collections),
    warnings: findings.filter(isWarning),
  };
};
