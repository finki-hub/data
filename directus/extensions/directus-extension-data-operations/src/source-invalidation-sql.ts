// The source-invalidation migration, embedded verbatim from
// src/migrations/source-invalidation.sql (the source of truth, runnable with
// psql as well). test/data-coordination.test.ts fails when the two differ:
// edit the .sql file, then paste it here unchanged.
export const sourceInvalidationSql = `-- Source invalidation: the correctness boundary of the FINKI Hub data
-- operations. Every statement on an editable source table increments the
-- source revision and marks the affected domains inside the SAME
-- transaction as the edit, so a rolled-back edit marks nothing and a
-- committed edit becomes visible together with its mark. Nothing here
-- calculates, maps or dispatches a Flow. Derived, staging and status tables
-- (moodle_history_memberships, course_enrollments, moodle_import_rows,
-- data_operations, data_operation_results, directus_*) carry no trigger.
--
-- Invalidation is per table and marks whole domains: an UPDATE that moves
-- a mapping or a rule to another course or year, and any DELETE, marks
-- the domain, whose next run recomputes every pair, so the old and the new
-- relationship are both covered. The history index and the enrollment
-- counts also keep the revision of the last statement that touched their
-- inputs (history_index_input_revision, enrollments_input_revision): a
-- running calculation is overtaken only by such a statement. Checkpoint overrides
-- (course_enrollment_patterns) mark publication only: the relational
-- counts read the enrollment rules the migration converted them into.
--
-- Applied by the bundled migration runner of the data-operations extension
-- (POST /finki-hub-data-operations/migrations/source-invalidation) after the
-- data model is installed. Statements are separated by a line holding a
-- single semicolon and each runs as its own raw() call inside one
-- transaction. Everything is idempotent.
--
-- The data_operations singleton row must exist: the trigger refuses a
-- source write it cannot record. The first statement creates the row when
-- it is missing and the second keeps the table at exactly one row.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "data_operations") THEN
    INSERT INTO "data_operations" DEFAULT VALUES;
  END IF;
END
$$
;
CREATE UNIQUE INDEX IF NOT EXISTS "data_operations_singleton_unique" ON "data_operations" ((true))
;
CREATE OR REPLACE FUNCTION "finki_hub_source_invalidation"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected text[];
BEGIN
  affected := CASE TG_TABLE_NAME
    WHEN 'moodle_users' THEN ARRAY['history_index', 'enrollments', 'publication']
    WHEN 'moodle_course_entries' THEN ARRAY['enrollments', 'publication']
    WHEN 'moodle_course_mappings' THEN ARRAY['enrollments', 'publication']
    WHEN 'course_enrollment_rules' THEN ARRAY['enrollments', 'publication']
    WHEN 'academic_years' THEN ARRAY['enrollments', 'publication']
    ELSE ARRAY['publication']
  END;
  -- Deleting a history entry cascades its memberships away, and a label
  -- edited by hand (the label belongs to the index writer, which only
  -- inserts entries) no longer names the lines its memberships came from:
  -- either way the derived index no longer matches the raw histories until
  -- it is rebuilt. The label case arrives through the column trigger below.
  IF TG_TABLE_NAME = 'moodle_course_entries' AND (TG_OP IN ('DELETE', 'TRUNCATE') OR TG_NAME = 'finki_hub_entry_label_invalidation') THEN
    affected := affected || ARRAY['history_index'];
  END IF;
  -- A calculation's input revision moves with every statement that marks
  -- it or an upstream domain, so a run of it is overtaken (and a failure
  -- of it lifted) by those statements only, never by a publication-only
  -- edit; publication follows the source revision itself.
  UPDATE "data_operations" SET
    "source_revision" = "source_revision" + 1,
    "requested_revision" = "source_revision" + 1,
    "history_index_input_revision" = CASE WHEN affected && ARRAY['history_index'] THEN "source_revision" + 1 ELSE "history_index_input_revision" END,
    "enrollments_input_revision" = CASE WHEN affected && ARRAY['history_index', 'enrollments'] THEN "source_revision" + 1 ELSE "enrollments_input_revision" END,
    "dirty_domains" = (
      SELECT COALESCE(json_agg(domain ORDER BY position), '[]'::json)
      FROM unnest(ARRAY['history_index', 'enrollments', 'publication']) WITH ORDINALITY AS known(domain, position)
      WHERE domain = ANY(affected)
        OR EXISTS (
          SELECT 1
          FROM json_array_elements_text(
            CASE WHEN json_typeof("dirty_domains") = 'array' THEN "dirty_domains" ELSE '[]'::json END
          ) AS dirty(domain)
          WHERE dirty.domain = known.domain
        )
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'data_operations has no status row, so the change to % cannot be recorded; run npm run setup', TG_TABLE_NAME;
  END IF;
  RETURN NULL;
END
$$
;
CREATE OR REPLACE TRIGGER "finki_hub_source_invalidation" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "courses" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"()
;
CREATE OR REPLACE TRIGGER "finki_hub_source_invalidation" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "staff" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"()
;
CREATE OR REPLACE TRIGGER "finki_hub_source_invalidation" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "rooms" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"()
;
CREATE OR REPLACE TRIGGER "finki_hub_source_invalidation" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "students" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"()
;
CREATE OR REPLACE TRIGGER "finki_hub_source_invalidation" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "curriculum_entries" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"()
;
CREATE OR REPLACE TRIGGER "finki_hub_source_invalidation" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "course_curricula" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"()
;
CREATE OR REPLACE TRIGGER "finki_hub_source_invalidation" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "teaching_assignments" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"()
;
CREATE OR REPLACE TRIGGER "finki_hub_source_invalidation" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "student_council" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"()
;
CREATE OR REPLACE TRIGGER "finki_hub_source_invalidation" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "course_equivalencies" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"()
;
CREATE OR REPLACE TRIGGER "finki_hub_source_invalidation" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "discord_channels" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"()
;
CREATE OR REPLACE TRIGGER "finki_hub_source_invalidation" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "deans_office" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"()
;
CREATE OR REPLACE TRIGGER "finki_hub_source_invalidation" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "academic_years" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"()
;
CREATE OR REPLACE TRIGGER "finki_hub_source_invalidation" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "moodle_users" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"()
;
CREATE OR REPLACE TRIGGER "finki_hub_source_invalidation" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "moodle_course_entries" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"()
;
CREATE OR REPLACE TRIGGER "finki_hub_entry_label_invalidation" AFTER UPDATE OF "label" ON "moodle_course_entries" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"()
;
CREATE OR REPLACE TRIGGER "finki_hub_source_invalidation" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "moodle_course_mappings" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"()
;
CREATE OR REPLACE TRIGGER "finki_hub_source_invalidation" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "course_enrollment_rules" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"()
;
DO $$
BEGIN
  IF to_regclass('"curriculum_2023"') IS NOT NULL THEN
    EXECUTE 'CREATE OR REPLACE TRIGGER "finki_hub_source_invalidation" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "curriculum_2023" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"()';
  END IF;
END
$$
;
DO $$
BEGIN
  IF to_regclass('"curriculum_2018"') IS NOT NULL THEN
    EXECUTE 'CREATE OR REPLACE TRIGGER "finki_hub_source_invalidation" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "curriculum_2018" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"()';
  END IF;
END
$$
;
DO $$
BEGIN
  IF to_regclass('"course_enrollment_patterns"') IS NOT NULL THEN
    EXECUTE 'CREATE OR REPLACE TRIGGER "finki_hub_source_invalidation" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "course_enrollment_patterns" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"()';
  END IF;
END
$$
;
`;

// Statements are separated by a line holding a single semicolon; full-line
// comments are dropped so every statement starts with SQL.
export const splitSqlStatements = (sql: string): string[] => {
  const statements: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    const text = current.join('\n').trim();
    if (text !== '') {
      statements.push(text);
    }
    current = [];
  };
  for (const line of sql.split('\n')) {
    if (line.trim() === ';') {
      flush();
    } else if (!line.trimStart().startsWith('--')) {
      current.push(line);
    }
  }
  flush();
  return statements;
};
