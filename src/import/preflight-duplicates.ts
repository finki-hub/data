import type { WorkbookRows } from './workbook-rows.js';

import { type Finding, finding } from './findings.js';
import { groupIds, nonEmpty } from './labels.js';

const roleKey = (
  year: null | number,
  who: null | string,
  position: null | string,
): string => `${String(year)}\u{0}${String(who)}\u{0}${String(position)}`;

// Rows no label lookup may choose among: students sharing an index,
// courses or staff sharing a name (warnings: every row is imported), and
// council or dean's office rows repeating one year, person and position
// (the second row would repeat a membership).
export const duplicateRows = (rows: WorkbookRows): readonly Finding[] => [
  ...groupIds(rows.students, (row) => nonEmpty(row.index_number)).map((ids) =>
    finding('duplicate_student_index', 'students', ids),
  ),
  ...groupIds(rows.courses, (row) => nonEmpty(row.name)).map((ids) =>
    finding('duplicate_course_name', 'courses', ids),
  ),
  ...groupIds(rows.staff, (row) => nonEmpty(row.name)).map((ids) =>
    finding('duplicate_staff_name', 'staff', ids),
  ),
  ...groupIds(rows.student_council, (row) =>
    roleKey(row.year, row.index_number, row.position),
  ).map((ids) => finding('duplicate_role_row', 'student_council', ids)),
  ...groupIds(rows.deans_office, (row) =>
    roleKey(row.year, row.name, row.position),
  ).map((ids) => finding('duplicate_role_row', 'deans_office', ids)),
];
