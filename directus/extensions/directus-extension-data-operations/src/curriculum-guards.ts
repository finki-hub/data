import {
  fact,
  type Guard,
  guardStatements,
  keyDetail,
  keyFacts,
  refuse,
  rowMessage,
} from './row-guards.js';

// The database guards of the curriculum generations: each row that names
// a generation, directly or through its entry or program, must name the
// same one, and only a generation with a curriculum takes entries. A
// non-empty entry code must give a level. Studio filters its pickers by
// generation as a convenience; these triggers are the boundary for every
// writer (REST, Flows, imports, raw SQL); each refuses as every row guard
// does (row-guards.ts).
//
// A guard of a dependant row reads its parent FOR SHARE. The guard of a
// parent counts the dependants while its UPDATE holds the parent row (FOR
// NO KEY UPDATE, taken before a BEFORE trigger runs), and FOR SHARE
// conflicts with that lock: of two concurrent writes, the second waits for
// the first to commit and then reads its outcome (READ COMMITTED), so
// neither passes on the other's uncommitted state.

const newGeneration = 'NEW."generation"';

// The start of a code that gives a level, `F<yy>L<level>`: the SQL form of
// codeLevel (exports/curriculum-code.ts), pinned to it by a test.
const levelCodeStart = '^F[0-9]{2}L[0-9]';

