import type { ConverterOptions } from './converter-types.js';
import type { Inventory } from './inventory.js';
import type { MigrationStep, StepContext } from './ledger-types.js';
import type { MigrationReport } from './report.js';
import type { SourceMapEntry } from './source-map.js';

import { applyCreates, applyUpdates } from './apply-writes.js';
import {
  assertRoleRowsAppended,
  convertTeachingAssignments,
  roleKey,
} from './assignments.js';
import { convertCouncilLinks } from './council.js';
import { convertCourseCurricula } from './course-links.js';
import { convertCurriculumEntries, convertProgramStates } from './curricula.js';
import {
  readGenerationIds,
  readMembers,
  readProgramIds,
  readStateIds,
} from './curriculum-reads.js';
import { convertEquivalencyLinks } from './equivalencies.js';
import { convertEquivalencyMembers } from './equivalency-members.js';
import {
  convertGenerations,
  convertPrograms,
  type ProgramSeed,
  specProgramHeaders,
  workbookPrograms,
} from './generations.js';
import { indexLabels } from './labels.js';
import { convertAcademicYears, convertEnrollmentRules } from './rules.js';
import {
  readCouncilLinks,
  readCourseLinks,
  readEntryIds,
  readEquivalencyLinks,
  readRoleRows,
  readRules,
  readYearIds,
} from './target-reads.js';

type StepInput = {
  readonly inventory: Inventory;
  readonly options: ConverterOptions;
  // The study programs to seed: the workbook's for the one-time import,
  // the checkpoint spec's for a populated project.
  readonly programs: readonly ProgramSeed[];
  readonly report: MigrationReport;
};

type Run = (
  context: StepContext,
  input: StepInput,
) => Promise<readonly SourceMapEntry[]>;

// The workbook's generations and study programs (reused when an import
// already seeded them), then every curriculum row as an entry with its
// program states, then every course's links to its unique current and
// legacy entries; ids are read back from what the earlier writes created.
const curricula: Run = async (
  context,
  { inventory, options, programs, report },
) => {
  const { checkpoint } = inventory;
  const generationRows = await applyCreates(context, options, {
    collection: 'curriculum_generations',
    conversion: convertGenerations(await readGenerationIds(context.request)),
    key: ['code'],
  });
  const generations = await readGenerationIds(context.request);
  const programRows = await applyCreates(context, options, {
    collection: 'study_programs',
    conversion: convertPrograms(programs, {
      generations,
      programs: await readProgramIds(context.request),
    }),
    key: ['generation', 'code'],
  });
  const entries = await applyCreates(context, options, {
    collection: 'curriculum_entries',
    conversion: convertCurriculumEntries(checkpoint, {
      entries: await readEntryIds(context.request),
      generations,
    }),
    key: ['source_collection', 'source_id'],
  });
  const entryIds = await readEntryIds(context.request);
  const states = await applyCreates(context, options, {
    collection: 'curriculum_entry_program_states',
    conversion: convertProgramStates(checkpoint, {
      entries: entryIds,
      generations,
      programs: await readProgramIds(context.request),
      states: await readStateIds(context.request),
    }),
    key: ['entry', 'program'],
  });
  const links = await applyCreates(context, options, {
    collection: 'course_curricula',
    conversion: convertCourseCurricula({
      candidates: report.candidates.courses,
      courses: checkpoint.courses,
      entryIds,
      existing: await readCourseLinks(context.request),
      generationIds: generations,
    }),
    key: ['course', 'generation'],
  });
  return [
    ...generationRows.mappings,
    ...programRows.mappings,
    ...entries.mappings,
    ...states.mappings,
    ...links.mappings,
  ];
};

