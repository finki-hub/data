import {
  exerciseKinds,
  lectureKinds,
  professorPositions,
} from './vocabulary.js';

// The statements of the timetable import and of the course teaching
// rebuild. Every one runs inside a transaction that opened the guard of
// the timetable writer (timetables, timetable_lessons and course_teaching
// share it).

const literals = (values: readonly string[]): string =>
  values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', ');

// The key two names match by: lower case, inner whitespace collapsed.
const key = (expression: string): string =>
  String.raw`lower(regexp_replace(btrim(${expression}), '\s+', ' ', 'g'))`;

// Bindings: EduPage id, title, start date, academic year label, term,
// main, hidden. A timetable is never deleted: a former main timetable
// keeps its lessons and stops counting.
export const upsertTimetableSql = `INSERT INTO "timetables" ("edupage_id", "title", "date_from", "academic_year", "term", "main", "hidden")
VALUES (?, ?, ?, (SELECT "id" FROM "academic_years" WHERE "label" = ?), ?, ?, ?)
ON CONFLICT ("edupage_id") DO UPDATE SET "title" = EXCLUDED."title", "date_from" = EXCLUDED."date_from",
  "academic_year" = EXCLUDED."academic_year", "term" = EXCLUDED."term", "main" = EXCLUDED."main", "hidden" = EXCLUDED."hidden"
RETURNING "id"`;

export const fingerprintsSql =
  'SELECT "edupage_id", "fingerprint" FROM "timetables"';

// Binding: the timetable's id.
export const clearLessonsSql =
  'DELETE FROM "timetable_lessons" WHERE "timetable" = ?';

// Bindings: the timetable's id, its lessons as JSON. The match columns are
// set by the rebuild that follows in the same transaction.
export const insertLessonsSql = `INSERT INTO "timetable_lessons" ("timetable", "subject", "kind", "teacher", "periods", "course_match", "teacher_match")
SELECT ?, rows."subject", rows."kind", rows."teacher", rows."periods", 'unmatched', 'unmatched'
FROM json_to_recordset(?::json) AS rows("subject" text, "kind" text, "teacher" text, "periods" integer)`;

// Bindings: the fingerprint, the timetable's id.
export const fingerprintSql =
  'UPDATE "timetables" SET "fingerprint" = ?, "imported_at" = now() WHERE "id" = ?';

// The courses and staff every distinct subject and teacher of the lessons
// stands for. A course name matches by the course's name, then its
// English name, then the name of a curriculum entry linked to it; a staff
// name by the full name, then by the first name and one of two surnames
// on either side ("Александра Дединец" and "Александра Каневче Дединец"). A
// name that matches two courses or two staff members at its best rank
// matches neither.
// An alias decides its name outright, a row without a target ignores it.
// A combined slot "A / B" matches when each part does.
const resolvedSql = `course_names AS (
  SELECT ${key('c."name"')} AS "key", c."id" AS "course", 1 AS "rank" FROM "courses" c
  UNION ALL
  SELECT ${key('c."name_en"')}, c."id", 2 FROM "courses" c WHERE c."name_en" IS NOT NULL
  UNION ALL
  SELECT ${key('e."name"')}, l."course", 3 FROM "course_curricula" l JOIN "curriculum_entries" e ON e."id" = l."entry"
),
course_keys AS (
  SELECT n."key", min(n."course") AS "course"
  FROM (SELECT *, min("rank") OVER (PARTITION BY "key") AS "best" FROM course_names) n
  WHERE n."rank" = n."best"
  GROUP BY n."key" HAVING count(DISTINCT n."course") = 1
),
subjects AS (
  SELECT DISTINCT "subject", ${key('"subject"')} AS "key" FROM "timetable_lessons"
),
aliased_subjects AS (
  SELECT s."subject", a."course" FROM subjects s JOIN "course_aliases" a ON ${key('a."name"')} = s."key"
),
direct_subjects AS (
  SELECT s."subject", k."course" FROM subjects s JOIN course_keys k ON k."key" = s."key"
  WHERE NOT EXISTS (SELECT 1 FROM aliased_subjects a WHERE a."subject" = s."subject")
),
subject_parts AS (
  SELECT s."subject", k."course"
  FROM subjects s
  CROSS JOIN LATERAL unnest(string_to_array(s."subject", ' / ')) AS p("part")
  LEFT JOIN course_keys k ON k."key" = ${key('p."part"')}
  WHERE s."subject" LIKE '% / %'
    AND NOT EXISTS (SELECT 1 FROM aliased_subjects a WHERE a."subject" = s."subject")
    AND NOT EXISTS (SELECT 1 FROM direct_subjects d WHERE d."subject" = s."subject")
),
subject_courses AS (
  SELECT "subject", "course" FROM aliased_subjects
  UNION SELECT "subject", "course" FROM direct_subjects
  UNION SELECT "subject", "course" FROM subject_parts
  WHERE "subject" IN (SELECT "subject" FROM subject_parts GROUP BY "subject" HAVING bool_and("course" IS NOT NULL))
),
staff_words AS (
  SELECT s."id", string_to_array(${key('s."name"')}, ' ') AS "words" FROM "staff" s
),
staff_names AS (
  SELECT array_to_string("words", ' ') AS "key", "id" AS "staff", 0 AS "rank" FROM staff_words
  UNION ALL
  SELECT "words"[1] || ' ' || "words"[3], "id", 1 FROM staff_words WHERE cardinality("words") = 3
  UNION ALL
  SELECT "words"[1] || ' ' || "words"[2], "id", 1 FROM staff_words WHERE cardinality("words") = 3
),
teachers AS (
  SELECT DISTINCT "teacher", ${key('"teacher"')} AS "key" FROM "timetable_lessons"
),
teacher_names AS (
  SELECT "teacher", "key", 0 AS "rank" FROM teachers
  UNION ALL
  SELECT "teacher", w[1] || ' ' || w[3], 1 FROM teachers, string_to_array("key", ' ') AS w WHERE cardinality(w) = 3
  UNION ALL
  SELECT "teacher", w[1] || ' ' || w[2], 1 FROM teachers, string_to_array("key", ' ') AS w WHERE cardinality(w) = 3
),
teacher_candidates AS (
  SELECT t."teacher", n."staff", t."rank" + n."rank" AS "rank"
  FROM teacher_names t JOIN staff_names n ON n."key" = t."key"
),
teacher_keys AS (
  SELECT c."teacher", min(c."staff") AS "staff"
  FROM (SELECT *, min("rank") OVER (PARTITION BY "teacher") AS "best" FROM teacher_candidates) c
  WHERE c."rank" = c."best"
  GROUP BY c."teacher" HAVING count(DISTINCT c."staff") = 1
),
aliased_teachers AS (
  SELECT t."teacher", a."staff" FROM teachers t JOIN "staff_aliases" a ON ${key('a."name"')} = t."key"
),
teacher_staff AS (
  SELECT "teacher", "staff" FROM aliased_teachers
  UNION
  SELECT k."teacher", k."staff" FROM teacher_keys k
  WHERE NOT EXISTS (SELECT 1 FROM aliased_teachers a WHERE a."teacher" = k."teacher")
)`;

