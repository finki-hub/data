import { describe, expect, test } from 'vitest';

import type {
  CoordinationFacts,
  SnapshotFacts,
} from '../directus/extensions/directus-extension-data-operations/src/exports/readiness-facts.js';
import type { ReadinessEntry } from '../directus/extensions/directus-extension-data-operations/src/exports/readiness-types.js';
import type {
  IssueCounts,
  SourceRead,
} from '../directus/extensions/directus-extension-data-operations/src/exports/types.js';
import type { FakeItem, FakeStore } from './store-test-helpers.js';

import { definitionProblems } from '../directus/extensions/directus-extension-data-operations/src/exports/definitions-check.js';
import {
  coordinationFacts,
  snapshotFacts,
} from '../directus/extensions/directus-extension-data-operations/src/exports/directus.js';
import { exportDefinitions } from '../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import { readinessAction } from '../directus/extensions/directus-extension-data-operations/src/exports/prepare.js';
import { readinessRegistry } from '../directus/extensions/directus-extension-data-operations/src/exports/readiness-registry.js';
import { storeReader } from '../src/projection/memory-reader.js';
import {
  claimNext,
  fail,
  settled,
  status,
} from './automatic-processing-helpers.js';
import {
  courseNames,
  type SyntheticDataset,
} from './fixtures/synthetic-data.js';
import { planOf, withCourse } from './import-plan-helpers.js';
import { readinessEntry } from './registry-test-helpers.js';
import {
  edit,
  importedStore,
  parityDataset,
  renamedCurrent,
  rowsOf,
  unmatchedLegacy,
} from './relational-export-helpers.js';

const current: CoordinationFacts = {
  calculation: 'graph-a',
  domains: { enrollments: 'current', history_index: 'current' },
  revision: 42,
};

const promoted: SnapshotFacts = {
  activeMatchesPromotion: true,
  activeRows: 9,
  state: 'completed',
};

type Situation = {
  readonly coordination?: CoordinationFacts;
  readonly log?: SourceRead[];
  readonly registry?: readonly ReadinessEntry[];
  readonly snapshot?: SnapshotFacts;
  readonly store?: FakeStore;
};

const decide = async (situation: Situation = {}) =>
  readinessAction(
    exportDefinitions,
    {
      coordination: () => Promise.resolve(situation.coordination ?? current),
      reader: storeReader(
        situation.store ?? (await importedStore()),
        situation.log,
      ),
      snapshot: () => Promise.resolve(situation.snapshot ?? promoted),
    },
    situation.registry,
  );

const append =
  (rows: readonly FakeItem[]) =>
  (existing: FakeItem[]): FakeItem[] => [...existing, ...rows];

const without =
  (drop: (row: FakeItem) => boolean) =>
  (rows: FakeItem[]): FakeItem[] =>
    rows.filter((row) => !drop(row));

const recordText = /Synthetic|Prof\.|Asst\.|Course|@/u;

// Iota without its imported 2023 credits and availability: only the 2023
// name remains on the course.
const nameOnly = (dataset: SyntheticDataset): SyntheticDataset => ({
  ...dataset,
  courses: dataset.courses.map((course) =>
    course['name'] === courseNames.iota
      ? { ...course, available_2023: null, credits_2023: null }
      : course,
  ),
});

// The warnings of the imported parity fixture: its three equivalencies
// without a course, its two equivalency labels without an entry (Alpha's
// decoy 2018 label, the orphan 2023 label) and its council member whose
// index matched no student.
const baselineWarnings = {
  council_member_unresolved: 1,
  equivalency_entry_unresolved: 2,
  equivalency_without_course: 3,
};

// Every registered code with its count: the given ones, zero otherwise.
const everyCode = (counts: IssueCounts): IssueCounts =>
  Object.fromEntries(
    readinessRegistry.map(({ code }) => [code, counts[code] ?? 0]),
  );

// The registry with one more entry counted by a check of the test.
const withCheck = (
  code: string,
  evaluate: () => IssueCounts,
): ReadinessEntry[] => [
  ...readinessRegistry,
  {
    code,
    description: 'A synthetic check of the test.',
    gates: [],
    generationScoped: false,
    page: 'courses',
    severity: 'warning',
    source: { check: { evaluate, reads: {} }, kind: 'check' },
  },
];

