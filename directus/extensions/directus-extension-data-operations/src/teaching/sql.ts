import { academicTitles, professorPositions } from './vocabulary.js';

// The statements of the timetable import and of the course teaching
// rebuild. Every one runs inside a transaction that opened the guard of
// the timetable writer (timetables, timetable_lessons and course_teaching
// share it).

const literals = (values: readonly string[]): string =>
  values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', ');

// The key two names match by: lower case, inner whitespace collapsed.
export const key = (expression: string): string =>
  String.raw`lower(regexp_replace(btrim(${expression}), '\s+', ' ', 'g'))`;

// Binding: the listed timetables as JSON ({edupage_id, title, date_from,
// academic_year label, term, main, hidden}). A timetable is never deleted:
// a former main timetable keeps its lessons and stops counting.
export const upsertTimetablesSql = `INSERT INTO "timetables" ("edupage_id", "title", "date_from", "academic_year", "term", "main", "recent", "hidden", "checked_at")
SELECT r."edupage_id", r."title", r."date_from", y."id", r."term", r."main", r."recent", r."hidden", now()
FROM json_to_recordset(?::json) AS r("edupage_id" text, "title" text, "date_from" text, "academic_year" text, "term" text, "main" boolean, "recent" boolean, "hidden" boolean)
LEFT JOIN "academic_years" y ON y."label" = r."academic_year"
ON CONFLICT ("edupage_id") DO UPDATE SET "title" = EXCLUDED."title", "date_from" = EXCLUDED."date_from",
  "academic_year" = EXCLUDED."academic_year", "term" = EXCLUDED."term", "main" = EXCLUDED."main", "recent" = EXCLUDED."recent", "hidden" = EXCLUDED."hidden",
  "checked_at" = EXCLUDED."checked_at"`;

// The lock of the import and the rebuild, held to the end of the
// transaction: two rebuilds never clear and refill course_teaching at once.
export const teachingLockSql =
  "SELECT pg_advisory_xact_lock(hashtext('finki_hub.timetable_writer'))";

export const fingerprintsSql =
  'SELECT "edupage_id", "fingerprint" FROM "timetables"';

// Binding: the changed timetables' EduPage ids as JSON.
export const clearLessonsSql = `DELETE FROM "timetable_lessons" WHERE "timetable" IN (
  SELECT t."id" FROM "timetables" t WHERE t."edupage_id" IN (SELECT json_array_elements_text(?::json)))`;

// Binding: the changed timetables' EduPage ids as JSON.
export const clearSlotsSql = `DELETE FROM "timetable_slots" WHERE "timetable" IN (
  SELECT t."id" FROM "timetables" t WHERE t."edupage_id" IN (SELECT json_array_elements_text(?::json)))`;

// Binding: the slots as JSON, each with its timetable's EduPage id. The
// course and room are set by the rebuild that follows in the same
// transaction.
export const insertSlotsSql = `INSERT INTO "timetable_slots" ("timetable", "subject", "kind", "day", "starts", "ends", "periods", "teachers", "groups", "classroom", "room_match")
SELECT t."id", r."subject", r."kind", r."day", r."starts", r."ends", r."periods", r."teachers", r."groups", r."classroom", 'unmatched'
FROM json_to_recordset(?::json) AS r("edupage_id" text, "subject" text, "kind" text, "day" integer, "starts" text, "ends" text, "periods" integer, "teachers" text, "groups" text, "classroom" text)
JOIN "timetables" t ON t."edupage_id" = r."edupage_id"`;

// Binding: the lessons as JSON, each with its timetable's EduPage id. The
// match columns are set by the rebuild that follows in the same
// transaction.
export const insertLessonsSql = `INSERT INTO "timetable_lessons" ("timetable", "subject", "kind", "teacher", "periods", "course_match", "teacher_match")
SELECT t."id", r."subject", r."kind", r."teacher", r."periods", 'unmatched', 'unmatched'
FROM json_to_recordset(?::json) AS r("edupage_id" text, "subject" text, "kind" text, "teacher" text, "periods" integer)
JOIN "timetables" t ON t."edupage_id" = r."edupage_id"`;

