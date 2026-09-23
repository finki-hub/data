import type { Filter } from '@directus/types';

import type {
  ReadinessEntry,
  ReadinessSource,
  Severity,
} from './readiness-types.js';
import type { ReadinessCheck } from './types.js';

import { assignmentCheck } from './assignment-checks.js';
import { curriculumCheck, importedValuesCheck } from './curriculum-checks.js';
import {
  enrollmentCheck,
  mappingCheck,
  yearOrderCheck,
} from './enrollment-checks.js';
import { calculationDomains, notCurrentStates } from './readiness-facts.js';

// The readiness-check registry: every issue readiness reports, in answer
// order, declared once (a new check is one entry, with a check or an
// aggregate that counts it). `ready` is true exactly when every blocker
// counts zero; blockers hold back the files they gate, warnings nothing.

const status: ReadinessSource = { kind: 'status' };
const snapshot: ReadinessSource = { kind: 'snapshot' };

const counted = (filter: Filter): ReadinessSource => ({
  aggregate: 'count',
  field: 'id',
  filter,
  kind: 'count',
});

// Counted in code by a check; one check may count several codes.
const checkedBy = (check: ReadinessCheck): ReadinessSource => ({
  check,
  kind: 'check',
});

// A text column holding a non-empty value.
const filled = (field: string): Filter => ({
  _and: [{ [field]: { _nnull: true } }, { [field]: { _neq: '' } }],
});

// An entry of a severity and its gates. `generationScoped` is set only
// where the page's records carry a `generation` column to show and filter.
const declare =
  (severity: Severity, gates: readonly string[]) =>
  (
    entry: Omit<ReadinessEntry, 'gates' | 'generationScoped' | 'severity'> &
      Partial<Pick<ReadinessEntry, 'generationScoped'>>,
  ): ReadinessEntry => ({ gates, generationScoped: false, severity, ...entry });

// Every blocker today holds back courses.json, the file whose rows it reads.
const blocker = declare('blocker', ['courses.json']);
const warning = declare('warning', []);

const enrollments = checkedBy(enrollmentCheck);
const assignments = checkedBy(assignmentCheck);
const mappings = checkedBy(mappingCheck);

