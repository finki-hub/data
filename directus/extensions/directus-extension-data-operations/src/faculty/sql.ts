// The statements of the faculty structure import. Every one runs inside a
// transaction that opened the guard of the faculty writer (the four
// structure tables share it).

// The lock of the import, held to the end of the transaction: two imports
// never clear and refill the structure at once.
export const facultyLockSql =
  "SELECT pg_advisory_xact_lock(hashtext('finki_hub.faculty_writer'))";

// The staff the people are matched to.
export const staffRefsSql =
  'SELECT "id", "name", "email", "profile" FROM "staff"';

// The holders of the latest term of the dean's office.
export const currentTermSql = `SELECT d."position", s."id" AS "staff", s."name", d."year"
FROM "deans_office" d JOIN "staff" s ON s."id" = d."staff"
WHERE d."year" = (SELECT max("year") FROM "deans_office")`;

// The structure tables, emptied before they are refilled: the import
// replaces them all, so a body the faculty drops is dropped here.
export const clearStructureSql: readonly string[] = [
  'DELETE FROM "institute_members"',
  'DELETE FROM "institutes"',
  'DELETE FROM "faculty_centers"',
  'DELETE FROM "faculty_import_issues"',
];

// Binding: the institutes as JSON ({name, page, head}).
export const insertInstitutesSql = `INSERT INTO "institutes" ("name", "page", "head", "imported_at")
SELECT r."name", r."page", r."head", now()
FROM json_to_recordset(?::json) AS r("name" text, "page" text, "head" integer)`;

// Binding: the members as JSON ({institute: the institute's name, staff}).
export const insertMembersSql = `INSERT INTO "institute_members" ("institute", "staff")
SELECT i."id", r."staff"
FROM json_to_recordset(?::json) AS r("institute" text, "staff" integer)
JOIN "institutes" i ON i."name" = r."institute"`;

// Binding: the centers as JSON ({name, page, head}).
export const insertCentersSql = `INSERT INTO "faculty_centers" ("name", "page", "head", "imported_at")
SELECT r."name", r."page", r."head", now()
FROM json_to_recordset(?::json) AS r("name" text, "page" text, "head" integer)`;

// Binding: the issues as JSON ({kind, body, name, email, profile, detail}).
export const insertIssuesSql = `INSERT INTO "faculty_import_issues" ("kind", "body", "name", "email", "profile", "detail", "imported_at")
SELECT r."kind", r."body", r."name", r."email", r."profile", r."detail", now()
FROM json_to_recordset(?::json) AS r("kind" text, "body" text, "name" text, "email" text, "profile" text, "detail" text)`;

// Binding: the photos and biographies as JSON ({id, photo, bio}), by staff
// id. Only a row that changes is written.
export const updateProfilesSql = `UPDATE "staff" s SET "photo" = r."photo", "bio" = r."bio"
FROM json_to_recordset(?::json) AS r("id" integer, "photo" text, "bio" text)
WHERE s."id" = r."id" AND (s."photo" IS DISTINCT FROM r."photo" OR s."bio" IS DISTINCT FROM r."bio")`;

// Binding: the staff ids of the council members as JSON. Only a row that
// changes is written.
export const updateCouncilSql = `WITH ids AS (SELECT json_array_elements_text(?::json)::integer AS "id")
UPDATE "staff" s SET "council_member" = EXISTS (SELECT 1 FROM ids WHERE ids."id" = s."id")
WHERE s."council_member" IS DISTINCT FROM EXISTS (SELECT 1 FROM ids WHERE ids."id" = s."id")`;
