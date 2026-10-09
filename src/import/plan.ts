import type { SheetCell } from '../workbook-values.js';
import type { WorkbookContent } from '../workbook.js';

import { planAcademicYears } from './academic-years.js';
import { planTeachingAssignments } from './assignments.js';
import { planCourseCurricula } from './course-links.js';
import { planCurriculumEntries, planProgramStates } from './curricula.js';
import { planEquivalencyMembers } from './equivalency-members.js';
import {
  detailed,
  type Finding,
  finding,
  isBlocker,
  isSkipped,
  isWarning,
  sortFindings,
} from './findings.js';
import { planGenerations, planPrograms } from './generations.js';
import { planPatternMappings } from './pattern-mappings.js';
import {
  contentRows,
  councilLinks,
  courseLinks,
  deanTerms,
  equivalencyLinks,
} from './plan-content.js';
import { type PlannedCollection } from './planned.js';
import { preflight } from './preflight.js';
import { type UnstorableValue, unstorableValues } from './storable.js';
import { workbookRows } from './workbook-rows.js';

// The workbook parts copied into a collection of the same name as they are.
const copiedParts = [
  'staff',
  'rooms',
  'students',
  'discord_channels',
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

// A formula pattern cell is not read, so its course and year fall back to
// the course's all-years mappings: a rule fix, placed by its cell.
const formulaCellFinding = (cell: SheetCell): Finding =>
  detailed(finding('formula_pattern_cell', 'course_enrollment_patterns', []), {
    cell,
  });

// Pure: the up-front check `npm run import` and `npm run import:dry-run`
// share, before anything reaches Directus, and the plan of the parsed
// workbook. The seeds come first, then the content rows, the courses with
// their status and Discord channel, the curriculum entries and their
// program states, the course links, the pattern mappings (proven against
// the Moodle histories here, src/import/pattern-mappings.ts), the teaching
// role rows, the equivalencies with their members, the council and the
// dean's office terms with their staff members.
export const planImport = ({
  academicYears,
  data,
  formulaPatternCells,
  studyPrograms,
}: WorkbookContent): ImportPlan => {
  const rows = workbookRows(data);
  const checked = preflight(rows, academicYears);
  const { candidates } = checked;
  const copied = copiedParts.map((part) => ({
    collection: part,
    rows: contentRows({ collection: part, source: part }, data[part]),
  }));
  const patterns = planPatternMappings({
    academicYears,
    candidates: candidates.courses,
    courses: rows.courses,
    users:
      copied.find(({ collection }) => collection === 'moodle_users')?.rows ??
      [],
  });
  const findings = sortFindings([
    ...checked.findings,
    ...formulaPatternCells.map(formulaCellFinding),
    ...patterns.findings,
  ]);
  const collections: readonly PlannedCollection[] = [
    { collection: 'academic_years', rows: planAcademicYears(academicYears) },
    { collection: 'curriculum_generations', rows: planGenerations() },
    { collection: 'study_programs', rows: planPrograms(studyPrograms) },
    ...copied,
    {
      collection: 'courses',
      rows: contentRows(
        { collection: 'courses', source: 'courses' },
        data.courses,
        courseLinks(candidates),
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
    { collection: 'moodle_pattern_mappings', rows: patterns.rows },
    {
      collection: 'teaching_assignments',
      rows: planTeachingAssignments(candidates.courses),
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
    {
      collection: 'deans_office',
      rows: deanTerms(data.deans_office, candidates.deans),
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
