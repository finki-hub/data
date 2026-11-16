import { key, staffResolvedSql } from '../teaching/sql.js';

// The statements of the thesis import and of the committee rebuild. Every
// one runs inside a transaction that opened the guard of the thesis writer
// (theses and thesis_committee share it).

// The lock of the import and the rebuild, held to the end of the
// transaction: two rebuilds never clear and refill thesis_committee at
// once.
export const thesisLockSql =
  "SELECT pg_advisory_xact_lock(hashtext('finki_hub.thesis_writer'))";

// The theses carry no stable key, so every import replaces them all.
export const clearThesesSql = 'DELETE FROM "theses"';

export const clearCommitteeSql = 'DELETE FROM "thesis_committee"';

// Binding: the theses as JSON (ThesisRow).
export const insertThesesSql = `INSERT INTO "theses" ("level", "title", "description", "student_index", "student_name", "status", "date", "file_id", "mentor", "president", "member_1", "member_2", "imported_at")
SELECT r."level", r."title", r."description", r."student_index", r."student_name", r."status", r."date", r."file_id", r."mentor", r."president", r."member_1", r."member_2", now()
FROM json_to_recordset(?::json) AS r("level" text, "title" text, "description" text, "student_index" text, "student_name" text, "status" text, "date" text, "file_id" text, "mentor" text, "president" text, "member_1" text, "member_2" text)`;

// Every name a thesis gives its mentor and committee, with its role.
const thesisNamesSql = `thesis_names AS (
  SELECT t."id" AS "thesis", r."role", r."name"
  FROM "theses" t
  CROSS JOIN LATERAL (VALUES ('mentor', t."mentor"), ('president', t."president"), ('member', t."member_1"), ('member', t."member_2")) AS r("role", "name")
  WHERE r."name" IS NOT NULL
)`;

const thesisTeachersSql = `SELECT DISTINCT "name" AS "teacher", ${key('"name"')} AS "key" FROM thesis_names`;

const resolvedSql = `${thesisNamesSql},
${staffResolvedSql(thesisTeachersSql)}`;

// Every staff member's role on each thesis, matched by name and through
// staff_aliases as the timetables' teachers are.
export const insertCommitteeSql = `WITH ${resolvedSql}
INSERT INTO "thesis_committee" ("thesis", "staff", "role")
SELECT DISTINCT n."thesis", s."staff", n."role"
FROM thesis_names n
JOIN teacher_staff s ON s."teacher" = n."name" AND s."staff" IS NOT NULL`;

// The names no staff member or alias stands for, most frequent first.
export const unmatchedNamesSql = `WITH ${resolvedSql}
SELECT n."name", count(*)::integer AS "theses"
FROM thesis_names n
WHERE NOT EXISTS (SELECT 1 FROM teacher_staff s WHERE s."teacher" = n."name")
GROUP BY n."name"
ORDER BY 2 DESC, 1`;
