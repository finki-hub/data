import type { LabelIndex } from './labels.js';

import {
  type AssignmentRole,
  type CourseStatus,
  labelSeparator,
  teachingTexts,
} from '../../directus/extensions/directus-extension-data-operations/src/exports/teaching-values.js';

// How a course's two teaching cells, professors and assistants, become its
// status and its staff links. A cell is read exactly as written: no
// trimming, no other separator, no fuzzy name. Pure.

export type TeachingFindingCode =
  | 'ambiguous_staff_name'
  | 'inactive_course_assistants'
  | 'repeated_staff_name'
  | 'unmatched_staff_name';

// One case of one cell, never a value: the cell by its role, the lines of
// the case (1 for the first line; empty when the case is the whole cell)
// and, for an ambiguous name, the staff rows in contention (ascending).
export type TeachingFinding = {
  readonly code: TeachingFindingCode;
  readonly lines: readonly number[];
  readonly role: AssignmentRole;
  readonly staff: readonly number[];
};

// A staff row linked in a role, with the cell line that names it.
export type TeachingLink = {
  readonly line: number;
  readonly role: AssignmentRole;
  readonly staff: number;
};

export type TeachingCells = {
  readonly findings: readonly TeachingFinding[];
  readonly links: readonly TeachingLink[];
  readonly status: CourseStatus;
};

type Cells = {
  readonly assistants: null | string;
  readonly professors: null | string;
};

type CellResult = Pick<TeachingCells, 'findings' | 'links'>;

const isEmpty = (cell: null | string): cell is '' | null =>
  cell === null || cell === '';

const none: CellResult = { findings: [], links: [] };

const inactiveAssistants: TeachingFinding = {
  code: 'inactive_course_assistants',
  lines: [],
  role: 'assistant',
  staff: [],
};

// Each line of a cell names one staff row by its exact name. A line naming
// exactly one row links it; a later line naming a row already linked is a
// repeat, linked once. A line naming no row or several links nothing. One
// finding per code and cell carries its lines.
const readCell = (
  role: AssignmentRole,
  cell: null | string,
  staffByName: LabelIndex,
): CellResult => {
  if (isEmpty(cell)) {
    return none;
  }
  const links: TeachingLink[] = [];
  const linked = new Set<number>();
  const unmatched: number[] = [];
  const ambiguous: number[] = [];
  const contested = new Set<number>();
  const repeated: number[] = [];
  for (const [index, name] of cell.split(labelSeparator).entries()) {
    const line = index + 1;
    const matches = staffByName.get(name) ?? [];
    const [staff] = matches;
    if (staff === undefined) {
      unmatched.push(line);
    } else if (matches.length > 1) {
      ambiguous.push(line);
      for (const id of matches) {
        contested.add(id);
      }
    } else if (linked.has(staff)) {
      repeated.push(line);
    } else {
      linked.add(staff);
      links.push({ line, role, staff });
    }
  }
  const cases: ReadonlyArray<Omit<TeachingFinding, 'role'>> = [
    {
      code: 'ambiguous_staff_name',
      lines: ambiguous,
      staff: [...contested].toSorted((left, right) => left - right),
    },
    { code: 'repeated_staff_name', lines: repeated, staff: [] },
    { code: 'unmatched_staff_name', lines: unmatched, staff: [] },
  ];
  return {
    findings: cases
      .filter(({ lines }) => lines.length > 0)
      .map((item) => ({ ...item, role })),
    links,
  };
};

// The status is the professors cell when it is exactly one of the status
// texts, else Active. An Inactive course links nobody, and its assistants
// cell must be empty or the Inactive text. All professors links its
// assistants only. Active links its professors, then its assistants, each
// in cell order.
export const teachingCells = (
  { assistants, professors }: Cells,
  staffByName: LabelIndex,
): TeachingCells => {
  if (professors === teachingTexts.inactive) {
    const allowed =
      isEmpty(assistants) || assistants === teachingTexts.inactive;
    return {
      findings: allowed ? [] : [inactiveAssistants],
      links: [],
      status: 'inactive',
    };
  }
  const status: CourseStatus =
    professors === teachingTexts.allProfessors ? 'all_professors' : 'active';
  const professorCell =
    status === 'active' ? readCell('professor', professors, staffByName) : none;
  const assistantCell = readCell('assistant', assistants, staffByName);
  return {
    findings: [...professorCell.findings, ...assistantCell.findings],
    links: [...professorCell.links, ...assistantCell.links],
    status,
  };
};