export const readinessRegistry: readonly ReadinessEntry[] = [
  ...calculationDomains.flatMap((domain) =>
    notCurrentStates.map((state) =>
      blocker({
        code: `${domain}_${state}`,
        description: `The ${domain.replace('_', ' ')} calculation is ${state}: the derived rows are not those of the current source revision. Data / Process pending runs it; Data / Mark pending retries a failure.`,
        page: 'data_operations',
        source: status,
      }),
    ),
  ),
  blocker({
    code: 'snapshot_import_running',
    description:
      'A Moodle snapshot import is staging, validating or promoting.',
    page: 'data_operations',
    source: snapshot,
  }),
  blocker({
    code: 'snapshot_import_failed',
    description:
      'The last Moodle snapshot import or promotion failed; import again.',
    page: 'data_operations',
    source: snapshot,
  }),
  warning({
    code: 'snapshot_staged',
    description: 'A staged Moodle snapshot waits for its promotion.',
    page: 'data_operations',
    source: snapshot,
  }),
  warning({
    code: 'active_snapshot_edited',
    description:
      'The active Moodle users were changed outside Data / Import Moodle snapshot; the next promotion replaces those changes.',
    page: 'data_operations',
    source: snapshot,
  }),
  warning({
    code: 'snapshot_never_promoted',
    description:
      'The Moodle users never came through a snapshot promotion, so edits to them cannot be detected.',
    page: 'data_operations',
    source: snapshot,
  }),
  blocker({
    code: 'conversion_incomplete',
    description:
      'A step of the one-time relational conversion is still running or failed; the relational rows are partial.',
    page: 'migration_ledger',
    source: counted({ status: { _neq: 'completed' } }),
  }),
  blocker({
    code: 'academic_year_unsorted',
    description:
      'A published academic year has no sort, so its key has no place among the newest-first year keys of courses.json. Give it a sort.',
    page: 'academic_years',
    source: counted({
      _and: [{ published: { _eq: true } }, { sort: { _null: true } }],
    }),
  }),
  blocker({
    code: 'academic_year_sort_shared',
    description:
      'Two published academic years share a sort, so their keys have no newest-first order in courses.json. Give each published year its own sort.',
    page: 'academic_years',
    source: checkedBy(yearOrderCheck),
  }),
  blocker({
    code: 'enrollment_count_missing',
    description:
      'A course has no count row for a published academic year; the count is never published as 0.',
    page: 'course_enrollments',
    source: enrollments,
  }),
  blocker({
    code: 'enrollment_rule_missing',
    description:
      'A course has no enrollment rule for a published academic year, so nothing counts it (Data / Add enrollment rules creates them).',
    page: 'course_enrollment_rules',
    source: enrollments,
  }),
  blocker({
    code: 'curriculum_link_unresolved',
    description:
      'An equivalency names a 2018 curriculum value of a course that has neither a 2018 link nor a 2018 name override.',
    page: 'course_equivalencies',
    source: checkedBy(curriculumCheck),
  }),
  warning({
    code: 'equivalency_without_course',
    description: 'An equivalency names no course: unused historical metadata.',
    page: 'course_equivalencies',
    source: counted({ course: { _null: true } }),
  }),
  warning({
    code: 'equivalency_entry_unresolved',
    description:
      'An equivalency carries a 2023 or 2018 label that is linked to no curriculum entry of that generation.',
    page: 'course_equivalencies',
    source: counted({
      _or: [
        { _and: [filled('course_2023'), { entry_2023: { _null: true } }] },
        { _and: [filled('course_2018'), { entry_2018: { _null: true } }] },
      ],
    }),
  }),
  blocker({
    code: 'curriculum_value_unlinked',
    description:
      'A course carries an imported curriculum name, credits or availability of a generation it has no course_curricula link of; link the entry or clear the value.',
    page: 'courses',
    source: checkedBy(importedValuesCheck),
  }),
  warning({
    code: 'assignment_order_ambiguous',
    description:
      'Two published assignment rows share a position; their ids order them.',
    page: 'teaching_assignments',
    source: assignments,
  }),
  warning({
    code: 'assignment_review_label',
    description:
      'A published assignment row shows a literal label without a staff member.',
    page: 'teaching_assignments',
    source: assignments,
  }),
  blocker({
    code: 'assignment_role_missing',
    description: 'An assignment row of a course has no known role.',
    page: 'teaching_assignments',
    source: assignments,
  }),
  blocker({
    code: 'assignment_source_duplicate',
    description:
      'A course publishes staff from two imported assignment rows; keep one.',
    page: 'teaching_assignments',
    source: assignments,
  }),
  blocker({
    code: 'assignment_unresolved',
    description:
      'A published assignment row has neither a staff member nor a label.',
    page: 'teaching_assignments',
    source: assignments,
  }),
  warning({
    code: 'council_member_unresolved',
    description: 'A student council membership is linked to no student record.',
    page: 'student_council',
    source: counted({ student: { _null: true } }),
  }),
  warning({
    code: 'entry_needs_mapping',
    description:
      'A Moodle history entry without a mapping still needs one (or to be ignored); administrative lines stay here too.',
    page: 'moodle_course_entries',
    review: {
      bookmark: 'Needs mapping',
      fields: ['label', 'review_reason'],
      filter: { review_state: { _eq: 'needs_mapping' } },
      icon: 'alt_route',
      sort: ['label'],
    },
    source: mappings,
  }),
  warning({
    code: 'mapped_entry_awaiting_review',
    description:
      'A Moodle history entry carries a mapping but is still marked needs_mapping.',
    page: 'moodle_course_entries',
    source: mappings,
  }),
  warning({
    code: 'mapping_without_rule',
    description:
      'A mapping names a course and academic year without an enrollment rule, so it is never counted (follow-up 36).',
    page: 'moodle_course_mappings',
    source: mappings,
  }),
];

// The registry entry of a code.
export const readinessEntry = (
  code: string,
  registry: readonly ReadinessEntry[] = readinessRegistry,
): ReadinessEntry | undefined => registry.find((entry) => entry.code === code);