describe('the readiness decision', () => {
  test('answers ready for current, complete data with its warnings, counts and pages only', async () => {
    await expect(decide()).resolves.toEqual({
      blockedFiles: [],
      blockers: [],
      issueCounts: everyCode(baselineWarnings),
      links: {
        council_member_unresolved: '/admin/content/student_council',
        equivalency_entry_unresolved:
          '/admin/content/course_equivalency_members',
        equivalency_without_course: '/admin/content/course_equivalencies',
      },
      ready: true,
      reviews: {
        council_member_unresolved: 'Council members without a student',
        equivalency_entry_unresolved: 'Equivalency labels without an entry',
        equivalency_without_course: 'Equivalencies without a course',
      },
      revision: 42,
      warnings: [
        'equivalency_without_course',
        'equivalency_entry_unresolved',
        'council_member_unresolved',
      ],
    });
  });

  test.each([
    ['history_index', 'pending'],
    ['history_index', 'running'],
    ['history_index', 'failed'],
    ['enrollments', 'pending'],
    ['enrollments', 'running'],
    ['enrollments', 'failed'],
  ])('blocks while %s is %s', async (domain, state) => {
    const decision = await decide({
      coordination: {
        ...current,
        domains: { ...current.domains, [domain]: state },
      },
    });

    expect(decision.ready).toBeFalsy();
    expect(decision.blockers).toEqual([`${domain}_${state}`]);
    expect(decision.blockedFiles).toEqual(['courses.json']);
    expect(decision.links[`${domain}_${state}`]).toBe(
      '/admin/content/data_operations',
    );
  });

  test('reads the calculation states the coordinator status reports', async () => {
    const fake = settled();

    expect(coordinationFacts(await status(fake))).toEqual({
      calculation: fake.graphs.calculation,
      domains: { enrollments: 'current', history_index: 'current' },
      revision: 0,
    });

    fake.sourceWrite('moodle_users');
    const pending = coordinationFacts(await status(fake));

    expect(pending.domains).toEqual({
      enrollments: 'pending',
      history_index: 'pending',
    });

    const { token } = await claimNext(fake);

    expect(coordinationFacts(await status(fake)).domains).toEqual({
      enrollments: 'pending',
      history_index: 'running',
    });

    await fail(fake, token, 'Synthetic failure of page p0001.');
    const failed = coordinationFacts(await status(fake));

    expect(failed.domains['history_index']).toBe('failed');
    await expect(decide({ coordination: failed })).resolves.toMatchObject({
      blockers: ['history_index_failed', 'enrollments_pending'],
      ready: false,
    });
  });

  test.each([
    ['importing', ['snapshot_import_running'], []],
    ['validating', ['snapshot_import_running'], []],
    ['promoting', ['snapshot_import_running'], []],
    ['failed', ['snapshot_import_failed'], []],
    ['ready', [], ['snapshot_staged']],
    ['completed', [], []],
    ['idle', [], []],
  ])(
    'treats a snapshot import %s as blockers %j and warnings %j',
    async (state, blockers, warnings) => {
      const decision = await decide({ snapshot: { ...promoted, state } });

      expect(decision.blockers).toEqual(blockers);
      expect(
        decision.warnings.filter((code) => code.startsWith('snapshot')),
      ).toEqual(warnings);
    },
  );

  test('warns, never blocks, about active Moodle users edited outside the snapshot import', async () => {
    const edited = await decide({
      snapshot: { ...promoted, activeMatchesPromotion: false },
    });
    const never = await decide({
      snapshot: { ...promoted, activeMatchesPromotion: null },
    });
    const empty = await decide({
      snapshot: { activeMatchesPromotion: null, activeRows: 0, state: 'idle' },
    });

    expect(edited.ready).toBeTruthy();
    expect(edited.warnings).toContain('active_snapshot_edited');
    expect(never.warnings).toContain('snapshot_never_promoted');
    expect(empty.warnings).not.toContain('snapshot_never_promoted');
  });

  test('reads the snapshot facts the snapshot status reports', () => {
    expect(
      snapshotFacts({
        active: { fingerprint: 'f'.repeat(64), rows: 9 },
        activeMatchesPromotion: false,
        backup: { file: null, fingerprint: null, rows: null },
        error: null,
        file: null,
        fingerprint: null,
        finishedAt: null,
        promoted: { at: null, fingerprint: 'e'.repeat(64), rows: 8 },
        rows: null,
        staging: { fingerprint: 'd'.repeat(64), rows: 0 },
        startedAt: null,
        state: 'completed',
        warnings: null,
      }),
    ).toEqual({
      activeMatchesPromotion: false,
      activeRows: 9,
      state: 'completed',
    });
  });

  test.each([
    [{ undeclared_code: 1 }],
    [{ declared_code: -1 }],
    [{ declared_code: 0.5 }],
  ])('refuses a check that answers %j', async (counts) => {
    await expect(
      decide({ registry: withCheck('declared_code', () => counts) }),
    ).rejects.toMatchObject({
      code: 'EXPORT_INVALID_DEFINITION',
      status: 500,
    });
  });

  test('refuses a calculation state readiness has no code for', async () => {
    await expect(
      decide({
        coordination: {
          ...current,
          domains: { ...current.domains, enrollments: 'stuck' },
        },
      }),
    ).rejects.toMatchObject({
      code: 'EXPORT_INVALID_READ',
      message: 'Readiness has no status code for enrollments_stuck',
    });
  });
});

