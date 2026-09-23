import { describe, expect, test } from 'vitest';

import type { FakeItem } from './migration-test-helpers.js';

import { definitionReads } from '../directus/extensions/directus-extension-data-operations/src/exports/definitions-check.js';
import { exportDefinitions } from '../directus/extensions/directus-extension-data-operations/src/exports/index.js';
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
import { reviewBookmarks } from '../src/data-model/presentation/presets.js';
import {
  activeSnapshotEdited,
  snapshotImportFailed,
} from '../src/editor-policy.js';
import {
  convertedStore,
  edit,
  storeReader,
} from './relational-export-helpers.js';

const codes = readinessRegistry.map(({ code }) => code);
const filenames = exportDefinitions.map(({ filename }) => filename);

// Every filter the registry declares: its aggregates, its checks' reads
// and its review views.
const registryFilters = [
  ...registryReads(readinessRegistry).map(([, read]) => read.filter),
  ...readinessRegistry.flatMap(({ review }) =>
    review === undefined ? [] : [review.filter],
  ),
];

const deps = (store: Awaited<ReturnType<typeof convertedStore>>) => ({
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
    const bookmarks = readinessRegistry.flatMap(({ review }) =>
      review === undefined ? [] : [review.bookmark],
    );

    expect(new Set(bookmarks).size).toBe(bookmarks.length);
    expect(reviewBookmarks.map(({ bookmark }) => bookmark)).toEqual(bookmarks);
    expect(reviewBookmarks).toEqual([
      {
        bookmark: 'Needs mapping',
        collection: 'moodle_course_entries',
        filter: { review_state: { _eq: 'needs_mapping' } },
        icon: 'alt_route',
        layout: 'tabular',
        layout_options: { tabular: { spacing: 'comfortable' } },
        layout_query: {
          tabular: {
            fields: ['label', 'review_reason'],
            limit: 50,
            page: 1,
            sort: ['label'],
          },
        },
        role: null,
        search: null,
        user: null,
      },
    ]);
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
      assignment_unresolved: 'blocker/check',
      council_member_unresolved: 'warning/count',
      curriculum_link_unresolved: 'blocker/check',
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

  test('scopes an entry to a generation only where its page records carry one', () => {
    expect(unscopable(readinessRegistry)).toEqual([]);
    expect(
      unscopable(
        changed('curriculum_link_unresolved', { generationScoped: true }),
      ),
    ).toEqual(['curriculum_link_unresolved']);
    expect(
      readinessRegistry
        .filter(({ page }) =>
          ['course_equivalencies', 'courses'].includes(page),
        )
        .map(({ generationScoped }) => generationScoped),
    ).not.toContain(true);
  });

  test('registers the snapshot codes the editor policy reports', () => {
    expect([activeSnapshotEdited, snapshotImportFailed]).toEqual([
      'active_snapshot_edited',
      'snapshot_import_failed',
    ]);
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
      changed('conversion_incomplete', { gates: [] }),
      'blocker conversion_incomplete gates no file',
    ],
    [
      'a warning gating a file',
      changed('snapshot_staged', { gates: ['courses.json'] }),
      'warning snapshot_staged gates a file',
    ],
    [
      'a gate no definition publishes',
      changed('conversion_incomplete', { gates: ['programs.json'] }),
      'readiness code conversion_incomplete gates programs.json, which no definition publishes',
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
      changed('curriculum_link_unresolved', {
        generationScoped: true,
        review: {
          bookmark: 'Unresolved curriculum links',
          fields: ['course', 'course_2018'],
          filter: { course: { _nnull: true } },
          sort: ['course'],
        },
      }),
      'generation-scoped review of curriculum_link_unresolved does not show the generation',
    ],
  ])('names %s', (_label, registry, problem) => {
    expect(registryProblems(registry, filenames)).toContain(problem);
  });
});

describe('readiness derived from the registry', () => {
  test('answers a count for exactly the registered codes', async () => {
    const answer = await readinessAction(
      exportDefinitions,
      deps(await convertedStore()),
    );
    const empty = await readinessAction(
      exportDefinitions,
      deps({ flows: [], items: new Map(), limitMax: null, operations: [] }),
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
    const store = await convertedStore();
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
      await convertedStore(),
      'moodle_course_entries',
      append([{ id: 1, review_state: 'needs_mapping' }]),
    );

    const answer = await readinessAction(exportDefinitions, deps(store));

    expect(answer.reviews).toEqual({ entry_needs_mapping: 'Needs mapping' });
  });
});
