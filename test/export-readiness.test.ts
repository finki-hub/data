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
import type { FakeItem, FakeStore } from './migration-test-helpers.js';

import { definitionProblems } from '../directus/extensions/directus-extension-data-operations/src/exports/definitions-check.js';
import {
  coordinationFacts,
  snapshotFacts,
} from '../directus/extensions/directus-extension-data-operations/src/exports/directus.js';
import { exportDefinitions } from '../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import { readinessAction } from '../directus/extensions/directus-extension-data-operations/src/exports/prepare.js';
import {
  readinessEntry,
  readinessRegistry,
} from '../directus/extensions/directus-extension-data-operations/src/exports/readiness-registry.js';
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
import {
  convertedStore,
  edit,
  parityDataset,
  renamedCurrent,
  storeReader,
  unmatchedLegacy,
  withLinkedLabel,
} from './relational-export-helpers.js';
import { rowsOf } from './relational-migration-helpers.js';

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
        situation.store ?? (await convertedStore()),
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

const assignmentRow = (id: number, values: Partial<FakeItem>): FakeItem => ({
  course: 7,
  display_override: null,
  id,
  role: 'assistant',
  sort: 5,
  staff: null,
  ...values,
});

const recordText = /Synthetic|Prof\.|Asst\.|Course|@/u;

// The course's name_2018_override set to the label.
const withOverride =
  (course: number, label: string) =>
  (rows: FakeItem[]): FakeItem[] =>
    rows.map((row) =>
      row.id === course ? { ...row, name_2018_override: label } : row,
    );

// The course's columns set to the values.
const withValues =
  (course: number, values: Readonly<Record<string, unknown>>) =>
  (rows: FakeItem[]): FakeItem[] =>
    rows.map((row) => (row.id === course ? { ...row, ...values } : row));

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

// The warnings of the converted parity fixture: its three equivalencies
// without a course, its two equivalency labels without an entry (Alpha's
// decoy 2018 label, the orphan 2023 label), the six review labels of its
// assignments and its council member whose index matched no student.
const baselineWarnings = {
  assignment_review_label: 6,
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
        assignment_review_label: '/admin/content/teaching_assignments',
        council_member_unresolved: '/admin/content/student_council',
        equivalency_entry_unresolved: '/admin/content/course_equivalencies',
        equivalency_without_course: '/admin/content/course_equivalencies',
      },
      ready: true,
      reviews: {},
      revision: 42,
      warnings: [
        'equivalency_without_course',
        'equivalency_entry_unresolved',
        'assignment_review_label',
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
      calculation: fake.fingerprint,
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

  test('blocks a one-time conversion step that is still running or failed', async () => {
    const store = edit(
      await convertedStore(),
      'migration_ledger',
      append([{ id: 900, status: 'failed', step: 'assignments' }]),
    );
    const decision = await decide({ store });

    expect(decision.blockers).toEqual(['conversion_incomplete']);
    expect(decision.links['conversion_incomplete']).toBe(
      '/admin/content/migration_ledger',
    );
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
        decide({ log, registry, store: await convertedStore() }),
      ).rejects.toMatchObject({ code: 'EXPORT_INVALID_DEFINITION' });
      expect(log).toEqual([]);
    },
  );

  test('runs a check several entries share once', async () => {
    const log: SourceRead[] = [];

    await decide({ log });

    const reads = log.map((read) => JSON.stringify(read));

    expect(new Set(reads).size).toBe(reads.length);
    expect(
      log.filter(({ collection }) => collection === 'teaching_assignments'),
    ).toHaveLength(1);
  });
});

