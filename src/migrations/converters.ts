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
import { convertCurriculumEntries } from './curricula.js';
import { convertEquivalencyLinks } from './equivalencies.js';
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
  readonly report: MigrationReport;
};

type Run = (
  context: StepContext,
  input: StepInput,
) => Promise<readonly SourceMapEntry[]>;

// Every curriculum row becomes an entry, then every course links its
// unique current and legacy entries; the entry ids are read back from the
// provenance the first half wrote.
const curricula: Run = async (context, { inventory, options, report }) => {
  const entries = await applyCreates(context, options, {
    collection: 'curriculum_entries',
    conversion: convertCurriculumEntries(
      inventory.checkpoint,
      await readEntryIds(context.request),
    ),
    key: ['source_collection', 'source_id'],
  });
  const links = await applyCreates(context, options, {
    collection: 'course_curricula',
    conversion: convertCourseCurricula({
      candidates: report.candidates.courses,
      courses: inventory.checkpoint.courses,
      entryIds: await readEntryIds(context.request),
      existing: await readCourseLinks(context.request),
    }),
    key: ['course', 'generation'],
  });
  return [...entries.mappings, ...links.mappings];
};

// The fifteen academic years, then one legacy_regex rule per course and
// year.
const rules: Run = async (context, { options, report }) => {
  const years = await applyCreates(context, options, {
    collection: 'academic_years',
    conversion: convertAcademicYears(await readYearIds(context.request)),
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

const equivalencies: Run = async (context, { options, report }) => {
  const applied = await applyUpdates(context, options, {
    collection: 'course_equivalencies',
    conversion: convertEquivalencyLinks({
      candidates: report.candidates.equivalencies,
      current: await readEquivalencyLinks(context.request),
      entryIds: await readEntryIds(context.request),
    }),
  });
  return applied.mappings;
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
export const converterSteps = (
  inventory: Inventory,
  report: MigrationReport,
  options: ConverterOptions,
): readonly MigrationStep[] =>
  runs.map(([step, run]) => ({
    run: (context) => run(context, { inventory, options, report }),
    step,
  }));
