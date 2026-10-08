import type { Resolver, Row, RowContext } from './types.js';

import { codeLevel } from './curriculum-code.js';
import { unresolved } from './errors.js';
import {
  type AssignmentRole,
  assignmentRoles,
  assistantsText,
  type CourseStatus,
  courseStatuses,
  professorsText,
} from './teaching-values.js';
import { idOf, pathValue, textOf } from './values.js';

// The resolvers of courses.json. Each one reads the course row and its
// related rows (read keys `curricula`, `assignments`, `enrollments` of
// courses.ts) and answers the public value, resolving relation values on
// read, so a renamed staff member or curriculum entry is published
// without any rebuild. A generation or a program is a key row of a
// published source, never a code constant.
// Anything they cannot resolve unambiguously is refused with ids only;
// nothing is guessed.

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
      `Course ${courseId(context)}: ${code} curriculum link names an entry of another generation or none`,
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

// The course's availability of a published generation: its link's
// `available`, or false without a link, so every course carries the key
// of every published generation.
export const availability = (context: RowContext, generation: Row): unknown =>
  curriculum('available')(context, generation) ?? false;

// The course's level of a published generation: the level its linked
// entry's code gives (codeLevel), null without a link, without a code or
// for a code that gives none.
export const level = (context: RowContext, generation: Row): unknown =>
  codeLevel(textOf(curriculum('entry.code')(context, generation)));

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

export const isRole = (value: unknown): value is AssignmentRole =>
  knownRoles.has(value);

const knownStatuses: ReadonlySet<unknown> = new Set(courseStatuses);

const isStatus = (value: unknown): value is CourseStatus =>
  knownStatuses.has(value);

// The course's status; a value outside the vocabulary is refused.
const statusOf = (context: RowContext): CourseStatus => {
  const status = context.row['status'];
  return isStatus(status)
    ? status
    : unresolved(`Course ${courseId(context)}: invalid status`);
};

// The staff names of the course's links of a role, in `sort` order
// (unsorted links last), then id. A link without a known role or without
// a staff name is refused.
const namesOf = (
  context: RowContext,
  role: AssignmentRole,
): readonly string[] => {
  const rows = relatedRows(context, 'assignments');
  const unknown = rows.find((row) => !isRole(row['role']));
  if (unknown !== undefined) {
    unresolved(
      `Assignment ${String(idOf(unknown['id']))} of course ${courseId(context)} has no role`,
    );
  }
  return rows
    .filter((row) => row['role'] === role)
    .toSorted(byPosition)
    .map(
      (row) =>
        textOf(pathValue(row, 'staff.name')) ??
        unresolved(
          `Assignment ${String(idOf(row['id']))} of course ${courseId(context)} has no staff name`,
        ),
    );
};

// professors: the text of All professors or Inactive, else the professor
// names; an Active course without one is refused (readiness blocks it
// first, course_without_professor). The links of a role the status
// replaces are not read.
export const professors: Resolver = (context) => {
  const status = statusOf(context);
  const names = status === 'active' ? namesOf(context, 'professor') : [];
  return (
    professorsText(status, names) ??
    unresolved(`Course ${courseId(context)}: professor missing`)
  );
};

// assistants: the Inactive text, else the assistant names; null without
// one, so the key is left out.
export const assistants: Resolver = (context) => {
  const status = statusOf(context);
  return assistantsText(
    status,
    status === 'inactive' ? [] : namesOf(context, 'assistant'),
  );
};

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
