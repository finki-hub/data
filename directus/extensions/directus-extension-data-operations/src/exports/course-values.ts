import type { Resolver, Row, RowContext } from './types.js';

import { unresolved } from './errors.js';
import { idOf, pathValue, textOf } from './values.js';

// The resolvers of courses.json. Each one reads the course row and its
// related rows (read keys `curricula`, `assignments`, `enrollments` of
// courses.ts) and answers the value the committed checkpoint file holds
// (test/fixtures/expected-exports), resolving relation values on read, so a renamed staff member or
// curriculum entry is published without any rebuild. A generation or a
// program is a key row of a published source, never a code constant.
// Anything they cannot resolve unambiguously is refused with ids only;
// nothing is guessed.

// Joins the labels of one course's professors or assistants. The
// conversion links an imported assignment text to staff rows only when
// this join gives the text back (`staffListSeparator` of src/migrations/
// preflight-staff.ts, pinned equal by a test).
export const labelSeparator = ', ';

export const assignmentRoles = ['professor', 'assistant'] as const;

type Role = (typeof assignmentRoles)[number];

const courseId = ({ row }: RowContext): string => String(idOf(row['id']));

const relatedRows = (context: RowContext, key: string): readonly Row[] =>
  context.related[key] ?? [];

const isRow = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The course's one link of a published generation (its key row), whose
// entry is of that generation, or undefined without a link.
const linkOf = (context: RowContext, generation: Row): Row | undefined => {
  const id = idOf(generation['id']);
  const code = String(generation['code']);
  const links = relatedRows(context, 'curricula').filter(
    (candidate) => idOf(candidate['generation']) === id,
  );
  if (links.length > 1) {
    unresolved(
      `Course ${courseId(context)} has ${links.length} ${code} curriculum links`,
    );
  }
  const [link] = links;
  if (link !== undefined && idOf(pathValue(link, 'entry.generation')) !== id) {
    unresolved(
      `Course ${courseId(context)} links a ${code} curriculum entry of another generation or none`,
    );
  }
  return link;
};

// A value of the course's link of a generation (`credits`, `available`)
// or of the linked entry (`entry.code`); null without a link.
export const curriculum =
  (path: string) =>
  (context: RowContext, generation: Row): unknown => {
    const link = linkOf(context, generation);
    return link === undefined ? null : pathValue(link, path);
  };

// The state of the course's linked entry of the generation in a published
// program: the entry's state row of that program, null without one (an
// absent row publishes like an empty cell: the key is omitted).
export const programState = (
  context: RowContext,
  generation: Row,
  program: Row,
): unknown => {
  const link = linkOf(context, generation);
  const states =
    link === undefined ? [] : pathValue(link, 'entry.program_states');
  const rows = (Array.isArray(states) ? states : []).filter(
    (state): state is Row =>
      isRow(state) && idOf(state['program']) === idOf(program['id']),
  );
  if (rows.length > 1) {
    unresolved(
      `Course ${courseId(context)} links an entry with ${rows.length} states of program ${String(idOf(program['id']))}`,
    );
  }
  return rows[0]?.['state'] ?? null;
};

// channel: true when a linked entry of any published generation (the only
// links courses.ts reads) has its channel set; the Discord channel list
// plays no part.
export const channel: Resolver = (context) =>
  relatedRows(context, 'curricula').some(
    (link) => pathValue(link, 'entry.channel') === true,
  );

const position = (row: Row): number => idOf(row['sort']) ?? Infinity;

const byPosition = (left: Row, right: Row): number =>
  position(left) - position(right) ||
  (idOf(left['id']) ?? 0) - (idOf(right['id']) ?? 0);

const knownRoles: ReadonlySet<unknown> = new Set(assignmentRoles);

export const isRole = (value: unknown): value is Role => knownRoles.has(value);

// The course's assignment rows of a role in `sort` order (unsorted rows
// last), then id; a row without a known role is refused.
const assigned = (context: RowContext, role: Role): readonly Row[] => {
  const rows = relatedRows(context, 'assignments');
  const unknown = rows.find((row) => !isRole(row['role']));
  if (unknown !== undefined) {
    unresolved(
      `Assignment ${String(idOf(unknown['id']))} of course ${courseId(context)} has no role`,
    );
  }
  return rows.filter((row) => row['role'] === role).toSorted(byPosition);
};

// Each row's display_override when set, else its staff member's name,
// joined in order; null without a row.
const labelsOf = (context: RowContext, role: Role): null | string => {
  const rows = assigned(context, role);
  if (rows.length === 0) {
    return null;
  }
  return rows
    .map(
      (row) =>
        textOf(row['display_override']) ??
        textOf(pathValue(row, 'staff.name')) ??
        unresolved(
          `Assignment ${String(idOf(row['id']))} of course ${courseId(context)} has no label`,
        ),
    )
    .join(labelSeparator);
};

// professors: the course's professors_override when set, else its
// professor assignments.
export const professors: Resolver = (context) =>
  textOf(context.row['professors_override']) ?? labelsOf(context, 'professor');

export const assistants: Resolver = (context) => labelsOf(context, 'assistant');

// The course's count of a published academic year (a key row of the
// published-year rule): exactly one count row must exist, a missing count
// is refused rather than published as 0.
export const enrollmentCount = (context: RowContext, year: Row): unknown => {
  const counts = relatedRows(context, 'enrollments').filter(
    (candidate) => candidate['academic_year'] === year['id'],
  );
  const [row] = counts;
  if (row === undefined || counts.length > 1) {
    unresolved(
      `Course ${courseId(context)} has ${counts.length} enrollment counts for ${String(year['label'])}`,
    );
  }
  return row?.['count'];
};
