import type { Filter } from '@directus/types';

import type {
  ReadinessEntry,
  ReadinessSource,
  Severity,
} from './readiness-types.js';
import type { ReadinessCheck } from './types.js';

import { assignmentCheck } from './assignment-checks.js';
import {
  curriculumCheck,
  importedValuesCheck,
  unlinkedMember,
} from './curriculum-checks.js';
import { enrollmentCheck, mappingCheck } from './enrollment-checks.js';
import { keyOrderEntries } from './key-order.js';
import { notCurrentCalculations } from './readiness-facts.js';
import {
  councilWithoutStudent,
  equivalencyWithoutCourse,
  reviewViews,
} from './review-views.js';

// The readiness-check registry: every issue readiness reports, in answer
// order, declared once (a new check is one entry, with a check or an
// aggregate that counts it). `ready` is true exactly when every blocker
// counts zero; blockers hold back the files they gate, warnings nothing.
// An entry with a `review` gets its Needs review bookmark from setup and
// the dashboard links it there (review-views.ts, key-order.ts); an entry
// whose records no plain filter can list (a missing row, a duplicate)
// links its page.

const status: ReadinessSource = { kind: 'status' };
const snapshot: ReadinessSource = { kind: 'snapshot' };

// The matching rows, or their distinct values of `distinct`.
const counted = (filter: Filter, distinct?: string): ReadinessSource => ({
  aggregate: distinct === undefined ? 'count' : 'countDistinct',
  field: distinct ?? 'id',
  filter,
  kind: 'count',
});

// Counted in code by a check; one check may count several codes.
const checkedBy = (check: ReadinessCheck): ReadinessSource => ({
  check,
  kind: 'check',
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
  ...notCurrentCalculations.map(({ domain, state }) =>
    blocker({
      code: `${domain}_${state}`,
      description: `The ${domain.replace('_', ' ')} calculation is ${state}: the derived rows are not those of the current source revision. Data / Process pending runs it; Data / Mark pending retries a failure.`,
      page: 'data_operations',
      source: status,
    }),
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
  // A published year, generation or program without its position, or
  // sharing one with a sibling (academic_year_unsorted,
  // academic_year_sort_shared and the like), from the key sources.
  ...keyOrderEntries,
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
      'An equivalency member of the 2018 generation names a curriculum value of a course that has no 2018 link; its view lists the members that name a course, beside the curriculum links of that course.',
    generationScoped: true,
    page: 'course_equivalency_members',
    review: reviewViews.curriculumLinksToCheck,
    source: checkedBy(curriculumCheck),
  }),
  warning({
    code: 'equivalency_without_course',
    description: 'An equivalency names no course: unused historical metadata.',
    page: 'course_equivalencies',
    review: reviewViews.equivalencyWithoutCourse,
    source: counted(equivalencyWithoutCourse),
  }),
  warning({
    code: 'equivalency_entry_unresolved',
    description:
      'An equivalency carries a member label of a generation with a curriculum that is linked to no curriculum entry of that generation (counted per equivalency).',
    generationScoped: true,
    page: 'course_equivalency_members',
    review: reviewViews.unlinkedMembers,
    source: counted(unlinkedMember, 'equivalency'),
  }),
  blocker({
    code: 'curriculum_value_unlinked',
    description:
      'A course carries an imported curriculum name, name override, credits or availability of a generation it has no course_curricula link of; link the entry (the imported columns are read-only).',
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
    review: reviewViews.assignmentLabelOnly,
    source: assignments,
  }),
  blocker({
    code: 'assignment_role_missing',
    description: 'An assignment row of a course has no known role.',
    page: 'teaching_assignments',
    review: reviewViews.assignmentRoleMissing,
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
    review: reviewViews.assignmentUnresolved,
    source: assignments,
  }),
  warning({
    code: 'council_member_unresolved',
    description: 'A student council membership is linked to no student record.',
    page: 'student_council',
    review: reviewViews.councilWithoutStudent,
    source: counted(councilWithoutStudent),
  }),
  warning({
    code: 'entry_needs_mapping',
    description:
      'A Moodle history entry without a mapping still needs one (or to be ignored); administrative lines stay here too.',
    page: 'moodle_course_entries',
    review: reviewViews.needsMapping,
    source: mappings,
  }),
  warning({
    code: 'mapped_entry_awaiting_review',
    description:
      'A Moodle history entry carries a mapping but is still marked needs_mapping.',
    page: 'moodle_course_entries',
    review: reviewViews.mappedAwaitingReview,
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
