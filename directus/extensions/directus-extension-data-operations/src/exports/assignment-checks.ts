import type { IssueCounts, ReadinessCheck, Row } from './types.js';

import { isRole } from './course-values.js';
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
  // The imported assignment rows (source_id) per (course, role) list.
  readonly sources: Map<string, Set<unknown>>;
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
  const list = `${String(row['course'])}/${String(row['role'])}`;
  add(
    tally.positions,
    `${list}/${String(idOf(row['sort']))}`,
    (known = 0) => known + 1,
  );
  const source = row['source_id'];
  if (source !== null && source !== undefined) {
    add(tally.sources, list, (known = new Set()) => known.add(source));
  }
};

// The courses whose published list of one role merges two imported
// assignment rows: the checkpoint derivation published the first
// ascending row of a course only, the conversion kept every row, and which
// one holds the real relationship is for an editor to decide.
const mergedCourses = (tally: Tally): number =>
  new Set(
    [...tally.sources]
      .filter(([, sources]) => sources.size > 1)
      .map(([list]) => list.split('/', 1)[0]),
  ).size;

// The rows a course publishes: its assistants, and its professors unless
// a professors_override replaces them.
export const assignmentCheck: ReadinessCheck = {
  codes: {
    assignment_order_ambiguous: {
      collection: 'teaching_assignments',
      kind: 'warning',
    },
    assignment_review_label: {
      collection: 'teaching_assignments',
      kind: 'warning',
    },
    assignment_role_missing: {
      collection: 'teaching_assignments',
      kind: 'blocker',
    },
    assignment_source_duplicate: {
      collection: 'teaching_assignments',
      kind: 'blocker',
    },
    assignment_unresolved: {
      collection: 'teaching_assignments',
      kind: 'blocker',
    },
  },
  evaluate: (sources): IssueCounts => {
    const overridden = new Set(
      sourceRows(sources, 'courses')
        .filter((course) => textOf(course['professors_override']) !== null)
        .map(({ id }) => id),
    );
    const tally: Tally = {
      counts: { assignment_role_missing: 0 },
      positions: new Map(),
      sources: new Map(),
    };
    for (const row of sourceRows(sources, 'assignments')) {
      const role = row['role'];
      if (!isRole(role)) {
        count(tally, 'assignment_role_missing');
      } else if (role === 'assistant' || !overridden.has(row['course'])) {
        tallyRow(tally, row);
      }
    }
    return {
      ...tally.counts,
      assignment_order_ambiguous: tally.positions
        .values()
        .filter((rows) => rows > 1)
        .toArray().length,
      assignment_source_duplicate: mergedCourses(tally),
    };
  },
  reads: {
    assignments: {
      collection: 'teaching_assignments',
      fields: [
        'id',
        'course',
        'role',
        'sort',
        'staff',
        'display_override',
        'source_id',
      ],
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