describe('the enrollment and curriculum checks of courses.json', () => {
  test('blocks an exported course and year without a count row, and names a missing rule apart', async () => {
    const counted = await decide({
      store: edit(
        await convertedStore(),
        'course_enrollments',
        without((row) => row['course'] === 2 && row['academic_year'] === 3),
      ),
    });
    const newCourse = await decide({
      store: edit(
        await convertedStore(),
        'courses',
        append([{ id: 50, name: 'Synthetic New Course' }]),
      ),
    });

    expect(counted.blockers).toEqual(['enrollment_count_missing']);
    expect(counted.issueCounts['enrollment_count_missing']).toBe(1);
    expect(newCourse.blockers).toEqual([
      'enrollment_count_missing',
      'enrollment_rule_missing',
    ]);
    expect(newCourse.issueCounts).toMatchObject({
      enrollment_count_missing: 15,
      enrollment_rule_missing: 15,
    });
  });

  test('counts a published year without counts or rules as missing for every course', async () => {
    const decision = await decide({
      store: edit(
        await convertedStore(),
        'academic_years',
        append([{ id: 99, label: '2026/2027', published: true, sort: 16 }]),
      ),
    });

    expect(decision.issueCounts).toMatchObject({
      enrollment_count_missing: 8,
      enrollment_rule_missing: 8,
    });
    expect(decision.blockedFiles).toEqual(['courses.json']);
  });

  test('blocks nothing for a new year until it is published', async () => {
    const decision = await decide({
      store: edit(
        await convertedStore(),
        'academic_years',
        append([{ id: 99, label: '2026/2027', published: false, sort: 16 }]),
      ),
    });

    expect(decision.ready).toBeTruthy();
  });

  test('blocks a published year without a sort, which has no place among the year keys', async () => {
    const decision = await decide({
      store: edit(
        await convertedStore(),
        'academic_years',
        withValues(1, { sort: null }),
      ),
    });

    expect(decision.blockers).toEqual(['academic_year_unsorted']);
    expect(decision.issueCounts['academic_year_unsorted']).toBe(1);
    expect(decision.links['academic_year_unsorted']).toBe(
      '/admin/content/academic_years',
    );
  });

  test('blocks two published years that share a sort, whose keys have no order, but not an unpublished one', async () => {
    const shared = await decide({
      store: edit(
        await convertedStore(),
        'academic_years',
        withValues(2, { sort: 15 }),
      ),
    });

    expect(shared.blockers).toEqual(['academic_year_sort_shared']);
    expect(shared.issueCounts['academic_year_sort_shared']).toBe(1);
    expect(shared.links['academic_year_sort_shared']).toBe(
      '/admin/content/academic_years',
    );
    expect(shared.blockedFiles).toEqual(['courses.json']);

    const unpublished = await decide({
      store: edit(
        await convertedStore(),
        'academic_years',
        append([{ id: 99, label: '2026/2027', published: false, sort: 15 }]),
      ),
    });

    expect(unpublished.issueCounts['academic_year_sort_shared']).toBe(0);
    expect(unpublished.ready).toBeTruthy();
  });

  test('blocks a 2018 entry an equivalency names while the course has neither the link nor an override, and 2018 values without the link', async () => {
    const store = edit(
      await convertedStore(),
      'course_curricula',
      without((link) => link['course'] === 7 && link['generation'] === '2018'),
    );
    const blocked = await decide({ store });

    expect(blocked.blockers).toEqual([
      'curriculum_link_unresolved',
      'curriculum_value_unlinked',
    ]);
    expect(blocked.links).toMatchObject({
      curriculum_link_unresolved: '/admin/content/course_equivalencies',
      curriculum_value_unlinked: '/admin/content/courses',
    });

    // The override settles the 2018 name; Theta's imported 2018 credits
    // and availability still have no link to be published from.
    edit(store, 'courses', withOverride(7, 'Theta Legacy'));

    await expect(decide({ store })).resolves.toMatchObject({
      blockers: ['curriculum_value_unlinked'],
      issueCounts: { curriculum_value_unlinked: 1 },
    });

    edit(
      store,
      'courses',
      withValues(7, { available_2018: null, credits_2018: null }),
    );

    await expect(decide({ store })).resolves.toMatchObject({ ready: true });
  });

  test.each([
    [
      'a 2023 name that matched no entry',
      renamedCurrent(parityDataset()),
      { curriculum_value_unlinked: 1 },
    ],
    [
      'a 2023 name without credits or availability that matched no entry',
      nameOnly(renamedCurrent(parityDataset())),
      { curriculum_value_unlinked: 1 },
    ],
    [
      'a 2018 equivalency label that matched no entry',
      unmatchedLegacy(parityDataset()),
      { curriculum_link_unresolved: 1, curriculum_value_unlinked: 1 },
    ],
    [
      'a 2018 availability without any 2018 label',
      parityDataset({ gammaAvailability: true }),
      { curriculum_value_unlinked: 1 },
    ],
  ])(
    'blocks %s, a value the legacy file publishes and no link holds',
    async (_label, dataset, blockers) => {
      const decision = await decide({ store: await convertedStore(dataset) });

      expect(decision.ready).toBeFalsy();
      expect(
        Object.fromEntries(
          decision.blockers.map((code) => [code, decision.issueCounts[code]]),
        ),
      ).toEqual(blockers);
    },
  );

  test('settles an imported value once the course is linked, or once the value is cleared', async () => {
    const linked = await decide({
      store: withLinkedLabel(
        await convertedStore(renamedCurrent(parityDataset())),
        8,
        '2023',
      ),
    });
    const cleared = await decide({
      store: edit(
        await convertedStore(renamedCurrent(parityDataset())),
        'courses',
        withValues(8, {
          available_2023: null,
          credits_2023: null,
          name_2023: '',
        }),
      ),
    });

    expect(linked.ready).toBeTruthy();
    expect(cleared.ready).toBeTruthy();
  });
});

