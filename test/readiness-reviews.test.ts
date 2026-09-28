import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { ReadinessEntry } from '../directus/extensions/directus-extension-data-operations/src/exports/readiness-types.js';
import type { FakeItem, FakeStore } from './store-test-helpers.js';

import { exportDefinitions } from '../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import { readinessAction } from '../directus/extensions/directus-extension-data-operations/src/exports/prepare.js';
import { readinessRegistry } from '../directus/extensions/directus-extension-data-operations/src/exports/readiness-registry.js';
import {
  edit,
  generationIdOf,
  importedStore,
  storeReader,
} from './relational-export-helpers.js';

// The Needs review views against the counts they explain: over synthetic
// stores, a view lists exactly the records its entry counts (for a
// countDistinct, rows whose distinct values are the count). It runs the
// view's own filter through the same fake reader as readiness, which
// follows O2M paths as the LEFT JOINs Directus runs.

const rowList = z.array(z.record(z.string(), z.unknown()));

type Reviewed = ReadinessEntry & {
  readonly review: NonNullable<ReadinessEntry['review']>;
};

const reviewed = readinessRegistry.filter(
  (entry): entry is Reviewed => entry.review !== undefined,
);

const deps = (store: FakeStore) => ({
  coordination: () =>
    Promise.resolve({
      calculation: 'graph-a',
      domains: { enrollments: 'current', history_index: 'current' },
      revision: 3,
    }),
  reader: storeReader(store),
  snapshot: () =>
    Promise.resolve({
      activeMatchesPromotion: true,
      activeRows: 0,
      state: 'completed',
    }),
});

const append =
  (rows: readonly FakeItem[]) =>
  (existing: FakeItem[]): FakeItem[] => [...existing, ...rows];

const withValues =
  (id: number, values: Readonly<Record<string, unknown>>) =>
  (rows: FakeItem[]): FakeItem[] =>
    rows.map((row) => (row.id === id ? { ...row, ...values } : row));

// A synthetic assignment row of course 1: an assistant without staff.
const assignment = (id: number, values: Readonly<Record<string, unknown>>) => ({
  course: 1,
  display_override: null,
  id,
  role: 'assistant',
  sort: id,
  staff: null,
  ...values,
});

// Every counted record kind at least once: history entries with and
// without mappings, assignment rows of each kind (and the professors an
// override replaces, which count nowhere), a published year, generation
// and program without a sort, and a council member and an equivalency with
// an empty link.
const everyIssue = async (): Promise<FakeStore> => {
  const store = await importedStore();
  const legacy = generationIdOf(store, '2018');
  edit(
    store,
    'moodle_course_entries',
    append(
      [1, 2, 3, 4].map((id) => ({
        id,
        label: `Synthetic Line ${String(id)}`,
        review_state: id === 3 ? 'mapped' : 'needs_mapping',
      })),
    ),
  );
  edit(
    store,
    'moodle_course_mappings',
    append([
      { academic_year: 1, course: 1, entry: 2, id: 1 },
      { academic_year: 2, course: 1, entry: 2, id: 2 },
      { academic_year: 1, course: 2, entry: 3, id: 3 },
    ]),
  );
  edit(store, 'courses', withValues(2, { professors_override: 'Override' }));
  edit(
    store,
    'teaching_assignments',
    append([
      assignment(901, { role: null }),
      assignment(902, { role: 'lecturer' }),
      assignment(903, {}),
      assignment(904, { display_override: '', role: 'professor' }),
      assignment(905, { course: 2, role: 'professor' }),
      assignment(906, { display_override: 'Synthetic Label' }),
      assignment(907, {
        course: 2,
        display_override: 'Hidden',
        role: 'professor',
      }),
    ]),
  );
  edit(
    store,
    'academic_years',
    append([{ id: 99, label: '2090/2091', published: true, sort: null }]),
  );
  edit(
    store,
    'curriculum_generations',
    append([
      {
        code: '2088',
        has_curriculum: true,
        id: 9,
        label: 'Curriculum 2088',
        published: true,
        sort: null,
      },
    ]),
  );
  edit(
    store,
    'study_programs',
    append([
      {
        code: 'zz',
        generation: legacy,
        id: 99,
        name: 'Synthetic Program',
        published: true,
        sort: null,
      },
    ]),
  );
  edit(
    store,
    'student_council',
    append([
      {
        id: 99,
        index_number: 'SYN-8888',
        position: 'Member',
        student: null,
        year: 2_025,
      },
    ]),
  );
  edit(store, 'course_equivalencies', append([{ course: null, id: 99 }]));
  return store;
};

// The rows a view lists, with the field its count distinguishes.
const listed = async (store: FakeStore, entry: Reviewed) => {
  const distinct =
    entry.source.kind === 'count' && entry.source.aggregate === 'countDistinct'
      ? entry.source.field
      : undefined;
  const rows = rowList.parse(
    await storeReader(store)({
      collection: entry.page,
      fields: ['id', ...(distinct === undefined ? [] : [distinct])],
      filter: entry.review.filter,
      sort: ['id'],
    }),
  );
  return { distinct, rows };
};

const countedBy = async (store: FakeStore, entry: Reviewed) => {
  const { distinct, rows } = await listed(store, entry);
  return distinct === undefined
    ? rows.length
    : new Set(rows.map((row) => row[distinct])).size;
};

describe('the Needs review views', () => {
  test.each([
    ['the imported parity fixture', importedStore],
    ['a store holding every counted issue', everyIssue],
  ])(
    'list exactly what each counted entry counts in %s',
    async (_label, build) => {
      const store = await build();
      const { issueCounts } = await readinessAction(
        exportDefinitions,
        deps(store),
      );
      const compared = await Promise.all(
        reviewed.map(async (entry) => ({
          code: entry.code,
          count: issueCounts[entry.code],
          listed: await countedBy(store, entry),
        })),
      );

      expect(compared).toEqual(
        reviewed.map(({ code }) => ({
          code,
          count: issueCounts[code],
          listed: issueCounts[code],
        })),
      );
    },
  );

  test('find something to list for every counted entry in the store holding every issue', async () => {
    const store = await everyIssue();
    const { issueCounts } = await readinessAction(
      exportDefinitions,
      deps(store),
    );

    expect(
      reviewed
        .filter(({ code }) => (issueCounts[code] ?? 0) === 0)
        .map(({ code }) => code),
    ).toEqual([]);
    expect(issueCounts).toMatchObject({
      assignment_review_label: 7,
      assignment_role_missing: 2,
      assignment_unresolved: 2,
      entry_needs_mapping: 2,
      mapped_entry_awaiting_review: 1,
    });
  });
});
