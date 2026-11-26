import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';

import {
  type IsolatedTarget,
  isolatedTarget,
  targetFrom,
} from './isolated-target.js';
import {
  anonymousSearch,
  options,
  response,
  search,
  searchResponse,
  type SearchRow,
  withSearchFixture,
} from './search-integration-helpers.js';

// The course-search endpoint against an isolated target with a synthetic
// moodle_users collection (search-fixture.ts), created per test.

const missingUrlPattern = /DIRECTUS_SEARCH_TEST_URL/u;
const loopbackPattern = /loopback-only/u;
const disposablePattern = /not disposable/u;
const syntheticPattern = /not synthetic/u;
const markerPattern = /Target marker must exist exactly once/u;
const validTarget = {
  DIRECTUS_SEARCH_TEST_MARKER_COLLECTION: 'synthetic_search_marker_test',
  DIRECTUS_SEARCH_TEST_MARKER_VALUE: 'synthetic-test',
  DIRECTUS_SEARCH_TEST_TOKEN: 'token',
  DIRECTUS_SEARCH_TEST_URL: 'http://127.0.0.1:18055',
};
const names = (rows: readonly SearchRow[]) => rows.map(({ Name }) => Name);
const collator = new Intl.Collator('en');
const errorBody = z.object({ errors: z.array(z.unknown()) });

test('requires an explicit loopback URL, token, and synthetic marker', () => {
  assert.throws(() => targetFrom({}), missingUrlPattern);
  assert.throws(
    () =>
      targetFrom({
        ...validTarget,
        DIRECTUS_SEARCH_TEST_URL: 'https://example.com',
      }),
    loopbackPattern,
  );
  assert.throws(
    () =>
      targetFrom({
        ...validTarget,
        DIRECTUS_SEARCH_TEST_URL: 'http://localhost:18055',
      }),
    loopbackPattern,
  );
  assert.throws(
    () =>
      targetFrom({
        ...validTarget,
        DIRECTUS_SEARCH_TEST_MARKER_COLLECTION: 'moodle_users',
      }),
    disposablePattern,
  );
  assert.throws(
    () =>
      targetFrom({
        ...validTarget,
        DIRECTUS_SEARCH_TEST_MARKER_VALUE: 'real-marker',
      }),
    syntheticPattern,
  );
  assert.equal(
    targetFrom({ ...validTarget, DIRECTUS_SEARCH_TEST_URL: 'http://[::1]:1/' })
      .base.hostname,
    '[::1]',
  );
});

test('refuses a target without the marker it was given before any write', async () => {
  await assert.rejects(
    isolatedTarget({
      ...process.env,
      DIRECTUS_SEARCH_TEST_MARKER_VALUE: 'synthetic-not-this-fixture',
    }),
    markerPattern,
  );
});

test('denies anonymous options and malformed searches', async () => {
  const target = targetFrom(process.env);
  const anonymousOptions = await options(target);
  assert.equal(anonymousOptions.status, 403);
  const anonymousMalformed = await anonymousSearch(target, {
    include: 'not-an-array',
  });
  assert.equal(anonymousMalformed.status, 403);
});

test('matches exact LF and CRLF history entries through native filters', async () => {
  const target = await isolatedTarget(process.env);
  await withSearchFixture(target, async () => {
    const byName = async (criteria: object) => {
      const result = await search(target, target.token, {
        exclude: [],
        page: 1,
        sort: 'Name',
        ...criteria,
      });
      return names(result.data);
    };
    assert.deepEqual(
      await byName({ exclude: ['Exclude LF'], include: ['Exact LF'] }),
      [
        'Boundary CRLF',
        'Boundary Embedded',
        'Boundary Ends',
        'Boundary Starts',
      ],
    );
    assert.deepEqual(await byName({ include: ['Exact CRLF'] }), [
      'Boundary CRLF',
    ]);
    assert.deepEqual(await byName({ include: ['Under_score'] }), [
      'Boundary Underscore',
    ]);
    assert.deepEqual(
      await byName({ exclude: ['Under_score'], include: ['Another'] }),
      ['Boundary Embedded', 'Boundary Ends', 'Boundary Starts'],
    );
    assert.deepEqual(
      await byName({
        filter: {
          _and: [
            { Name: { _starts_with: 'Boundary' } },
            { 'Courses Count': { _gte: 4 } },
          ],
        },
        include: ['Exact LF'],
      }),
      ['Boundary Embedded'],
    );
    const invalid = await searchResponse(target, target.token, {
      exclude: [],
      filter: { Name: { _unknown: 'reject' } },
      include: [],
      page: 1,
    });
    const { errors } = errorBody.parse(await response(invalid, 400));
    assert.equal(errors.length, 1);
  });
});

