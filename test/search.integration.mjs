import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isolatedTargets, targetFrom } from './isolated-target.mjs';
import {
  anonymousSearch,
  options,
  response,
  search,
  searchResponse,
  withSearchFixture,
} from './search-integration-helpers.mjs';

const missingUrlPattern = /DIRECTUS_SEARCH_TEST_URL/u;
const loopbackPattern = /loopback-only/u;
const disposablePattern = /not disposable/u;
const syntheticPattern = /not synthetic/u;
const validTarget = {
  DIRECTUS_SEARCH_TEST_MARKER_COLLECTION: 'synthetic_search_marker_test',
  DIRECTUS_SEARCH_TEST_MARKER_VALUE: 'synthetic-test',
  DIRECTUS_SEARCH_TEST_TOKEN: 'token',
  DIRECTUS_SEARCH_TEST_URL: 'http://127.0.0.1:18055',
};
const names = (result) => result.data.map(({ Name }) => Name);

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

// Docker must not be asked anything for these refusals.
const noDocker = {
  networks: () => assert.fail('no Docker command'),
  ports: () => assert.fail('no Docker command'),
  setting: () => assert.fail('no Docker command'),
};
const markerPattern = /Target marker must exist exactly once/u;
const bucketPattern = /Set DIRECTUS_S3_TEST_BUCKET/u;
const endpointPattern = /Set DIRECTUS_S3_TEST_ENDPOINT/u;
const unknownS3Pattern = /Unknown S3 requirement/u;
const directusContainerPattern = /Set the directus container/u;
const unknownContainerPattern = /Unknown container requirement/u;

// The environment without any S3 or container variable.
const plainEnvironment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith('DIRECTUS_S3_TEST_') &&
        name !== 'DIRECTUS_COORDINATION_RESTART_CONTAINER' &&
        name !== 'DIRECTUS_AUTOMATIC_DATABASE_CONTAINER',
    ),
  );

test('refuses an unmarked target, a partial S3 target and missing or unknown requirements before any write', async () => {
  const environment = plainEnvironment();
  const accepted = await isolatedTargets(environment, {}, noDocker);
  assert.deepEqual(accepted.containers, { database: null, directus: null });
  assert.equal(accepted.s3, null);
  // The loopback fixture without the marker value it was given.
  await assert.rejects(
    isolatedTargets(
      {
        ...environment,
        DIRECTUS_SEARCH_TEST_MARKER_VALUE: 'synthetic-not-this-fixture',
      },
      {},
      noDocker,
    ),
    markerPattern,
  );
  // Refused before any request: the target is a loopback port nothing
  // listens on, so a request would fail with another error.
  const unreachable = {
    ...environment,
    DIRECTUS_SEARCH_TEST_URL: 'http://127.0.0.1:9',
  };
  const refusals = [
    [
      { ...unreachable, DIRECTUS_S3_TEST_ENDPOINT: 'http://127.0.0.1:9' },
      { s3: 'optional' },
      bucketPattern,
    ],
    [unreachable, { s3: 'required' }, endpointPattern],
    [unreachable, { s3: 'sometimes' }, unknownS3Pattern],
    [unreachable, { containers: ['directus'] }, directusContainerPattern],
    [
      {
        ...unreachable,
        DIRECTUS_AUTOMATIC_DATABASE_CONTAINER: 'synthetic-database',
      },
      { containers: ['database'] },
      directusContainerPattern,
    ],
    [unreachable, { containers: ['s3'] }, unknownContainerPattern],
  ];
  for (const [variables, requirements, pattern] of refusals) {
    await assert.rejects(
      isolatedTargets(variables, requirements, noDocker),
      pattern,
    );
  }
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
  const target = targetFrom(process.env);
  await withSearchFixture(target, false, async () => {
    const boundary = await search(target, target.token, {
      exclude: ['Exclude LF'],
      include: ['Exact LF'],
      page: 1,
      sort: 'Name',
    });
    assert.deepEqual(names(boundary), [
      'Boundary CRLF',
      'Boundary Embedded',
      'Boundary Ends',
      'Boundary Starts',
    ]);
    const crlf = await search(target, target.token, {
      exclude: [],
      include: ['Exact CRLF'],
      page: 1,
      sort: 'Name',
    });
    assert.deepEqual(names(crlf), ['Boundary CRLF']);
    const wildcard = await search(target, target.token, {
      exclude: [],
      include: ['Under_score'],
      page: 1,
      sort: 'Name',
    });
    assert.deepEqual(names(wildcard), ['Boundary Underscore']);
    const excludedWildcard = await search(target, target.token, {
      exclude: ['Under_score'],
      include: ['Another'],
      page: 1,
      sort: 'Name',
    });
    assert.deepEqual(names(excludedWildcard), [
      'Boundary Embedded',
      'Boundary Ends',
      'Boundary Starts',
    ]);
    const filtered = await search(target, target.token, {
      exclude: [],
      filter: {
        _and: [
          { Name: { _starts_with: 'Boundary' } },
          { 'Courses Count': { _gte: 4 } },
        ],
      },
      include: ['Exact LF'],
      page: 1,
      sort: 'Name',
    });
    assert.deepEqual(names(filtered), ['Boundary Embedded']);
    const invalid = await searchResponse(target, target.token, {
      exclude: [],
      filter: { Name: { _unknown: 'reject' } },
      include: [],
      page: 1,
    });
    const invalidBody = await response(invalid, 400);
    assert.equal(invalidBody.errors.length, 1);
  });
});

