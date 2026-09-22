export type Migration = {
  readonly name: string;
  readonly statements: readonly string[];
};

export const migrationNamePattern = /^[a-z][a-z0-9-]{0,63}$/u;

const generationGuardFunction = `
CREATE OR REPLACE FUNCTION "finki_hub_course_curricula_generation_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  entry_generation text;
BEGIN
  SELECT "generation" INTO entry_generation FROM "curriculum_entries" WHERE "id" = NEW."entry";
  IF entry_generation IS NULL THEN
    RAISE EXCEPTION 'course_curricula.entry % does not exist', NEW."entry"
      USING ERRCODE = 'foreign_key_violation', TABLE = 'course_curricula',
        DETAIL = 'Key (entry)=(' || NEW."entry" || ') is not present in table "curriculum_entries".';
  END IF;
  IF entry_generation IS DISTINCT FROM NEW."generation" THEN
    RAISE EXCEPTION 'course_curricula.generation % does not match curriculum entry generation %', NEW."generation", entry_generation
      USING ERRCODE = 'foreign_key_violation', TABLE = 'course_curricula',
        DETAIL = 'Key (entry)=(' || NEW."entry" || ') belongs to generation ' || entry_generation || ', not ' || COALESCE(NEW."generation", 'NULL') || '.';
  END IF;
  RETURN NEW;
END
$$`;

const entryGenerationGuardFunction = `
CREATE OR REPLACE FUNCTION "finki_hub_curriculum_entries_generation_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  linked_courses integer;
BEGIN
  SELECT COUNT(*) INTO linked_courses FROM "course_curricula"
    WHERE "entry" = NEW."id" AND "generation" IS DISTINCT FROM NEW."generation";
  IF linked_courses > 0 THEN
    RAISE EXCEPTION 'curriculum_entries.generation cannot change while % course links carry generation %', linked_courses, OLD."generation"
      USING ERRCODE = 'foreign_key_violation', TABLE = 'curriculum_entries',
        DETAIL = 'Key (generation)=(' || COALESCE(NEW."generation", 'NULL') || ') is still referenced by course_curricula rows of generation ' || COALESCE(OLD."generation", 'NULL') || '.';
  END IF;
  RETURN NEW;
END
$$`;

// Composite domain keys, join indexes and the generation guard that the
// Directus schema API cannot express. Every statement is idempotent and is
// executed on its own inside one transaction; statements carry no bindings.
export const schemaConstraints: Migration = {
  name: 'schema-constraints',
  statements: [
    'CREATE UNIQUE INDEX IF NOT EXISTS "course_curricula_course_generation_unique" ON "course_curricula" ("course", "generation")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "moodle_history_memberships_moodle_user_entry_unique" ON "moodle_history_memberships" ("moodle_user", "entry")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "moodle_course_mappings_entry_course_academic_year_unique" ON "moodle_course_mappings" ("entry", "course", "academic_year")',
    'CREATE INDEX IF NOT EXISTS "moodle_course_mappings_course_academic_year_index" ON "moodle_course_mappings" ("course", "academic_year")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "course_enrollment_rules_course_academic_year_unique" ON "course_enrollment_rules" ("course", "academic_year")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "course_enrollments_course_academic_year_unique" ON "course_enrollments" ("course", "academic_year")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "data_operation_results_claim_page_course_year_unique" ON "data_operation_results" ("claim_token", "page_token", "course", "academic_year")',
    `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'course_enrollments_count_nonnegative') THEN
    ALTER TABLE "course_enrollments" ADD CONSTRAINT "course_enrollments_count_nonnegative" CHECK ("count" >= 0);
  END IF;
END
$$`,
    generationGuardFunction,
    'CREATE OR REPLACE TRIGGER "course_curricula_generation_guard" BEFORE INSERT OR UPDATE OF "entry", "generation" ON "course_curricula" FOR EACH ROW EXECUTE FUNCTION "finki_hub_course_curricula_generation_guard"()',
    entryGenerationGuardFunction,
    'CREATE OR REPLACE TRIGGER "curriculum_entries_generation_guard" BEFORE UPDATE OF "generation" ON "curriculum_entries" FOR EACH ROW EXECUTE FUNCTION "finki_hub_curriculum_entries_generation_guard"()',
  ],
};

// The only migrations the endpoint will ever run.
export const migrations: readonly Migration[] = [schemaConstraints];

export const findMigration = (
  name: string | undefined,
): Migration | undefined =>
  name !== undefined && migrationNamePattern.test(name)
    ? migrations.find((migration) => migration.name === name)
    : undefined;
