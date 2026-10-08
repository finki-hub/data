import { writeGuardStatements } from './coordination/write-guards.js';
import { curriculumGuardStatements } from './curriculum-guards.js';
import { keyGuardStatements } from './key-guards.js';
import {
  sourceInvalidationSql,
  splitSqlStatements,
} from './source-invalidation-sql.js';

export type Migration = {
  readonly name: string;
  readonly statements: readonly string[];
};

const migrationNamePattern = /^[a-z][a-z0-9-]{0,63}$/u;

// A name a bundled migration could carry.
export const isMigrationName = (name: string | undefined): name is string =>
  name !== undefined && migrationNamePattern.test(name);

// Composite domain keys, join indexes, the curriculum generation and code
// guards (curriculum-guards.ts), the key guards of published key rows
// (key-guards.ts) and the write guards of the derived, candidate and
// staging tables (from the collection-role registry) that the Directus
// schema API cannot express.
// Every statement is idempotent and is executed on its own inside one
// transaction; statements carry no bindings.
export const schemaConstraints: Migration = {
  name: 'schema-constraints',
  statements: [
    'CREATE UNIQUE INDEX IF NOT EXISTS "course_curricula_course_generation_unique" ON "course_curricula" ("course", "generation")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "study_programs_generation_code_unique" ON "study_programs" ("generation", "code")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "curriculum_entry_program_states_entry_program_unique" ON "curriculum_entry_program_states" ("entry", "program")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "course_equivalency_members_equivalency_generation_unique" ON "course_equivalency_members" ("equivalency", "generation")',
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
    ...curriculumGuardStatements(),
    ...keyGuardStatements(),
    ...writeGuardStatements(),
  ],
};

// The statement-level source-invalidation triggers: the correctness
// boundary of the coordinator, generated from the collection-role registry
// (snapshot: source-invalidation.sql).
export const sourceInvalidation: Migration = {
  name: 'source-invalidation',
  statements: splitSqlStatements(sourceInvalidationSql),
};

// The only migrations the endpoint will ever run.
export const migrations: readonly Migration[] = [
  schemaConstraints,
  sourceInvalidation,
];

export const findMigration = (
  name: string | undefined,
): Migration | undefined =>
  isMigrationName(name)
    ? migrations.find((migration) => migration.name === name)
    : undefined;