test('paginates, sorts by history size, and applies restricted row and field access', async () => {
  const target = targetFrom(process.env);
  await withSearchFixture(target, true, async (fixture) => {
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
    assert.equal(firstPage.data[0].Profile_new, 'https://profiles.example/new');
    assert.equal(firstPage.data[0].Profile_old, 'https://profiles.example/old');
    assert.equal(secondPage.data[0].Name, 'Page 051');

    const mostFirst = await search(target, target.token, {
      ...pageEntry,
      page: 1,
      sort: '-Courses Count',
    });
    const counts = mostFirst.data.map((row) => row['Courses Count']);
    assert.equal(mostFirst.data[0].Name, 'Page 003');
    assert.ok(
      counts.every((count, index) => index === 0 || count <= counts[index - 1]),
      'history sizes are not sorted most first',
    );
    const fewestFirst = await search(target, target.token, {
      ...pageEntry,
      page: 1,
      sort: 'Courses Count',
    });
    assert.equal(fewestFirst.data[0].Name, 'Page 001');

    const scopedOptions = await response(
      await options(target, fixture.restrictedToken),
      200,
    );
    assert.deepEqual(scopedOptions.data, ['Visible Entry']);
    const scopedSearch = await search(target, fixture.restrictedToken, {
      exclude: [],
      include: ['Visible Entry'],
      page: 1,
      sort: 'Name',
    });
    assert.equal(scopedSearch.total, 1);
    assert.deepEqual(names(scopedSearch), ['Visible Searcher']);
    await fixture.setRestrictedFields([
      'id',
      'Name',
      'Courses',
      'Courses Count',
    ]);
    const fieldsDenied = await searchResponse(target, fixture.restrictedToken, {
      exclude: [],
      include: ['Visible Entry'],
      page: 1,
      sort: 'Name',
    });
    const fieldsDeniedBody = await response(fieldsDenied, 403);
    assert.equal(fieldsDeniedBody.data, undefined);
    assert.equal(fieldsDeniedBody.errors[0].extensions.code, 'FORBIDDEN');
    await fixture.setRestrictedFields(['id', 'Name']);
    const coursesDenied = await options(target, fixture.restrictedToken);
    const coursesDeniedBody = await response(coursesDenied, 403);
    assert.equal(coursesDeniedBody.data, undefined);
    assert.equal(coursesDeniedBody.errors[0].extensions.code, 'FORBIDDEN');
  });
});