const guards: readonly Guard[] = [
  {
    body: `SELECT "generation" INTO entry_generation FROM "curriculum_entries" WHERE "id" = NEW."entry" FOR SHARE;
  IF entry_generation IS NULL THEN
    ${refuse('course_curricula', 'course_curricula.entry does not exist', keyDetail('entry', 'NEW."entry"', `') is not present in table "curriculum_entries".'`))}
  END IF;
  IF entry_generation IS DISTINCT FROM NEW."generation" THEN
    ${refuse('course_curricula', rowMessage('course_curricula', 'generation', 'mismatch: entry generation differs'), keyFacts('generation', newGeneration, [fact(['entry', 'NEW."entry"'], ['generation', 'entry_generation'])]))}
  END IF;`,
    declarations: 'entry_generation integer;',
    events: 'INSERT OR UPDATE OF "entry", "generation"',
    name: 'course_curricula_generation_guard',
    table: 'course_curricula',
  },
  {
    body: `SELECT "has_curriculum" INTO curriculum FROM "curriculum_generations" WHERE "id" = NEW."generation" FOR SHARE;
  IF curriculum IS DISTINCT FROM true THEN
    ${refuse('curriculum_entries', rowMessage('curriculum_entries', 'generation', 'has no curriculum'), keyFacts('generation', newGeneration, [fact(['has_curriculum', 'curriculum'])]))}
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."generation" IS DISTINCT FROM NEW."generation" THEN
    SELECT (SELECT COUNT(*) FROM "course_curricula" WHERE "entry" = NEW."id")
      + (SELECT COUNT(*) FROM "curriculum_entry_program_states" WHERE "entry" = NEW."id")
      + (SELECT COUNT(*) FROM "course_equivalency_members" WHERE "entry" = NEW."id")
      INTO dependants;
    IF dependants > 0 THEN
      ${refuse('curriculum_entries', rowMessage('curriculum_entries', 'generation', 'locked: dependants carry the old generation'), keyFacts('generation', newGeneration, [fact(['entry', 'NEW."id"']), fact(['old generation', 'OLD."generation"']), fact(['dependants', 'dependants'])]))}
    END IF;
  END IF;`,
    declarations: 'curriculum boolean;\n  dependants integer;',
    events: 'INSERT OR UPDATE OF "generation"',
    name: 'curriculum_entries_generation_guard',
    table: 'curriculum_entries',
  },
  {
    body: `IF COALESCE(NEW."code", '') <> '' AND NEW."code" !~ '${levelCodeStart}' THEN
    ${refuse('curriculum_entries', rowMessage('curriculum_entries', 'code', 'has no level: expected F<yy>L<level>'), keyFacts('code', 'NEW."code"', [fact(['entry', 'NEW."id"'])]))}
  END IF;`,
    declarations: '',
    events: 'INSERT OR UPDATE OF "code"',
    name: 'curriculum_entries_code_guard',
    table: 'curriculum_entries',
  },
  {
    body: `SELECT "generation" INTO entry_generation FROM "curriculum_entries" WHERE "id" = NEW."entry" FOR SHARE;
  SELECT "generation" INTO program_generation FROM "study_programs" WHERE "id" = NEW."program" FOR SHARE;
  IF entry_generation IS NULL OR program_generation IS DISTINCT FROM entry_generation THEN
    ${refuse('curriculum_entry_program_states', rowMessage('curriculum_entry_program_states', 'program', 'generation mismatch'), keyFacts('program', 'NEW."program"', [fact(['program generation', 'program_generation']), fact(['entry', 'NEW."entry"'], ['generation', 'entry_generation'])]))}
  END IF;`,
    declarations: 'entry_generation integer;\n  program_generation integer;',
    events: 'INSERT OR UPDATE OF "entry", "program"',
    name: 'curriculum_entry_program_states_generation_guard',
    table: 'curriculum_entry_program_states',
  },
  {
    body: `IF NEW."entry" IS NOT NULL THEN
    SELECT "generation" INTO entry_generation FROM "curriculum_entries" WHERE "id" = NEW."entry" FOR SHARE;
    IF entry_generation IS DISTINCT FROM NEW."generation" THEN
      ${refuse('course_equivalency_members', rowMessage('course_equivalency_members', 'entry', 'generation mismatch'), keyFacts('entry', 'NEW."entry"', [fact(['entry generation', 'entry_generation']), fact(['member generation', newGeneration])]))}
    END IF;
  END IF;`,
    declarations: 'entry_generation integer;',
    events: 'INSERT OR UPDATE OF "entry", "generation"',
    name: 'course_equivalency_members_generation_guard',
    table: 'course_equivalency_members',
  },
  {
    body: `IF OLD."generation" IS DISTINCT FROM NEW."generation" THEN
    SELECT COUNT(*) INTO states FROM "curriculum_entry_program_states" WHERE "program" = NEW."id";
    IF states > 0 THEN
      ${refuse('study_programs', rowMessage('study_programs', 'generation', 'locked: program states exist'), keyFacts('generation', newGeneration, [fact(['program', 'NEW."id"']), fact(['old generation', 'OLD."generation"']), fact(['program states', 'states'])]))}
    END IF;
  END IF;`,
    declarations: 'states integer;',
    events: 'UPDATE OF "generation"',
    name: 'study_programs_generation_guard',
    table: 'study_programs',
  },
  {
    body: `IF NEW."has_curriculum" IS DISTINCT FROM true THEN
    SELECT COUNT(*) INTO entries FROM "curriculum_entries" WHERE "generation" = NEW."id";
    IF entries > 0 THEN
      ${refuse('curriculum_generations', rowMessage('curriculum_generations', 'has_curriculum', 'locked: generation has entries'), keyFacts('has_curriculum', 'NEW."has_curriculum"', [fact(['generation', 'NEW."id"']), fact(['entries', 'entries'])]))}
    END IF;
  END IF;`,
    declarations: 'entries integer;',
    events: 'UPDATE OF "has_curriculum"',
    name: 'curriculum_generations_curriculum_guard',
    table: 'curriculum_generations',
  },
];

// The tables a curriculum guard watches, with its trigger name.
export const curriculumGuards: ReadonlyArray<{
  readonly table: string;
  readonly trigger: string;
}> = guards.map(({ name, table }) => ({ table, trigger: name }));

// Each guard's function, then its trigger; idempotent (CREATE OR REPLACE).
export const curriculumGuardStatements = (): readonly string[] =>
  guardStatements(guards);
