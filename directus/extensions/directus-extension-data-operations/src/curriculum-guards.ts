import {
  type Guard,
  guardStatements,
  keyDetail,
  refuse,
  text,
} from './row-guards.js';

// The database guards of the curriculum generations: each row that names
// a generation, directly or through its entry or program, must name the
// same one, and only a generation with a curriculum takes entries. Studio
// filters its pickers by generation as a convenience; these triggers are
// the boundary for every writer (REST, Flows, imports, raw SQL); each
// refuses as every row guard does (row-guards.ts).
//
// A guard of a dependant row reads its parent FOR SHARE. The guard of a
// parent counts the dependants while its UPDATE holds the parent row (FOR
// NO KEY UPDATE, taken before a BEFORE trigger runs), and FOR SHARE
// conflicts with that lock: of two concurrent writes, the second waits for
// the first to commit and then reads its outcome (READ COMMITTED), so
// neither passes on the other's uncommitted state.

const newGeneration = 'NEW."generation"';

const guards: readonly Guard[] = [
  {
    body: `SELECT "generation" INTO entry_generation FROM "curriculum_entries" WHERE "id" = NEW."entry" FOR SHARE;
  IF entry_generation IS NULL THEN
    ${refuse('course_curricula', 'course_curricula.entry does not exist', keyDetail('entry', 'NEW."entry"', `') is not present in table "curriculum_entries".'`))}
  END IF;
  IF entry_generation IS DISTINCT FROM NEW."generation" THEN
    ${refuse('course_curricula', 'course_curricula.generation does not match the generation of its curriculum entry', keyDetail('generation', newGeneration, `') is not the generation ' || entry_generation || ' of curriculum entry ' || NEW."entry" || '.'`))}
  END IF;`,
    declarations: 'entry_generation integer;',
    events: 'INSERT OR UPDATE OF "entry", "generation"',
    name: 'course_curricula_generation_guard',
    table: 'course_curricula',
  },
  {
    body: `SELECT "has_curriculum" INTO curriculum FROM "curriculum_generations" WHERE "id" = NEW."generation" FOR SHARE;
  IF curriculum IS DISTINCT FROM true THEN
    ${refuse('curriculum_entries', 'curriculum_entries.generation has no curriculum', keyDetail('generation', newGeneration, `') names a generation without a curriculum; only a generation with has_curriculum takes entries.'`))}
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."generation" IS DISTINCT FROM NEW."generation" THEN
    SELECT (SELECT COUNT(*) FROM "course_curricula" WHERE "entry" = NEW."id")
      + (SELECT COUNT(*) FROM "curriculum_entry_program_states" WHERE "entry" = NEW."id")
      + (SELECT COUNT(*) FROM "course_equivalency_members" WHERE "entry" = NEW."id")
      INTO dependants;
    IF dependants > 0 THEN
      ${refuse('curriculum_entries', 'curriculum_entries.generation cannot change while course links, program states or equivalency members carry the old generation', keyDetail('generation', newGeneration, `') differs from generation ' || ${text('OLD."generation"')} || ', which ' || dependants || ' course links, program states or equivalency members of entry ' || NEW."id" || ' still carry.'`))}
    END IF;
  END IF;`,
    declarations: 'curriculum boolean;\n  dependants integer;',
    events: 'INSERT OR UPDATE OF "generation"',
    name: 'curriculum_entries_generation_guard',
    table: 'curriculum_entries',
  },
  {
    body: `SELECT "generation" INTO entry_generation FROM "curriculum_entries" WHERE "id" = NEW."entry" FOR SHARE;
  SELECT "generation" INTO program_generation FROM "study_programs" WHERE "id" = NEW."program" FOR SHARE;
  IF entry_generation IS NULL OR program_generation IS DISTINCT FROM entry_generation THEN
    ${refuse('curriculum_entry_program_states', 'curriculum_entry_program_states.program is not a program of the generation of its entry', keyDetail('program', 'NEW."program"', `') belongs to generation ' || ${text('program_generation')} || ', not to the generation ' || ${text('entry_generation')} || ' of curriculum entry ' || ${text('NEW."entry"')} || '.'`))}
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
      ${refuse('course_equivalency_members', 'course_equivalency_members.entry is not of the generation of its member', keyDetail('entry', 'NEW."entry"', `') is of generation ' || ${text('entry_generation')} || ', not of the member generation ' || ${text(newGeneration)} || '.'`))}
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
      ${refuse('study_programs', 'study_programs.generation cannot change while program states name the program', keyDetail('generation', newGeneration, `') differs from generation ' || ${text('OLD."generation"')} || ', whose entries carry ' || states || ' states of program ' || NEW."id" || '.'`))}
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
      ${refuse('curriculum_generations', 'curriculum_generations.has_curriculum cannot be cleared while the generation has entries', keyDetail('has_curriculum', 'NEW."has_curriculum"', `') would leave ' || entries || ' curriculum entries in generation ' || NEW."id" || ' without a curriculum.'`))}
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