// Binding: the changed timetables as JSON ({edupage_id, fingerprint}).
export const fingerprintSql = `UPDATE "timetables" t SET "fingerprint" = r."fingerprint", "imported_at" = now()
FROM json_to_recordset(?::json) AS r("edupage_id" text, "fingerprint" text)
WHERE t."edupage_id" = r."edupage_id"`;

// The staff member every distinct name of `teachers` (a query of one
// "teacher" column and its "key") stands for: by the full name, then by the
// first name and one of two surnames on either side ("Александра Дединец"
// and "Александра Каневче Дединец"), with the academic titles left out
// and the surname written first tried after the name as written. A name
// that matches two staff members at its best rank matches neither; an
// alias decides its name outright, a row without a staff member ignores
// it. Ends with teacher_staff ("teacher", "staff").
export const staffResolvedSql = (teachers: string): string => `staff_words AS (
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
  ${teachers}
),
teacher_words AS (
  SELECT t."teacher", ARRAY(
    SELECT u."word" FROM unnest(string_to_array(t."key", ' ')) WITH ORDINALITY AS u("word", "position")
    WHERE u."word" NOT IN (${literals(academicTitles)}) ORDER BY u."position"
  ) AS "words"
  FROM teachers t
),
teacher_orders AS (
  SELECT "teacher", "words", 0 AS "rank" FROM teacher_words
  UNION ALL
  SELECT "teacher", "words"[cardinality("words")] || "words"[1:cardinality("words") - 1], 2
  FROM teacher_words WHERE cardinality("words") > 1
),
teacher_names AS (
  SELECT "teacher", array_to_string("words", ' ') AS "key", "rank" FROM teacher_orders
  UNION ALL
  SELECT "teacher", "words"[1] || ' ' || "words"[3], "rank" + 1 FROM teacher_orders WHERE cardinality("words") = 3
  UNION ALL
  SELECT "teacher", "words"[1] || ' ' || "words"[2], "rank" + 1 FROM teacher_orders WHERE cardinality("words") = 3
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

const timetableTeachersSql = `SELECT DISTINCT "teacher", ${key('"teacher"')} AS "key" FROM "timetable_lessons"`;

// The courses and staff every distinct subject and teacher of the lessons
// stands for. A course name matches by the course's name, then its
// English name, then the name of a curriculum entry linked to it; a staff
// name by the full name, then by the first name and one of two surnames
// on either side ("Александра Дединец" and "Александра Каневче Дединец"). A
// name that matches two courses or two staff members at its best rank
// matches neither.
// An alias decides its name outright, a row without a target ignores it.
// A combined slot "A / B" matches when each part does.
// The course every distinct subject of `table` (timetable_lessons or
// timetable_slots) stands for: by the course's name, then its English
// name, then the name of a curriculum entry linked to it; a name that
// matches two courses at its best rank matches neither, an alias decides
// its name outright and a combined slot "A / B" matches when each part
// does. Ends with subject_courses ("subject", "course").
export const courseResolvedSql = (
  table: string,
): string => String.raw`course_names AS (
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
  SELECT DISTINCT "subject", ${key('"subject"')} AS "key" FROM "${table}"
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
  CROSS JOIN LATERAL regexp_split_to_table(s."subject", '\s*/\s*') AS p("part")
  LEFT JOIN course_keys k ON k."key" = ${key('p."part"')}
  WHERE s."subject" LIKE '%/%'
    AND NOT EXISTS (SELECT 1 FROM aliased_subjects a WHERE a."subject" = s."subject")
    AND NOT EXISTS (SELECT 1 FROM direct_subjects d WHERE d."subject" = s."subject")
),
subject_courses AS (
  SELECT "subject", "course" FROM aliased_subjects
  UNION SELECT "subject", "course" FROM direct_subjects
  UNION SELECT "subject", "course" FROM subject_parts
  WHERE "subject" IN (SELECT "subject" FROM subject_parts GROUP BY "subject" HAVING bool_and("course" IS NOT NULL))
)`;

const resolvedSql = `${courseResolvedSql('timetable_lessons')},
${staffResolvedSql(timetableTeachersSql)}`;

export const clearTeachingSql = 'DELETE FROM "course_teaching"';

// Every staff member's weekly periods of a course in each main timetable,
// as professor or assistant by their position, whatever classes they held.
export const insertTeachingSql = `WITH ${resolvedSql}
INSERT INTO "course_teaching" ("course", "staff", "timetable", "role", "periods")
SELECT c."course", t."staff", l."timetable",
  CASE
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
  count(DISTINCT l."teacher") FILTER (WHERE l."teacher_match" = 'unmatched')::integer AS "teachers",
  (SELECT count(DISTINCT s."classroom") FROM "timetable_slots" s JOIN "timetables" m ON m."id" = s."timetable" AND m."main"
    WHERE s."room_match" = 'unmatched')::integer AS "rooms"
