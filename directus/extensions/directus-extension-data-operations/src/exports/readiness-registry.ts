import type { Filter } from '@directus/types';

import type {
  ReadinessEntry,
  ReadinessSource,
  Severity,
} from './readiness-types.js';
import type { ReadinessCheck } from './types.js';

import { domainLabel } from '../coordination/domains.js';
import { professorCheck } from './assignment-checks.js';
import { unlinkedMember } from './curriculum-checks.js';
import { enrollmentCheck } from './enrollment-checks.js';
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
// links its page. A description is the dashboard tooltip of the code: a
// short fact about the records it counts, without a trailing period; README
// ("Readiness and Needs review views") says what to do about each.

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

export const readinessRegistry: readonly ReadinessEntry[] = [
  ...notCurrentCalculations.map(({ domain, state }) =>
    blocker({
      code: `${domain}_${state}`,
      description: `${domainLabel(domain)} ${state}: derived rows behind the source revision`,
      page: 'data_operations',
      source: status,
    }),
  ),
  blocker({
    code: 'snapshot_import_running',
    description: 'A Moodle snapshot import is staging, validating or promoting',
    page: 'data_operations',
    source: snapshot,
  }),
  blocker({
    code: 'snapshot_import_failed',
    description: 'Last Moodle snapshot import or promotion failed',
    page: 'data_operations',
    source: snapshot,
  }),
  warning({
    code: 'snapshot_staged',
    description: 'A staged Moodle snapshot waits for its promotion',
    page: 'data_operations',
    source: snapshot,
  }),
  warning({
    code: 'active_snapshot_edited',
    description:
      'Active Moodle users edited outside Data / Import Moodle snapshot; next promotion overwrites them',
    page: 'data_operations',
    source: snapshot,
  }),
  warning({
    code: 'snapshot_never_promoted',
    description:
      'Moodle users never promoted from a snapshot; edit detection unavailable',
    page: 'data_operations',
    source: snapshot,
  }),
  // A published year, generation or program without its position, or
  // sharing one with a sibling (academic_year_unsorted,
  // academic_year_sort_shared and the like), from the key sources.
  ...keyOrderEntries,
  blocker({
    code: 'enrollment_count_missing',
    description: 'Course without a count row for a published academic year',
    page: 'course_enrollments',
    source: checkedBy(enrollmentCheck),
  }),
  warning({
    code: 'equivalency_without_course',
    description: 'Equivalency without a course',
    page: 'course_equivalencies',
    review: reviewViews.equivalencyWithoutCourse,
    source: counted(equivalencyWithoutCourse),
  }),
  warning({
    code: 'equivalency_entry_unresolved',
    description:
      'Equivalency member label without a curriculum entry of its generation (counted per equivalency)',
    generationScoped: true,
    page: 'course_equivalency_members',
    review: reviewViews.unlinkedMembers,
    source: counted(unlinkedMember, 'equivalency'),
  }),
  // No plain filter lists an Active course without a professor link (an
  // O2M `_none`), so the entry links the course page.
  blocker({
    code: 'course_without_professor',
    description: 'Active course without a professor',
    page: 'courses',
    source: checkedBy(professorCheck),
  }),
  warning({
    code: 'council_member_unresolved',
    description: 'A student council membership is linked to no student record',
    page: 'student_council',
    review: reviewViews.councilWithoutStudent,
    source: counted(councilWithoutStudent),
  }),
];
