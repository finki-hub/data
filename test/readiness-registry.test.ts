import { describe, expect, test } from 'vitest';

import type { FakeItem } from './store-test-helpers.js';

import { unlinkedMember } from '../directus/extensions/directus-extension-data-operations/src/exports/curriculum-checks.js';
import { definitionReads } from '../directus/extensions/directus-extension-data-operations/src/exports/definitions-check.js';
import { exportDefinitions } from '../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import { keyOrderEntries } from '../directus/extensions/directus-extension-data-operations/src/exports/key-order.js';
import {
  preparePublicFiles,
  readinessAction,
} from '../directus/extensions/directus-extension-data-operations/src/exports/prepare.js';
import { usesSomeOrNone } from '../directus/extensions/directus-extension-data-operations/src/exports/read-rules.js';
import { readinessRegistry } from '../directus/extensions/directus-extension-data-operations/src/exports/readiness-registry.js';
import {
  type ReadinessEntry,
  severities,
} from '../directus/extensions/directus-extension-data-operations/src/exports/readiness-types.js';
import { decideReadiness } from '../directus/extensions/directus-extension-data-operations/src/exports/readiness.js';
import {
  registryProblems,
  registryReads,
} from '../directus/extensions/directus-extension-data-operations/src/exports/registry-rules.js';
import { findModelCollection } from '../src/data-model/collections.js';
import { reviewPresets } from '../src/data-model/presentation/presets.js';
import { storeReader } from '../src/projection/memory-reader.js';
import { edit, importedStore } from './relational-export-helpers.js';

const codes = readinessRegistry.map(({ code }) => code);

