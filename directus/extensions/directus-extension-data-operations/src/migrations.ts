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

// A CHECK constraint added once, by name.
const checkConstraint = (table: string, name: string, condition: string) =>
  `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
    ALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK (${condition});
  END IF;
END
$$`;

// The most UTF-8 bytes a pattern mapping's texts hold; the import refuses
// a planned text over them before it writes anything (`unstorable`).
export const patternMappingMaxBytes = {
  pattern: 2_048,
  year_pattern: 512,
} as const;

// A pattern mapping holds a pattern of one line and exactly one of a year
// pattern (one line) and a year.
export const patternMappingChecks = [
  checkConstraint(
    'moodle_pattern_mappings',
    'moodle_pattern_mappings_pattern_check',
    String.raw`"pattern" <> '' AND "pattern" !~ '[\r\n]' AND octet_length("pattern") <= ${String(patternMappingMaxBytes.pattern)}`,
  ),
  checkConstraint(
    'moodle_pattern_mappings',
    'moodle_pattern_mappings_year_choice_check',
    '("year_pattern" IS NULL) <> ("only_in_year" IS NULL)',
  ),
  checkConstraint(
    'moodle_pattern_mappings',
    'moodle_pattern_mappings_year_pattern_check',
    String.raw`"year_pattern" IS NULL OR ("year_pattern" <> '' AND "year_pattern" !~ '[\r\n]' AND octet_length("year_pattern") <= ${String(patternMappingMaxBytes.year_pattern)})`,
  ),
];

// Composite domain keys, join indexes, the curriculum generation and code
// guards (curriculum-guards.ts), the key guards of published key rows
// (key-guards.ts), the pattern mapping CHECKs and the write guards of the
// derived, candidate and staging tables (from the collection-role
// registry) that the Directus schema API cannot express.
// Every statement is idempotent and is executed on its own inside one
// transaction; statements carry no bindings.
export const schemaConstraints: Migration = {
  name: 'schema-constraints',
  statements: [
    'CREATE UNIQUE INDEX IF NOT EXISTS "teaching_assignments_course_staff_role_unique" ON "teaching_assignments" ("course", "staff", "role")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "deans_office_year_position_unique" ON "deans_office" ("year", "position")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "course_curricula_course_generation_unique" ON "course_curricula" ("course", "generation")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "study_programs_generation_code_unique" ON "study_programs" ("generation", "code")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "curriculum_entry_program_states_entry_program_unique" ON "curriculum_entry_program_states" ("entry", "program")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "course_equivalency_members_equivalency_generation_unique" ON "course_equivalency_members" ("equivalency", "generation")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "discord_channel_courses_discord_channel_course_unique" ON "discord_channel_courses" ("discord_channel", "course")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "moodle_history_memberships_moodle_user_entry_unique" ON "moodle_history_memberships" ("moodle_user", "entry")',
    'CREATE INDEX IF NOT EXISTS "moodle_history_memberships_entry_index" ON "moodle_history_memberships" ("entry")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "moodle_course_mappings_entry_course_academic_year_unique" ON "moodle_course_mappings" ("entry", "course", "academic_year")',
    'CREATE INDEX IF NOT EXISTS "moodle_course_mappings_course_academic_year_index" ON "moodle_course_mappings" ("course", "academic_year")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "moodle_pattern_mappings_course_pattern_unique" ON "moodle_pattern_mappings" ("course", "pattern", "year_pattern", "only_in_year") NULLS NOT DISTINCT',
    'CREATE INDEX IF NOT EXISTS "moodle_pattern_mappings_course_only_in_year_index" ON "moodle_pattern_mappings" ("course", "only_in_year")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "moodle_counted_lines_entry_course_year_mapping_unique" ON "moodle_counted_lines" ("entry", "course", "academic_year", "pattern_mapping") NULLS NOT DISTINCT',
    'CREATE UNIQUE INDEX IF NOT EXISTS "data_operation_matches_claim_page_entry_mapping_unique" ON "data_operation_matches" ("claim_token", "page_token", "entry", "pattern_mapping")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "course_enrollments_course_academic_year_unique" ON "course_enrollments" ("course", "academic_year")',
    `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'course_enrollments_count_nonnegative') THEN
    ALTER TABLE "course_enrollments" ADD CONSTRAINT "course_enrollments_count_nonnegative" CHECK ("count" >= 0);
  END IF;
END
$$`,
    ...patternMappingChecks,
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