// Both pages of a count order over the users of 'Unscored Entry'.
const unscoredPages = async (target: IsolatedTarget, sort: string) => {
  const pages = await Array.fromAsync([1, 2], (page) =>
    search(target, target.token, {
      exclude: [],
      include: ['Unscored Entry'],
      page,
      sort,
    }),
  );
  assert.deepEqual(
    pages.map(({ data, total }) => [data.length, total]),
    [
      [50, 52],
      [2, 52],
    ],
  );
  return pages.flatMap(({ data }) => data);
};

const blanks = [
  'Unscored Blank A',
  'Unscored Blank B',
  'Unscored Blank C',
  'Unscored Blank D',
];

const countOf = (row: SearchRow): number => {
  const count = row['Courses Count'];
  assert.ok(count !== null, `${row.Name} has no stored count`);
  return count;
};

test('ranks users without a stored course count after every counted user in both directions', async () => {
  const target = await isolatedTarget(process.env);
  await withSearchFixture(target, async () => {
    for (const [sort, direction] of [
      ['-Courses Count', -1],
      ['Courses Count', 1],
    ] as const) {
      const rows = await unscoredPages(target, sort);
      const counted = rows.slice(0, 48);
      const expected = counted.toSorted(
        (left, right) =>
          direction * (countOf(left) - countOf(right)) ||
          collator.compare(left.Name, right.Name),
      );
      assert.deepEqual(names(counted), names(expected), sort);
      assert.deepEqual(names(rows.slice(48)), blanks, sort);
    }
  });
});

test('paginates and sorts by history size', async () => {
  const target = await isolatedTarget(process.env);
  await withSearchFixture(target, async () => {
    const pageEntry = { exclude: [], include: ['Page Entry'] };
    const firstPage = await search(target, target.token, {
      ...pageEntry,
      page: 1,
      sort: 'Name',
    });
    const secondPage = await search(target, target.token, {
      ...pageEntry,
      page: 2,
      sort: 'Name',
    });
    assert.equal(firstPage.total, 52);
    assert.equal(firstPage.data.length, 50);
    assert.equal(secondPage.data.length, 2);
    const [first] = firstPage.data;
    assert.ok(first);
    assert.equal(first.Profile_new, 'https://profiles.example/new');
    assert.equal(first.Profile_old, 'https://profiles.example/old');
    assert.equal(secondPage.data[0]?.Name, 'Page 051');

    const mostFirst = await search(target, target.token, {
      ...pageEntry,
      page: 1,
      sort: '-Courses Count',
    });
    const counts = mostFirst.data.map(countOf);
    assert.equal(mostFirst.data[0]?.Name, 'Page 003');
    assert.deepEqual(
      counts,
      counts.toSorted((left, right) => right - left),
      'history sizes are not sorted most first',
    );
    const fewestFirst = await search(target, target.token, {
      ...pageEntry,
      page: 1,
      sort: 'Courses Count',
    });
    assert.equal(fewestFirst.data[0]?.Name, 'Page 001');
  });
});

test('searches names in Cyrillic or Latin, alone or with courses', async () => {
  const target = await isolatedTarget(process.env);
  await withSearchFixture(target, async () => {
    const byName = async (criteria: object) =>
      names(
        (
          await search(target, target.token, {
            exclude: [],
            include: [],
            page: 1,
            sort: 'Name',
            ...criteria,
          })
        ).data,
      );
    assert.deepEqual(await byName({ name: 'sapkarov' }), [
      'Ана Шапкарова',
      'Стефан Шапкаров',
    ]);
    assert.deepEqual(await byName({ name: 'Šapkarov stef' }), [
      'Стефан Шапкаров',
    ]);
    assert.deepEqual(await byName({ name: 'gjorgjieva' }), [
      'Стефанија Ѓорѓиева',
    ]);
    assert.deepEqual(
      await byName({ include: ['Named Entry'], name: 'стеф' }),
      ['Стефан Шапкаров', 'Стефанија Ѓорѓиева'],
    );
    assert.deepEqual(
      await byName({ exclude: ['Named Entry'], name: 'shapkarov' }),
      ['Ана Шапкарова'],
    );
    const none = await search(target, target.token, {
      exclude: [],
      include: [],
      name: 'nobody',
      page: 1,
    });
    assert.deepEqual(none, { data: [], total: 0 });
  });
});