// A filter that names a generation row by its id.
const generationRowPattern = /"generation":\{"_(?:eq|in)"/u;
const filenames = exportDefinitions.map(({ filename }) => filename);

// Every filter the registry declares: its aggregates, its checks' reads
// and its review views.
const registryFilters = [
  ...registryReads(readinessRegistry).map(([, read]) => read.filter),
  ...readinessRegistry.flatMap(({ review }) =>
    review === undefined ? [] : [review.filter],
  ),
];

const deps = (store: Awaited<ReturnType<typeof importedStore>>) => ({
  coordination: () =>
    Promise.resolve({
      calculation: 'graph-a',
      domains: { enrollments: 'current', history_index: 'current' },
      revision: 7,
    }),
  now: () => 0,
  reader: storeReader(store),
  snapshot: () =>
    Promise.resolve({
      activeMatchesPromotion: true,
      activeRows: 9,
      state: 'completed',
    }),
});

// One entry of the registry changed, for the structural rules.
const changed = (
  code: string,
  change: Partial<ReadinessEntry>,
): ReadinessEntry[] =>
  readinessRegistry.map((entry) =>
    entry.code === code ? { ...entry, ...change } : entry,
  );

const append =
  (rows: readonly FakeItem[]) =>
  (existing: FakeItem[]): FakeItem[] => [...existing, ...rows];

// The generation-scoped entries whose page records carry no `generation`
// column, so no view of them could show or filter one.
const unscopable = (registry: readonly ReadinessEntry[]): string[] =>
  registry
    .filter(
      ({ generationScoped, page }) =>
        generationScoped &&
        !(
          findModelCollection(page)?.fields.some(
            ({ field }) => field === 'generation',
          ) ?? false
        ),
    )
    .map(({ code }) => code);

describe('the readiness-check registry', () => {
  test('declares every code once, in snake case, with a severity from the closed set', () => {
    expect(new Set(codes).size).toBe(codes.length);
    expect(severities).toEqual(['blocker', 'warning']);
    expect(
      readinessRegistry.filter(
        ({ severity }) => !severities.includes(severity),
      ),
    ).toEqual([]);
    expect(registryProblems(readinessRegistry, filenames)).toEqual([]);
  });

  test('filters without any _some or _none block (follow-up 35)', () => {
    expect(registryFilters.length).toBeGreaterThan(5);
    expect(registryFilters.filter((filter) => usesSomeOrNone(filter))).toEqual(
      [],
    );
    expect(
      exportDefinitions
        .flatMap(definitionReads)
        .filter(([, read]) => usesSomeOrNone(read.filter)),
    ).toEqual([]);
  });

  test('names one Needs review bookmark per name and installs exactly those', () => {
    const reviewed = readinessRegistry.flatMap(({ page, review }) =>
      review === undefined ? [] : [{ page, review }],
    );
    const bookmarks = reviewed.map(({ review }) => review.bookmark);

    expect(new Set(bookmarks).size).toBe(bookmarks.length);
    expect(reviewPresets()).toEqual(
      reviewed.map(({ page, review }) => ({
        bookmark: review.bookmark,
        collection: page,
        filter: review.filter,
        icon: review.icon ?? findModelCollection(page)?.icon,
        layout: 'tabular',
        layout_options: { tabular: { spacing: 'comfortable' } },
        layout_query: {
          tabular: {
            fields: review.fields,
            limit: 50,
            page: 1,
            sort: review.sort,
          },
        },
        role: null,
        search: null,
        user: null,
      })),
    );
    expect(
      reviewPresets().find(({ bookmark }) => bookmark === 'Needs mapping'),
    ).toMatchObject({
      collection: 'moodle_course_entries',
      filter: {
        _and: [
          { review_state: { _eq: 'needs_mapping' } },
          { mappings: { id: { _null: true } } },
        ],
      },
      layout_query: { tabular: { fields: ['label', 'review_reason'] } },
    });
  });

  test('shows curriculum views by generation and program views by generation and name', () => {
    const views = new Map(
      readinessRegistry.flatMap(({ code, review }) =>
        review === undefined ? [] : [[code, review]],
      ),
    );
    const scoped = readinessRegistry.filter(
      ({ generationScoped, review }) =>
        generationScoped && review !== undefined,
    );

    expect(scoped.map(({ code }) => code)).toEqual([
      'study_program_unsorted',
      'equivalency_entry_unresolved',
    ]);

    for (const { review } of scoped) {
      expect(review?.fields[0]).toBe('generation');
      // Through the relation, never one generation row by its id.
      expect(JSON.stringify(review?.filter)).not.toMatch(generationRowPattern);
    }

    expect(views.get('study_program_unsorted')).toMatchObject({
      bookmark: 'Published study programs without a sort',
      fields: ['generation', 'code', 'name', 'sort', 'published'],
    });
    expect(views.get('equivalency_entry_unresolved')?.filter).toEqual(
      unlinkedMember,
    );
  });

  test('holds the initial entries of the plan with their severity and source', () => {
    const declared = new Map(
      readinessRegistry.map((entry) => [
        entry.code,
        `${entry.severity}/${entry.source.kind}`,
      ]),
    );

    expect(Object.fromEntries(declared)).toMatchObject({
      academic_year_sort_shared: 'blocker/check',
      academic_year_unsorted: 'blocker/count',
      active_snapshot_edited: 'warning/snapshot',
      council_member_unresolved: 'warning/count',
      course_without_professor: 'blocker/check',
      enrollment_count_missing: 'blocker/check',
      enrollments_failed: 'blocker/status',
      enrollments_pending: 'blocker/status',
      entry_needs_mapping: 'warning/check',
      equivalency_entry_unresolved: 'warning/count',
      history_index_failed: 'blocker/status',
      history_index_pending: 'blocker/status',
      mapping_without_rule: 'warning/check',
      snapshot_import_failed: 'blocker/snapshot',
    });
  });

  test('checks teaching links only for an Active course without a professor, with no bookmark on them', () => {
    expect(
      readinessRegistry
        .filter(
          ({ code, page }) =>
            code.startsWith('assignment_') || page === 'teaching_assignments',
        )
        .map(({ code }) => code),
    ).toEqual([]);
    expect(
      reviewPresets(readinessRegistry).filter(
        ({ collection }) => collection === 'teaching_assignments',
      ),
    ).toEqual([]);
    expect(
      readinessRegistry.find(({ code }) => code === 'course_without_professor'),
    ).toMatchObject({ page: 'courses', severity: 'blocker' });
  });

  test('derives two order blockers for every key source a definition places, linking its collection', () => {
    expect(
      keyOrderEntries.map(({ code, gates, page, severity, source }) => [
        code,
        page,
        source.kind,
        severity,
        gates,
      ]),
    ).toEqual(
      ['academic_year', 'curriculum_generation', 'study_program'].flatMap(
        (row) => [
          [`${row}_unsorted`, `${row}s`, 'count', 'blocker', ['courses.json']],
          [
            `${row}_sort_shared`,
            `${row}s`,
            'check',
            'blocker',
            ['courses.json'],
          ],
        ],
      ),
    );
    expect(readinessRegistry).toEqual(
      expect.arrayContaining([...keyOrderEntries]),
    );
    // The year blocker counts what the Task 23 entry counted.
    expect(keyOrderEntries[0]?.source).toEqual({
      aggregate: 'count',
      field: 'id',
      filter: {
        _and: [{ published: { _eq: true } }, { sort: { _null: true } }],
      },
      kind: 'count',
    });
  });

  test('scopes an entry to a generation only where its page records carry one', () => {
    expect(unscopable(readinessRegistry)).toEqual([]);
    expect(
      unscopable(
        changed('equivalency_without_course', { generationScoped: true }),
      ),
    ).toEqual(['equivalency_without_course']);
    expect(
      readinessRegistry
        .filter(({ page }) =>
          ['course_equivalencies', 'courses'].includes(page),
        )
        .map(({ generationScoped }) => generationScoped),
    ).not.toContain(true);
  });
});

describe('the registry rules', () => {
  test.each<readonly [string, ReadinessEntry[], string]>([
    [
      'a code declared twice',
      [...readinessRegistry, ...readinessRegistry.slice(0, 1)],
      'readiness code history_index_pending is declared twice',
    ],
    [
      'a blocker gating no file',
      changed('enrollment_rule_missing', { gates: [] }),
      'blocker enrollment_rule_missing gates no file',
    ],
    [
      'a warning gating a file',
      changed('snapshot_staged', { gates: ['courses.json'] }),
      'warning snapshot_staged gates a file',
    ],
    [
      'a gate no definition publishes',
      changed('enrollment_rule_missing', { gates: ['programs.json'] }),
      'readiness code enrollment_rule_missing gates programs.json, which no definition publishes',
    ],
    [
      'a code not in snake case',
      changed('snapshot_staged', { code: 'Snapshot Staged' }),
      'readiness code Snapshot Staged is not snake case',
    ],
    [
      'an empty description',
      changed('snapshot_staged', { description: ' ' }),
      'readiness code snapshot_staged has no description',
    ],
    [
      'two reviews of one bookmark',
      changed('mapped_entry_awaiting_review', {
        review: {
          bookmark: 'Needs mapping',
          fields: ['label'],
          filter: {},
          sort: ['label'],
        },
      }),
      'two readiness reviews share the bookmark Needs mapping',
    ],
    [
      'a review filter with _some',
      changed('entry_needs_mapping', {
        review: {
          bookmark: 'Needs mapping',
          fields: ['label'],
          filter: {
            mappings: {
              _some: { course: { _null: true }, entry: { _null: true } },
            },
          },
          sort: ['label'],
        },
      }),
      'review of entry_needs_mapping filters with _some or _none',
    ],
    [
      'a generation-scoped review that hides the generation',
      changed('equivalency_entry_unresolved', {
        generationScoped: true,
        review: {
          bookmark: 'Equivalency labels without an entry',
          fields: ['label', 'equivalency'],
          filter: unlinkedMember,
          sort: ['equivalency'],
        },
      }),
      'generation-scoped review of equivalency_entry_unresolved does not show the generation',
    ],
    [
      'a view filtering otherwise than its count',
      changed('council_member_unresolved', {
        review: {
          bookmark: 'Council members without a student',
          fields: ['index_number'],
          filter: { student: { _nnull: true } },
          sort: ['index_number'],
        },
      }),
      'review of council_member_unresolved filters otherwise than its count',
    ],
  ])('names %s', (_label, registry, problem) => {
    expect(registryProblems(registry, filenames)).toContain(problem);
  });
});

describe('readiness derived from the registry', () => {
  test('answers a count for exactly the registered codes', async () => {
    const answer = await readinessAction(
      exportDefinitions,
      deps(await importedStore()),
    );
    const empty = await readinessAction(
      exportDefinitions,
      deps({ items: new Map() }),
    );

    expect(Object.keys(answer.issueCounts)).toEqual(codes);
    expect(Object.keys(empty.issueCounts)).toEqual(codes);
    expect(empty.ready).toBeTruthy();
  });

  test('is not ready exactly when a blocker counts above zero', () => {
    const none = decideReadiness(1, new Map());

    expect(none.ready).toBeTruthy();

    const decided = readinessRegistry.map(({ code }) => {
      const decision = decideReadiness(1, new Map([[code, 3]]));
      return {
        blockedFiles: decision.blockedFiles,
        code,
        count: decision.issueCounts[code],
        ready: decision.ready,
      };
    });

    expect(decided).toEqual(
      readinessRegistry.map(({ code, gates, severity }) => ({
        blockedFiles: severity === 'blocker' ? gates : [],
        code,
        count: 3,
        ready: severity !== 'blocker',
      })),
    );
  });

  test('warns about a mapping without a rule, with its page and review, and still prepares every file', async () => {
    const store = await importedStore();
    edit(
      store,
      'moodle_course_entries',
      append([{ id: 1, review_state: 'needs_mapping' }]),
    );
    edit(
      store,
      'academic_years',
      append([{ id: 99, label: '2026/2027', published: false, sort: 16 }]),
    );
    edit(
      store,
      'moodle_course_mappings',
      append([{ academic_year: 99, course: 1, entry: 1, id: 1 }]),
    );

    const answer = await readinessAction(exportDefinitions, deps(store));
    const prepared = await preparePublicFiles(exportDefinitions, deps(store));

    expect(answer).toMatchObject({
      issueCounts: { mapping_without_rule: 1 },
      links: {
        mapping_without_rule: '/admin/content/moodle_course_mappings',
      },
      ready: true,
    });
    expect(answer.warnings).toContain('mapping_without_rule');
    expect(answer.blockers).toEqual([]);
    expect(prepared.warnings).toContain('mapping_without_rule');
    expect(prepared.files.map(({ filename }) => filename)).toEqual(filenames);
  });

  test('names the Needs review bookmark of a positive code that declares one', async () => {
    const store = edit(
      await importedStore(),
      'moodle_course_entries',
      append([{ id: 1, review_state: 'needs_mapping' }]),
    );

    const answer = await readinessAction(exportDefinitions, deps(store));

    expect(answer.reviews).toEqual({
      // The imported fixture keeps an unmatched council index, two
      // equivalency labels without an entry (a generation-scoped review,
      // follow-up 51) and three equivalencies without a course.
      council_member_unresolved: 'Council members without a student',
      entry_needs_mapping: 'Needs mapping',
      equivalency_entry_unresolved: 'Equivalency labels without an entry',
      equivalency_without_course: 'Equivalencies without a course',
    });
  });
});
