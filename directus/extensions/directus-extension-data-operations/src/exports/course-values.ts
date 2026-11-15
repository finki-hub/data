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
// related rows (read keys `curricula`, `teaching`, `accreditation`,
// `assignments`, `enrollments` of courses.ts) and answers the public value, resolving relation values on
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

const isRole = (value: unknown): value is AssignmentRole =>
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

// The staff name of a related row; a row without one is refused.
const staffName = (context: RowContext, row: Row, source: string): string =>
  textOf(pathValue(row, 'staff.name')) ??
  unresolved(
    `${source} ${String(idOf(row['id']))} of course ${courseId(context)} has no staff name`,
  );

// The staff names of the course's hand-kept links of a role, in `sort`
// order (unsorted links last), then id. A link without a known role or
// without a staff name is refused.
const linkedNames = (
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
    .map((row) => staffName(context, row, 'Assignment'));
};

type Taught = { readonly latest: string; readonly periods: number };

const nameOrder = new Intl.Collator('mk');

// Newer first: ISO dates compare as text.
const newerFirst = (left: string, right: string): number =>
  Number(right > left) - Number(right < left);

type Teachers = {
  readonly assistants: readonly string[];
  readonly professors: readonly string[];
};

// Who taught the course in the published timetables (the six latest main
// ones, `teaching`): a professor in any of them is a professor, everyone
// else an assistant. Each list runs from the latest timetable a person
// taught the course in, then by their weekly periods in it, then by name.
// Undefined when no published timetable has the course.
const timetableTeachers = (context: RowContext): Teachers | undefined => {
  const rows = relatedRows(context, 'teaching');
  if (rows.length === 0) {
    return undefined;
  }
  const taught = new Map<string, Taught>();
  const professorNames = new Set<string>();
  for (const row of rows) {
    if (!isRole(row['role'])) {
      unresolved(
        `Teaching ${String(idOf(row['id']))} of course ${courseId(context)} has no role`,
      );
    }
    const name = staffName(context, row, 'Teaching');
    const date = textOf(pathValue(row, 'timetable.date_from')) ?? '';
    const periods = idOf(row['periods']) ?? 0;
    const known = taught.get(name);
    if (known === undefined || date > known.latest) {
      taught.set(name, { latest: date, periods });
    } else if (date === known.latest) {
      taught.set(name, { latest: date, periods: known.periods + periods });
    }
    if (row['role'] === 'professor') {
      professorNames.add(name);
    }
  }
  const ordered = taught
    .entries()
    .toArray()
    .toSorted(
      ([leftName, left], [rightName, right]) =>
        newerFirst(left.latest, right.latest) ||
        right.periods - left.periods ||
        nameOrder.compare(leftName, rightName),
    )
    .map(([name]) => name);
  return {
    assistants: ordered.filter((name) => !professorNames.has(name)),
    professors: ordered.filter((name) => professorNames.has(name)),
  };
};

const generationCode = (row: Row): string =>
  textOf(pathValue(row, 'generation.code')) ?? '';

// The course's accreditation teachers of its newest generation that has
// them, in `sort` order, as professors; the syllabus names no assistants.
// Undefined without any.
const accreditationTeachers = (context: RowContext): Teachers | undefined => {
  const rows = relatedRows(context, 'accreditation');
  const newest = rows.map(generationCode).toSorted(newerFirst).at(0);
  const current = rows.filter((row) => generationCode(row) === newest);
  return current.length === 0
    ? undefined
    : {
        assistants: [],
        professors: current
          .toSorted(byPosition)
          .map((row) => staffName(context, row, 'Accreditation teacher')),
      };
};

// The course's teaching staff of a role: from the published timetables,
// else from its accreditation, else from its hand-kept links of that role
// (only those are read, so a link of the other role never refuses it).
const teachersOf = (
  context: RowContext,
  role: AssignmentRole,
): readonly string[] => {
  const teachers = timetableTeachers(context) ?? accreditationTeachers(context);
  if (teachers === undefined) {
    return linkedNames(context, role);
  }
  return role === 'professor' ? teachers.professors : teachers.assistants;
};

// professors: the text of All professors or Inactive, else the professor
// names (teachersOf); an Active course without one is refused. The staff
// of a status that replaces them is not read.
export const professors: Resolver = (context) => {
  const status = statusOf(context);
  const names = status === 'active' ? teachersOf(context, 'professor') : [];
  return (
    professorsText(status, names) ??
    unresolved(`Course ${courseId(context)}: professor missing`)
  );
};

// assistants: the Inactive text, else the assistant names (teachersOf);
// null without one, so the key is left out.
export const assistants: Resolver = (context) => {
  const status = statusOf(context);
  return assistantsText(
    status,
    status === 'inactive' ? [] : teachersOf(context, 'assistant'),
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