FROM "timetable_lessons" l JOIN "timetables" t ON t."id" = l."timetable" AND t."main"`;

// The room every distinct classroom of the slots stands for: by the
// room's name and location either way round ("315 ТМФ", "ТМФ 315"), then
// by its name alone; a name that matches two rooms at its best rank
// matches neither. A room alias decides its name outright, one without a
// room ignores it (such as online).
const roomResolvedSql = `room_names AS (
  SELECT ${key(`r."name" || ' ' || r."location"`)} AS "key", r."id" AS "room", 0 AS "rank" FROM "rooms" r
  UNION ALL
  SELECT ${key(`r."location" || ' ' || r."name"`)}, r."id", 0 FROM "rooms" r
  UNION ALL
  SELECT ${key('r."name"')}, r."id", 1 FROM "rooms" r
),
room_keys AS (
  SELECT n."key", min(n."room") AS "room"
  FROM (SELECT *, min("rank") OVER (PARTITION BY "key") AS "best" FROM room_names) n
  WHERE n."rank" = n."best"
  GROUP BY n."key" HAVING count(DISTINCT n."room") = 1
),
classrooms AS (
  SELECT DISTINCT "classroom", ${key('"classroom"')} AS "key" FROM "timetable_slots" WHERE "classroom" IS NOT NULL
),
aliased_rooms AS (
  SELECT c."classroom", a."room" FROM classrooms c JOIN "room_aliases" a ON ${key('a."name"')} = c."key"
),
classroom_rooms AS (
  SELECT "classroom", "room" FROM aliased_rooms
  UNION
  SELECT c."classroom", k."room" FROM classrooms c JOIN room_keys k ON k."key" = c."key"
  WHERE NOT EXISTS (SELECT 1 FROM aliased_rooms a WHERE a."classroom" = c."classroom")
)`;

// Every slot's course (when its subject stands for exactly one) and room,
// and how its classroom matched; only changed rows are written. A slot
// without a classroom is ignored.
export const matchSlotsSql = `WITH ${courseResolvedSql('timetable_slots')},
${roomResolvedSql},
matches AS (
  SELECT s."id",
    (SELECT min(c."course") FROM subject_courses c WHERE c."subject" = s."subject" AND c."course" IS NOT NULL
      HAVING count(DISTINCT c."course") = 1) AS "course",
    (SELECT r."room" FROM classroom_rooms r WHERE r."classroom" = s."classroom") AS "room",
    CASE
      WHEN s."classroom" IS NULL THEN 'ignored'
      WHEN EXISTS (SELECT 1 FROM classroom_rooms r WHERE r."classroom" = s."classroom" AND r."room" IS NOT NULL) THEN 'matched'
      WHEN EXISTS (SELECT 1 FROM classroom_rooms r WHERE r."classroom" = s."classroom") THEN 'ignored'
      ELSE 'unmatched'
    END AS "room_match"
  FROM "timetable_slots" s
)
UPDATE "timetable_slots" s SET "course" = m."course", "room" = m."room", "room_match" = m."room_match"
FROM matches m
WHERE m."id" = s."id"
  AND (s."course", s."room", s."room_match") IS DISTINCT FROM (m."course", m."room", m."room_match")`;