describe('the assignment and mapping checks of courses.json', () => {
  test('blocks published assignment rows without a role or a label, and ignores professors an override replaces', async () => {
    const decision = await decide({
      store: edit(
        await convertedStore(),
        'teaching_assignments',
        append([
          assignmentRow(500, { role: null }),
          assignmentRow(501, {}),
          assignmentRow(502, { course: 2, role: 'professor' }),
        ]),
      ),
    });

    expect(decision.blockers).toEqual([
      'assignment_role_missing',
      'assignment_unresolved',
    ]);
    expect(decision.issueCounts).toMatchObject({
      assignment_role_missing: 1,
      assignment_unresolved: 1,
    });
  });

  test('blocks a course whose published list merges two imported assignment rows until one is removed', async () => {
    const store = await convertedStore(
      parityDataset({ duplicateAssignment: true }),
    );
    const merged = await decide({ store });

    expect(merged.blockers).toEqual(['assignment_source_duplicate']);
    expect(merged.issueCounts).toMatchObject({
      assignment_order_ambiguous: 2,
      assignment_source_duplicate: 1,
    });
    expect(merged.links['assignment_source_duplicate']).toBe(
      '/admin/content/teaching_assignments',
    );

    edit(
      store,
      'teaching_assignments',
      without((row) => row['source_id'] === 2),
    );

    await expect(decide({ store })).resolves.toMatchObject({
      issueCounts: baselineWarnings,
      ready: true,
    });
  });

  test('blocks the merged list of assistants when an override replaces the professors', async () => {
    const store = edit(
      await convertedStore(parityDataset({ duplicateAssignment: true })),
      'courses',
      withValues(1, { professors_override: 'Synthetic Override' }),
    );

    await expect(decide({ store })).resolves.toMatchObject({
      blockers: ['assignment_source_duplicate'],
      issueCounts: { assignment_order_ambiguous: 1 },
    });
  });

  test('warns, never blocks, about rows added in Studio that share a position', async () => {
    const decision = await decide({
      store: edit(
        await convertedStore(),
        'teaching_assignments',
        append([
          assignmentRow(500, { staff: 5 }),
          assignmentRow(501, { staff: 6 }),
        ]),
      ),
    });

    expect(decision.ready).toBeTruthy();
    expect(decision.issueCounts['assignment_order_ambiguous']).toBe(1);
  });

  test('warns about mappings no rule counts and entries awaiting review, never blocking on them', async () => {
    const store = await convertedStore();
    edit(
      store,
      'moodle_course_entries',
      append(
        [1, 2, 3].map((id) => ({
          id,
          review_state: id === 3 ? 'mapped' : 'needs_mapping',
        })),
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
    expect(decision.issueCounts).toMatchObject({
      entry_needs_mapping: 1,
      mapped_entry_awaiting_review: 1,
      mapping_without_rule: 2,
    });
  });

  test('answers codes, counts and pages, never a name or a label', async () => {
    const decision = await decide({
      store: edit(
        await convertedStore(),
        'teaching_assignments',
        append([assignmentRow(501, {})]),
      ),
    });
    const text = JSON.stringify(decision);

    expect(text).not.toMatch(recordText);
  });
});
