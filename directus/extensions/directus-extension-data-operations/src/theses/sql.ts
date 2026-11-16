import { key, staffResolvedSql } from '../teaching/sql.js';
import { type ThesisTable, thesisTables } from './vocabulary.js';

// The statements of the thesis import and of the committee rebuild, per
// thesis table. Every one runs inside a transaction that opened the guard
// of the thesis writer (the thesis tables and their staff tables share
// it).

// The lock of the import and the rebuild, held to the end of the
// transaction: two rebuilds never clear and refill the staff tables at
// once.
export const thesisLockSql =
  "SELECT pg_advisory_xact_lock(hashtext('finki_hub.thesis_writer'))";

const quoted = (column: string): string => `"${column}"`;

// The theses carry no stable key, so every import replaces them all.
export const clearThesesSql = ({ table }: ThesisTable): string =>
  `DELETE FROM "${table}"`;

export const storedCountSql = ({ table }: ThesisTable): string =>
  `SELECT count(*)::integer AS "count" FROM "${table}"`;

export const clearCommitteeSql = ({ committee }: ThesisTable): string =>
  `DELETE FROM "${committee}"`;

// Binding: the theses as JSON (BachelorRow or MasterRow).
export const insertThesesSql = ({ fields, table }: ThesisTable): string => {
  const columns = fields.map(quoted).join(', ');
  const values = fields.map((field) => `r.${quoted(field)}`).join(', ');
  const types = fields.map((field) => `${quoted(field)} text`).join(', ');
  return `INSERT INTO "${table}" (${columns}, "imported_at")
SELECT ${values}, now()
FROM json_to_recordset(?::json) AS r(${types})`;
};

// Every name a thesis of the table gives a staff member, with its role.
const namesOf = ({ names, table }: ThesisTable): string => {
  const pairs = names
    .map(([role, column]) => `('${role}', t.${quoted(column)})`)
    .join(', ');
  return `SELECT t."id" AS "thesis", r."role", r."name"
  FROM "${table}" t
  CROSS JOIN LATERAL (VALUES ${pairs}) AS r("role", "name")
  WHERE r."name" IS NOT NULL`;
};

const thesisTeachersSql = `SELECT DISTINCT "name" AS "teacher", ${key('"name"')} AS "key" FROM thesis_names`;

const resolvedSql = (names: string): string => `thesis_names AS (
  ${names}
),
${staffResolvedSql(thesisTeachersSql)}`;

// Every staff member's role on each thesis of the table, matched by name
// and through staff_aliases as the timetables' teachers are.
export const insertCommitteeSql = (thesis: ThesisTable): string =>
  `WITH ${resolvedSql(namesOf(thesis))}
INSERT INTO "${thesis.committee}" ("thesis", "staff", "role")
SELECT DISTINCT n."thesis", s."staff", n."role"
FROM thesis_names n
JOIN teacher_staff s ON s."teacher" = n."name" AND s."staff" IS NOT NULL`;

// The names of either kind of thesis no staff member or alias stands for,
// most frequent first.
export const unmatchedNamesSql = `WITH ${resolvedSql(thesisTables.map(namesOf).join('\n  UNION ALL\n  '))}
SELECT n."name", count(*)::integer AS "theses"
FROM thesis_names n
WHERE NOT EXISTS (SELECT 1 FROM teacher_staff s WHERE s."teacher" = n."name")
GROUP BY n."name"
ORDER BY 2 DESC, 1`;
