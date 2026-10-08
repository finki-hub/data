import type { AssignmentRole } from '../../directus/extensions/directus-extension-data-operations/src/exports/teaching-values.js';
import type { TeachingCandidate } from './candidates.js';
import type { Part } from './preflight-course-links.js';
import type { Indexes } from './preflight-indexes.js';
import type { CourseRow } from './workbook-rows.js';

import { detailed, type Finding, finding, type PartRows } from './findings.js';
import { nonEmpty } from './labels.js';
import { teachingCells, type TeachingFinding } from './teaching-cells.js';

// Where a course's teaching comes from, and the fields of the row its two
// cells are read into: an export row with typed professors wins, with the
// assistants it shows; otherwise the course's first Наставен Кадар row.
const cellFields = {
  courses: { assistant: 'export_assistants', professor: 'typed_professors' },
  teaching_assignments: { assistant: 'assistants', professor: 'professors' },
} as const satisfies Readonly<
  Record<string, Readonly<Record<AssignmentRole, string>>>
>;

type Source = {
  readonly collection: keyof typeof cellFields;
  readonly id: number;
};

type Cells = {
  readonly assistants: null | string;
  readonly professors: null | string;
};

const noTeaching: TeachingCandidate = {
  links: [],
  source: null,
  status: 'active',
};

// The teaching rows of a course: every row naming it, the first one used,
// when no other course carries its name (a name several carry blocks each
// row as ambiguous, preflight-links.ts).
const rowsOf = (name: string, indexes: Indexes): readonly number[] =>
  indexes.courses.get(name)?.length === 1
    ? (indexes.assignments.get(name) ?? [])
    : [];

// One finding per case of a cell, on the row the cells come from, with the
// cell's field and lines, the course, and the staff rows in contention.
const findingOf =
  (course: number, { collection, id }: Source) =>
  ({ code, lines, role, staff }: TeachingFinding): Finding => {
    const related: PartRows[] = [{ collection: 'courses', ids: [course] }];
    if (staff.length > 0) {
      related.push({ collection: 'staff', ids: staff });
    }
    return detailed(finding(code, collection, [id]), {
      field: cellFields[collection][role],
      lines,
      related,
    });
  };

// The status and links two cells give, and their cases.
const read = (
  course: number,
  { cells, source }: { readonly cells: Cells; readonly source: Source },
  indexes: Indexes,
): Part<'teaching'> => {
  const { findings, links, status } = teachingCells(cells, indexes.staff);
  return {
    findings: findings.map(findingOf(course, source)),
    value: {
      links,
      source: { id: source.id, source: source.collection },
      status,
    },
  };
};

// A teaching row the course does not read, with the course and the row it
// uses instead, when it uses one.
const unread = (
  code: 'duplicate_assignment' | 'superseded_assignment',
  course: number,
  used?: number,
) => {
  const related: PartRows[] = [{ collection: 'courses', ids: [course] }];
  if (used !== undefined) {
    related.push({ collection: 'teaching_assignments', ids: [used] });
  }
  return (id: number): Finding =>
    detailed(finding(code, 'teaching_assignments', [id]), { related });
};

// The teaching of a course. An export row with typed professors wins: its
// typed professors and shown assistants are read, and every Наставен
// Кадар row of the course is skipped unread (superseded_assignment).
// Otherwise the first Наставен Кадар row of the course is read, and each
// later one is ignored unread with a warning, as the spreadsheet's
// VLOOKUP did (duplicate_assignment, a rule fix).
export const teachingOf = (
  course: CourseRow,
  name: string,
  indexes: Indexes,
): Part<'teaching'> => {
  const rows = rowsOf(name, indexes);
  if (nonEmpty(course.typed_professors) !== null) {
    const typed = read(
      course.id,
      {
        cells: {
          assistants: course.export_assistants,
          professors: course.typed_professors,
        },
        source: { collection: 'courses', id: course.id },
      },
      indexes,
    );
    return {
      findings: [
        ...typed.findings,
        ...rows.map(unread('superseded_assignment', course.id)),
      ],
      value: typed.value,
    };
  }
  const [used, ...later] = rows;
  const row = used === undefined ? undefined : indexes.assignmentRows.get(used);
  if (row === undefined) {
    return { findings: [], value: noTeaching };
  }
  const first = read(
    course.id,
    { cells: row, source: { collection: 'teaching_assignments', id: row.id } },
    indexes,
  );
  return {
    findings: [
      ...first.findings,
      ...later.map(unread('duplicate_assignment', course.id, row.id)),
    ],
    value: first.value,
  };
};
