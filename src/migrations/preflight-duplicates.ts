import type { CheckpointRows } from './inventory.js';
import type { Finding } from './report.js';

import { finding, groupIds, listIds, nonEmpty } from './labels.js';

const roleKey = (
  year: null | number,
  who: null | string,
  position: null | string,
): string => `${String(year)}\u{0}${String(who)}\u{0}${String(position)}`;

const firstLabel = <T extends { readonly id: number }>(
  rows: readonly T[],
  ids: readonly number[],
  pick: (row: T) => null | string,
): null | string => {
  const row = rows.find((candidate) => candidate.id === ids[0]);
  return row === undefined ? null : nonEmpty(pick(row));
};

export const duplicateRows = (
  checkpoint: CheckpointRows,
): readonly Finding[] => [
  ...groupIds(checkpoint.students, (row) => nonEmpty(row.index_number)).map(
    (ids) =>
      finding('duplicate_student_index', {
        collection: 'students',
        ids,
        label: firstLabel(checkpoint.students, ids, (row) => row.index_number),
        message: `student rows ${listIds(ids)} share one index number; every row is retained and no merge is guessed.`,
      }),
  ),
  ...groupIds(checkpoint.courses, (row) => nonEmpty(row.name)).map((ids) =>
    finding('duplicate_course_name', {
      collection: 'courses',
      ids,
      label: firstLabel(checkpoint.courses, ids, (row) => row.name),
      message: `course rows ${listIds(ids)} share one name; label lookups against it are ambiguous.`,
    }),
  ),
  ...groupIds(checkpoint.staff, (row) => nonEmpty(row.name)).map((ids) =>
    finding('duplicate_staff_name', {
      collection: 'staff',
      ids,
      label: firstLabel(checkpoint.staff, ids, (row) => row.name),
      message: `staff rows ${listIds(ids)} share one name; an assignment text carrying it cannot be linked until the rows are told apart.`,
    }),
  ),
  ...groupIds(checkpoint.student_council, (row) =>
    roleKey(row.year, row.index_number, row.position),
  ).map((ids) =>
    finding('duplicate_role_row', {
      collection: 'student_council',
      ids,
      label: null,
      message: `council rows ${listIds(ids)} repeat the same year, index and position; remove or distinguish the duplicate before cutover.`,
    }),
  ),
  ...groupIds(checkpoint.deans_office, (row) =>
    roleKey(row.year, row.name, row.position),
  ).map((ids) =>
    finding('duplicate_role_row', {
      collection: 'deans_office',
      ids,
      label: null,
      message: `dean's office rows ${listIds(ids)} repeat the same year, name and position; remove or distinguish the duplicate before cutover.`,
    }),
  ),
];
