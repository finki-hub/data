-- Source invalidation: the correctness boundary of the FINKI Hub data
-- operations. Every statement on an editable source table increments the
-- source revision and marks the affected domains inside the SAME
-- transaction as the edit, so a rolled-back edit marks nothing and a
-- committed edit becomes visible together with its mark. Nothing here
-- calculates, maps or dispatches a Flow. Derived, staging and status tables
-- (moodle_history_memberships, course_enrollments, moodle_import_rows,
-- data_operations, data_operation_results, directus_*) carry no trigger.
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
  UPDATE "data_operations" SET
    "source_revision" = "source_revision" + 1,
    "requested_revision" = "source_revision" + 1,
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
