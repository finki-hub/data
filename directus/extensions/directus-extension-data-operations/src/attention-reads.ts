import { z } from 'zod';

import type { SqlClient } from './coordination/sql-port.js';
import type { AttentionView } from './status-contract.js';

import { itemPage } from './managed-flows.js';

// The reads of the Needs attention section: data that is not linked up
// yet, each a bounded statement with bound values only.

// How many rows of each list the panel shows; the counts cover them all.
export const attentionListLimit = 25;

// An import whose last success is older than this has stopped: both run
// daily, so a day and two hours of slack.
export const staleAfterHours = 26;

// The first year of the current accreditations (2018 and 2023): an older
// Moodle course belongs to an earlier curriculum, which is not counted.
export const lookalikesFromYear = 2_018;

// Moodle courses of the current accreditations (their first year in the
// name is lookalikesFromYear or later) with at least 5 students that the
// last count counted for nothing, whose name starts with the name, English
// name or a Course Name of a course (the longest that matches, of 6
// letters or more), unless listed in Left Uncounted; the most recent
// first. The alert in deploy/alerts.py posts the new ones of every year.
// Bindings: lookalikesFromYear, the list limit.
const lookalikeSql = `WITH candidates AS (
  SELECT e.id, e.label, substring(e.label from '(20[0-9]{2})')::integer AS year
  FROM moodle_course_entries e
  WHERE substring(e.label from '(20[0-9]{2})')::integer >= ?
    AND NOT EXISTS (SELECT 1 FROM moodle_counted_lines l WHERE l.entry = e.id)
    AND NOT EXISTS (SELECT 1 FROM moodle_left_uncounted u WHERE u.entry = e.id)
),
sized AS (
  SELECT c.id, c.label, c.year FROM candidates c
  JOIN moodle_history_memberships m ON m.entry = c.id
  GROUP BY c.id, c.label, c.year
  HAVING COUNT(*) >= 5
),
names AS (
  SELECT id, lower(name) n FROM courses
  UNION SELECT id, lower(name_en) FROM courses WHERE name_en IS NOT NULL
  UNION SELECT course, lower(name) FROM course_aliases
)
SELECT s.id, s.label, c.name AS course, COUNT(*) OVER () AS total
FROM sized s
JOIN LATERAL (
  SELECT names.id FROM names
  WHERE length(names.n) >= 6
    AND starts_with(lower(regexp_replace(s.label, '\\s+', ' ', 'g')), names.n)
  ORDER BY length(names.n) DESC LIMIT 1
) best ON TRUE
JOIN courses c ON c.id = best.id
ORDER BY s.year DESC, s.label
LIMIT ?`;

// The subjects, teachers and rooms of the recent timetables (the ones
// courses.json reads) that match no course, staff member or room, each
// with its first lesson or slot. Bindings: the list limit.
const unmatchedSql = `SELECT kind, name, collection, MIN(id) AS id, COUNT(*) OVER () AS total
FROM (
  SELECT 'subject' AS kind, l.subject AS name, 'timetable_lessons' AS collection, l.id
  FROM timetable_lessons l JOIN timetables t ON t.id = l.timetable
  WHERE t.recent AND l.course_match = 'unmatched'
  UNION ALL
  SELECT 'teacher', l.teacher, 'timetable_lessons', l.id
  FROM timetable_lessons l JOIN timetables t ON t.id = l.timetable
  WHERE t.recent AND l.teacher_match = 'unmatched'
  UNION ALL
  SELECT 'room', s.classroom, 'timetable_slots', s.id
  FROM timetable_slots s JOIN timetables t ON t.id = s.timetable
  WHERE t.recent AND s.room_match = 'unmatched'
) names
WHERE name IS NOT NULL
GROUP BY kind, name, collection
ORDER BY kind, name
LIMIT ?`;

const iso = (column: string): string =>
  `to_char(MAX(${column}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// The last success of each daily import and whether it is overdue.
// Bindings: staleAfterHours, twice.
const staleSql = `SELECT 'Timetables' AS name, 'Data / Import timetables' AS flow,
  ${iso('checked_at')} AS last_at,
  COALESCE(MAX(checked_at) < NOW() - make_interval(hours => ?), TRUE) AS stale
FROM timetables
UNION ALL
SELECT 'Theses', 'Data / Import theses', ${iso('imported_at')},
  COALESCE(MAX(imported_at) < NOW() - make_interval(hours => ?), TRUE)
FROM bachelor_theses`;

const resultRows = <Row extends z.ZodType>(row: Row) =>
  z.object({ rows: z.array(row) });

const id = z.union([z.number().int(), z.string()]);
const total = z.coerce.number().int().nonnegative();

const lookalikeRow = z.object({
  course: z.string(),
  id,
  label: z.string(),
  total,
});

const unmatchedRow = z.object({
  collection: z.string(),
  id,
  kind: z.enum(['room', 'subject', 'teacher']),
  name: z.string(),
  total,
});

const staleRow = z.object({
  flow: z.string(),
  last_at: z.string().nullable(),
  name: z.string(),
  stale: z.boolean(),
});

export const readAttention = async (
  sql: SqlClient,
  limit: number = attentionListLimit,
): Promise<AttentionView> => {
  const lookalikes = resultRows(lookalikeRow).parse(
    await sql.raw(lookalikeSql, [lookalikesFromYear, limit]),
  ).rows;
  const unmatched = resultRows(unmatchedRow).parse(
    await sql.raw(unmatchedSql, [limit]),
  ).rows;
  const imports = resultRows(staleRow).parse(
    await sql.raw(staleSql, [staleAfterHours, staleAfterHours]),
  ).rows;
  return {
    lookalikes: {
      count: lookalikes[0]?.total ?? 0,
      items: lookalikes.map((row) => ({
        course: row.course,
        label: row.label,
        link: itemPage('moodle_course_entries', row.id),
      })),
    },
    stale: imports
      .filter(({ stale }) => stale)
      .map((row) => ({ flow: row.flow, lastAt: row.last_at, name: row.name })),
    unmatched: {
      count: unmatched[0]?.total ?? 0,
      items: unmatched.map((row) => ({
        kind: row.kind,
        link: itemPage(row.collection, row.id),
        name: row.name,
      })),
    },
  };
};
