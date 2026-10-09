import { z } from 'zod';

import {
  countPairs,
  type Membership,
  resolveLines,
} from '../../directus/extensions/directus-extension-data-operations/src/enrollment-lines.js';
import { splitHistoryEntries } from '../../directus/extensions/directus-extension-data-operations/src/history-contract.js';
import { type MemoryRow, type MemoryStore, storedRow } from './memory-store.js';

// The enrollment counts of a memory store: the course_enrollments rows the
// export engine reads, one per course and published academic year.
export type ProjectedCounts = {
  // Whether the counts are derived from the Moodle histories, so the live
  // check compares the year keys of courses.json.
  readonly derived: boolean;
  readonly rows: readonly MemoryRow[];
};

const yearRow = z.object({
  id: z.number(),
  label: z.string(),
  published: z.boolean().nullable(),
});

const mappingRow = z.object({
  course: z.number(),
  id: z.number(),
  only_in_year: z.number().nullable(),
  pattern: z.string(),
  year_pattern: z.string().nullable(),
});

const userRow = z.object({ Courses: z.string().nullable(), id: z.number() });

// Every distinct history line of the Moodle users, numbered from 1 in the
// order the lines first occur, and which user carries which line.
const historyIndex = (users: readonly MemoryRow[]) => {
  const histories = users.map((user) => {
    const { Courses, id } = userRow.parse(user);
    return { id, labels: splitHistoryEntries(Courses) };
  });
  const labels = [...new Set(histories.flatMap((history) => history.labels))];
  const entries = new Map(labels.map((label, index) => [label, index + 1]));
  return {
    lines: labels.map((label, index) => ({ id: index + 1, label })),
    memberships: histories.flatMap(({ id, labels: carried }) =>
      carried.map((label): Membership => ({
        entry: entries.get(label) ?? 0,
        moodleUser: id,
      })),
    ),
  };
};

// The count seam of the projection: the store's pattern mappings resolved
// over the history lines of its Moodle users by the counting rules
// (resolveLines; the import plans no explicit mapping), then counted per
// course and published academic year (countPairs), as the enrollments run
// counts them. courses.json carries every year key, each from the one count
// row the engine requires.
export const projectedCounts = (store: MemoryStore): ProjectedCounts => {
  const rowsOf = (collection: string) => store.items.get(collection) ?? [];
  const years = rowsOf('academic_years').map((row) => yearRow.parse(row));
  const { lines, memberships } = historyIndex(rowsOf('moodle_users'));
  const counted = resolveLines({
    explicit: [],
    lines,
    mappings: rowsOf('moodle_pattern_mappings').map((row) => {
      const mapping = mappingRow.parse(row);
      return {
        course: mapping.course,
        id: mapping.id,
        onlyInYear: mapping.only_in_year,
        pattern: mapping.pattern,
        yearPattern: mapping.year_pattern,
      };
    }),
    years,
  });
  const counts = countPairs({
    counted,
    courses: rowsOf('courses').map(({ id }) => ({ id: Number(id) })),
    memberships,
    years: years.filter(({ published }) => published === true),
  });
  return {
    derived: true,
    rows: counts.map(({ academicYear, count, course }, index) =>
      storedRow(
        'course_enrollments',
        { academic_year: academicYear, count, course },
        index + 1,
      ),
    ),
  };
};
