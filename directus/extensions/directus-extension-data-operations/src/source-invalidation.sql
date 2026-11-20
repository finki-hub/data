-- Source invalidation: the correctness boundary of the FINKI Hub data
-- operations. Every statement on an editable source table increments the
-- source revision and marks the affected domains inside the SAME
-- transaction as the edit, so a rolled-back edit marks nothing and a
-- committed edit becomes visible together with its mark. Nothing here
-- calculates, maps or dispatches a Flow. Derived, staging and status tables
-- (staff, rooms, students, curriculum_entries, course_curricula,
-- curriculum_generations, study_programs, curriculum_entry_program_states,
-- teaching_assignments, student_council, course_equivalencies,
-- course_equivalency_members, discord_channels, discord_channel_courses,
-- deans_office, exam_sessions, anto_quotes, course_aliases, staff_aliases,
-- room_aliases, moodle_left_uncounted, degree_programs,
-- degree_program_courses, degree_program_slots, course_accreditation_staff,
-- moodle_history_memberships, course_enrollments, moodle_counted_lines,
-- timetables, timetable_lessons, course_teaching, timetable_slots,
-- timetable_slot_staff, timetable_slot_courses, bachelor_theses,
-- bachelor_thesis_staff, master_theses, master_thesis_staff, institutes,
-- institute_members, faculty_centers, faculty_import_issues,
-- moodle_import_rows, data_operations, data_operation_matches, directus_*)
-- carry no trigger.
--
-- Invalidation is per table and marks whole domains: an UPDATE that moves
-- a mapping to another course or year, and any DELETE, marks the domain,
-- whose next run recomputes every pair, so the old and the new
-- relationship are both covered. The history index and the enrollment
-- counts also keep the revision of the last statement that touched their
-- inputs (history_index_input_revision, enrollments_input_revision): a
-- running calculation is overtaken only by such a statement.
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
    WHEN 'moodle_users' THEN ARRAY['history_index', 'enrollments']
    ELSE ARRAY['enrollments']
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
  -- of it lifted) by those statements only.
  UPDATE "data_operations" SET
    "source_revision" = "source_revision" + 1,
    "requested_revision" = "source_revision" + 1,
    "history_index_input_revision" = CASE WHEN affected && ARRAY['history_index'] THEN "source_revision" + 1 ELSE "history_index_input_revision" END,
    "enrollments_input_revision" = CASE WHEN affected && ARRAY['history_index', 'enrollments'] THEN "source_revision" + 1 ELSE "enrollments_input_revision" END,
    "dirty_domains" = (
      SELECT COALESCE(json_agg(domain ORDER BY position), '[]'::json)
      FROM unnest(ARRAY['history_index', 'enrollments']) WITH ORDINALITY AS known(domain, position)
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
    RAISE EXCEPTION 'Change to % refused: data_operations status row missing', TG_TABLE_NAME;
  END IF;
  RETURN NULL;
END
$$
;
CREATE OR REPLACE TRIGGER "finki_hub_source_invalidation" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "courses" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"()
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
CREATE OR REPLACE TRIGGER "finki_hub_source_invalidation" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "moodle_pattern_mappings" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"()
;