// The academic years of the preflight (the workbook's for the one-time
// import), then one legacy_regex rule per course and year.
const rules: Run = async (context, { options, report }) => {
  const years = await applyCreates(context, options, {
    collection: 'academic_years',
    conversion: convertAcademicYears(
      report.academicYears,
      await readYearIds(context.request),
    ),
    key: ['label'],
  });
  const yearIds = await readYearIds(context.request);
  const seeded = await applyCreates(context, options, {
    collection: 'course_enrollment_rules',
    conversion: convertEnrollmentRules({
      candidates: report.candidates.courses,
      existing: await readRules(context.request, yearIds),
      patterns: report.candidates.patterns,
      yearIds,
    }),
    key: ['course', 'academic_year'],
  });
  return [...years.mappings, ...seeded.mappings];
};

const lastId = (rows: ReadonlyArray<{ readonly id: number }>): number => {
  let last = 0;
  for (const { id } of rows) {
    last = Math.max(last, id);
  }
  return last;
};

// Role-bearing rows beside the original text rows. Every role row, the
// ones an earlier attempt wrote and the ones written now, must carry an id
// above every original row, or the step fails before and after writing.
const assignments: Run = async (context, { inventory, options, report }) => {
  const collection = 'teaching_assignments';
  const lastOriginal = lastId(inventory.checkpoint.teaching_assignments);
  const present = await readRoleRows(context.request);
  assertRoleRowsAppended(present.values().toArray().flat(), lastOriginal);
  const applied = await applyCreates(context, options, {
    collection,
    conversion: convertTeachingAssignments({
      candidates: report.candidates.assignments,
      existing: present,
      rows: inventory.checkpoint.teaching_assignments,
      staffByName: indexLabels(inventory.checkpoint.staff, (row) => row.name),
    }),
    group: (record) => roleKey(record.source_id, record.role),
    key: ['source_id', 'role', 'sort'],
  });
  assertRoleRowsAppended(
    applied.mappings.flatMap(({ targetCollection, targetId }) =>
      targetCollection === collection && targetId !== null ? [targetId] : [],
    ),
    lastOriginal,
  );
  return applied.mappings;
};

const council: Run = async (context, { options, report }) => {
  const applied = await applyUpdates(context, options, {
    collection: 'student_council',
    conversion: convertCouncilLinks({
      candidates: report.candidates.council,
      current: await readCouncilLinks(context.request),
    }),
  });
  return applied.mappings;
};

// The course link of every equivalency row, then its members: one per
// filled label column, linked to the entry its label names uniquely.
const equivalencies: Run = async (context, { inventory, options, report }) => {
  const links = await applyUpdates(context, options, {
    collection: 'course_equivalencies',
    conversion: convertEquivalencyLinks({
      candidates: report.candidates.equivalencies,
      current: await readEquivalencyLinks(context.request),
    }),
  });
  const members = await applyCreates(context, options, {
    collection: 'course_equivalency_members',
    conversion: convertEquivalencyMembers({
      candidates: report.candidates.equivalencies,
      entryIds: await readEntryIds(context.request),
      existing: await readMembers(context.request),
      generationIds: await readGenerationIds(context.request),
      rows: inventory.checkpoint.course_equivalencies,
    }),
    key: ['equivalency', 'generation'],
  });
  return [...links.mappings, ...members.mappings];
};

const runs: ReadonlyArray<readonly [string, Run]> = [
  ['curricula', curricula],
  ['rules', rules],
  ['assignments', assignments],
  ['council', council],
  ['equivalencies', equivalencies],
];

// The converter steps in dependency order, one ledger step each. A step
// reads the target provenance fresh, converts the checkpoint rows with the
// candidate decisions of the live preflight, writes what is missing in
// bounded batches and returns its id map; a completed step is skipped by
// the ledger and an interrupted one resumes without a duplicate.
// The study programs seeded are the workbook's for the one-time import
// and the checkpoint spec's, by default, for a populated project.
export const converterSteps = (
  inventory: Inventory,
  report: MigrationReport,
  {
    programs = workbookPrograms(specProgramHeaders),
    ...options
  }: ConverterOptions & { readonly programs?: readonly ProgramSeed[] },
): readonly MigrationStep[] =>
  runs.map(([step, run]) => ({
    run: (context) => run(context, { inventory, options, programs, report }),
    step,
  }));