export const clearTeachingSql = 'DELETE FROM "course_teaching"';

// Every staff member's weekly periods of a course in each main timetable,
// by role: a lecture type makes them a professor, another type an
// assistant; without a type (before summer 2022/23) their position
// decides.
export const insertTeachingSql = `WITH ${resolvedSql}
INSERT INTO "course_teaching" ("course", "staff", "timetable", "role", "periods")
SELECT c."course", t."staff", l."timetable",
  CASE
    WHEN l."kind" IN (${literals(lectureKinds)}) THEN 'professor'
    WHEN l."kind" IN (${literals(exerciseKinds)}) THEN 'assistant'
    WHEN m."position" IN (${literals(professorPositions)}) THEN 'professor'
    ELSE 'assistant'
  END,
  sum(l."periods")
FROM "timetable_lessons" l
JOIN "timetables" tt ON tt."id" = l."timetable" AND tt."main"
JOIN subject_courses c ON c."subject" = l."subject" AND c."course" IS NOT NULL
JOIN teacher_staff t ON t."teacher" = l."teacher" AND t."staff" IS NOT NULL
JOIN "staff" m ON m."id" = t."staff"
GROUP BY 1, 2, 3, 4`;

const matchOf = (resolved: string, column: string, target: string): string =>
  `CASE
    WHEN EXISTS (SELECT 1 FROM ${resolved} r WHERE r."${column}" = l."${column}" AND r."${target}" IS NOT NULL) THEN 'matched'
    WHEN EXISTS (SELECT 1 FROM ${resolved} r WHERE r."${column}" = l."${column}") THEN 'ignored'
    ELSE 'unmatched'
  END`;

// How every lesson's subject and teacher matched; only changed rows are
// written.
export const matchLessonsSql = `WITH ${resolvedSql},
matches AS (
  SELECT l."id",
    ${matchOf('subject_courses', 'subject', 'course')} AS "course_match",
    ${matchOf('teacher_staff', 'teacher', 'staff')} AS "teacher_match"
  FROM "timetable_lessons" l
)
UPDATE "timetable_lessons" l SET "course_match" = m."course_match", "teacher_match" = m."teacher_match"
FROM matches m
WHERE m."id" = l."id"
  AND (l."course_match", l."teacher_match") IS DISTINCT FROM (m."course_match", m."teacher_match")`;

export const unmatchedSql = `SELECT
  count(DISTINCT l."subject") FILTER (WHERE l."course_match" = 'unmatched')::integer AS "subjects",
  count(DISTINCT l."teacher") FILTER (WHERE l."teacher_match" = 'unmatched')::integer AS "teachers"
FROM "timetable_lessons" l JOIN "timetables" t ON t."id" = l."timetable" AND t."main"`;
