import type { Filter } from '@directus/types';

import type { IssueCounts, ReadinessCheck, Row } from './types.js';

import { isRole } from './course-values.js';
import { assignmentRoles } from './teaching-values.js';
import { blank, filled } from './text-filters.js';
import { idOf, sourceRows, textOf } from './values.js';

// The assignment checks of courses.json, as native reads of ids, keys and
// a label's presence (never a name, a history or a profile) and counts per
// issue code. Blockers are what the projection would have to refuse or
// guess; warnings leave the file exact but deserve a look.

// What the published rows of every course and role hold so far.
type Tally = {
  readonly counts: Record<string, number>;
  // Rows per (course, role, sort) position.
  readonly positions: Map<string, number>;
};

const count = (tally: Tally, code: string): void => {
  tally.counts[code] = (tally.counts[code] ?? 0) + 1;
};

const add = <T>(map: Map<string, T>, key: string, value: (known?: T) => T) => {
  map.set(key, value(map.get(key)));
};

// One published assignment row: an unresolved label blocks, an imported
// label published as text is worth a review, two rows at one position
// have no order of their own (the id decides).
const tallyRow = (tally: Tally, row: Row): void => {
  const unlinked = row['staff'] === null || row['staff'] === undefined;
  if (unlinked) {
    count(
      tally,
      textOf(row['display_override']) === null
        ? 'assignment_unresolved'
        : 'assignment_review_label',
    );
  }
  add(
    tally.positions,
    `${String(row['course'])}/${String(row['role'])}/${String(idOf(row['sort']))}`,
    (known = 0) => known + 1,
  );
};

// The role whose rows a course's professors_override replaces; the rows
// of every other role are always published.
const overriddenRole: (typeof assignmentRoles)[number] = 'professor';

// The rows the checks below count, as plain filters for their Needs review
// views: a row of a course with a role outside the vocabulary, and the
// published rows (a known role, not replaced by the override) without a
// staff member, with or without a display label.
export const roleMissing: Filter = {
  _and: [
    { course: { _nnull: true } },
    {
      _or: [
        { role: { _null: true } },
        { role: { _nin: [...assignmentRoles] } },
      ],
    },
  ],
};

const publishedWithoutStaff = (label: Filter): Filter => ({
  _and: [
    { course: { _nnull: true } },
    { role: { _in: [...assignmentRoles] } },
    {
      _or: [
        { role: { _neq: overriddenRole } },
        blank('course.professors_override'),
      ],
    },
    { staff: { _null: true } },
    label,
  ],
});

export const unresolvedRow = publishedWithoutStaff(blank('display_override'));
export const labelOnlyRow = publishedWithoutStaff(filled('display_override'));

// The rows a course publishes: those of every role but the overridden
// one, and that role's rows unless the override replaces them.
export const assignmentCheck: ReadinessCheck = {
  evaluate: (sources): IssueCounts => {
    const overridden = new Set(
      sourceRows(sources, 'courses')
        .filter((course) => textOf(course['professors_override']) !== null)
        .map(({ id }) => id),
    );
    const tally: Tally = {
      counts: { assignment_role_missing: 0 },
      positions: new Map(),
    };
    for (const row of sourceRows(sources, 'assignments')) {
      const role = row['role'];
      if (!isRole(role)) {
        count(tally, 'assignment_role_missing');
      } else if (role !== overriddenRole || !overridden.has(row['course'])) {
        tallyRow(tally, row);
      }
    }
    return {
      ...tally.counts,
      assignment_order_ambiguous: tally.positions
        .values()
        .filter((rows) => rows > 1)
        .toArray().length,
    };
  },
  reads: {
    assignments: {
      collection: 'teaching_assignments',
      fields: ['id', 'course', 'role', 'sort', 'staff', 'display_override'],
      filter: { course: { _nnull: true } },
      sort: ['id'],
    },
    courses: {
      collection: 'courses',
      fields: ['id', 'professors_override'],
      sort: ['id'],
    },
  },
};

// An Active course publishes the names of its professor links, so it
// needs one with a staff member; the projection refuses it otherwise
// (EXPORT_UNRESOLVED). Counts the Active courses without one.
export const professorCheck: ReadinessCheck = {
  evaluate: (sources): IssueCounts => {
    const taught = new Set(
      sourceRows(sources, 'professors').map((row) => row['course']),
    );
    return {
      course_without_professor: sourceRows(sources, 'courses').filter(
        (course) => course['status'] === 'active' && !taught.has(course['id']),
      ).length,
    };
  },
  reads: {
    courses: {
      collection: 'courses',
      fields: ['id', 'status'],
      sort: ['id'],
    },
    professors: {
      collection: 'teaching_assignments',
      fields: ['id', 'course'],
      filter: {
        _and: [
          { course: { _nnull: true } },
          { role: { _eq: 'professor' } },
          { staff: { _nnull: true } },
        ],
      },
      sort: ['id'],
    },
  },
};