describe('the registry decides every code once', () => {
  test.each(['enrollment_count_missing', 'snapshot_import_failed'])(
    'refuses a registry that declares %s a second time, before anything is read',
    async (code) => {
      const entry = readinessEntry(code);
      if (entry === undefined) {
        throw new Error(`${code} is not registered`);
      }
      const registry = [
        ...readinessRegistry,
        { ...entry, gates: [], severity: 'warning' as const },
      ];
      const log: SourceRead[] = [];

      expect(definitionProblems(exportDefinitions, registry)).toEqual([
        `readiness code ${code} is declared twice`,
      ]);
      await expect(
        decide({ log, registry, store: await importedStore() }),
      ).rejects.toMatchObject({ code: 'EXPORT_INVALID_DEFINITION' });
      expect(log).toEqual([]);
    },
  );

  test('runs a check several entries share once', async () => {
    const log: SourceRead[] = [];

    await decide({ log });

    const reads = log.map((read) => JSON.stringify(read));

    expect(new Set(reads).size).toBe(reads.length);
    // Once for the two codes of the enrollment check, once for the
    // professor check.
    expect(
      log.filter(({ collection }) => collection === 'course_enrollments'),
    ).toHaveLength(1);
    expect(
      log.filter(({ collection }) => collection === 'teaching_assignments'),
    ).toHaveLength(1);
  });
});

describe('the enrollment and curriculum checks of courses.json', () => {
  test('blocks an exported course and year without a count row', async () => {
    const counted = await decide({
      store: edit(
        await importedStore(),
        'course_enrollments',
        without((row) => row['course'] === 2 && row['academic_year'] === 3),
      ),
    });
    const newCourse = await decide({
      store: edit(
        await importedStore(),
        'courses',
        append([{ id: 50, name: 'Synthetic New Course' }]),
      ),
    });

    expect(counted.blockers).toEqual(['enrollment_count_missing']);
    expect(counted.issueCounts['enrollment_count_missing']).toBe(1);
    expect(newCourse.blockers).toEqual(['enrollment_count_missing']);
    expect(newCourse.issueCounts).toMatchObject({
      enrollment_count_missing: 15,
    });
    // No check of the removed enrollment rules is left.
    expect(
      Object.keys(newCourse.issueCounts).filter((code) =>
        code.includes('rule'),
      ),
    ).toEqual([]);
  });

  test('counts a published year without counts as missing for every course', async () => {
    const decision = await decide({
      store: edit(
        await importedStore(),
        'academic_years',
        append([{ id: 99, label: '2026/2027', published: true }]),
      ),
    });

    expect(decision.issueCounts).toMatchObject({
      enrollment_count_missing: 8,
    });
    expect(decision.blockedFiles).toEqual(['courses.json']);
  });

  test('blocks nothing for a new year until it is published', async () => {
    const decision = await decide({
      store: edit(
        await importedStore(),
        'academic_years',
        append([{ id: 99, label: '2026/2027', published: false }]),
      ),
    });

    expect(decision.ready).toBeTruthy();
  });

  test.each([
    [
      'a 2023 name that matches no entry',
      renamedCurrent(parityDataset()),
      'unmatched_curriculum_2023_label',
    ],
    [
      'a 2023 name without credits or availability that matches no entry',
      nameOnly(renamedCurrent(parityDataset())),
      'unmatched_curriculum_2023_label',
    ],
    [
      'a 2018 equivalency label that matches no entry',
      unmatchedLegacy(parityDataset()),
      'unmatched_curriculum_2018_label',
    ],
    [
      '2018 credits without any 2018 label',
      withCourse(parityDataset(), courseNames.gamma, { credits_2018: 6 }),
      'unlinked_generation_values',
    ],
  ])(
    'leaves %s, a value the published file would lose or merge, to the import, which refuses it',
    (_label, dataset, code) => {
      expect(planOf(dataset).blockers.map((blocker) => blocker.code)).toEqual([
        code,
      ]);
    },
  );
});

describe('the teaching and mapping checks of courses.json', () => {
  test('neither blocks nor warns on explicit mappings, and counts no history line', async () => {
    const store = await importedStore();
    edit(
      store,
      'moodle_course_entries',
      append(
        [1, 2, 3].map((id) => ({ id, label: `Synthetic Line ${String(id)}` })),
      ),
    );
    edit(store, 'academic_years', append([{ id: 99, label: '2026/2027' }]));
    edit(
      store,
      'moodle_course_mappings',
      append([
        { academic_year: 1, course: 1, entry: 1, id: 1 },
        { academic_year: 99, course: 1, entry: 3, id: 2 },
        { academic_year: 99, course: 1, entry: 1, id: 3 },
      ]),
    );
    const decision = await decide({ store });

    expect(rowsOf(store, 'moodle_course_mappings')).toHaveLength(3);
    expect(decision.ready).toBeTruthy();
    expect(decision.warnings).not.toContain('mapping_without_rule');
    expect(Object.keys(decision.issueCounts)).not.toContain(
      'mapping_without_rule',
    );
    expect(Object.keys(decision.issueCounts)).not.toContain(
      'entry_needs_mapping',
    );
    expect(Object.keys(decision.issueCounts)).not.toContain(
      'mapped_entry_awaiting_review',
    );
  });

  test('answers codes, counts and pages, never a name or a label', async () => {
    const decision = await decide({
      store: edit(
        await importedStore(),
        'teaching_assignments',
        without((row) => row['role'] === 'professor'),
      ),
    });
    const text = JSON.stringify(decision);

    expect(decision.blockers).toEqual(['course_without_professor']);
    expect(text).not.toMatch(recordText);
  });
});
