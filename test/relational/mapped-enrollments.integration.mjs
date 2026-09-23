import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { dataModelCollectionKeys } from '../../src/data-model/collections.js';
import {
  applySchemaConstraints,
  applySourceInvalidation,
} from '../../src/data-model/constraints.js';
import { installDataModel } from '../../src/data-model/install.js';
import {
  installMappedEnrollmentFlows,
  mappedCountQuery,
  mappedEnrollmentFlows,
  mappedPairFlow,
} from '../../src/flows/count-mapped-enrollments.js';
import {
  historyIndexFlows,
  installHistoryIndexFlows,
} from '../../src/flows/index-histories.js';
import { mappedEnrollmentFlowIds } from '../../src/flows/shared.js';
import { targetFrom } from '../search-integration-helpers.mjs';
import {
  adminRequest,
  assertMarkerPresent,
  errorCode,
  json,
  request,
  userCollections,
  withDataModel,
} from './data-model-helpers.mjs';
import {
  act,
  flowId as coordinateFlowId,
  count,
  create,
  entriesByLabel,
  entriesPath,
  get,
  installSyntheticFlow,
  invoke,
  patch,
  post,
  rebuild,
  refused,
  remove,
  status,
} from './history-index-helpers.mjs';
import {
  anonymousTrigger,
  candidates,
  drive,
  driverFlowId,
  enrollmentCounts,
  enrollmentsPath,
  installDriverFlow,
  installRunFlow,
  mappedPairs,
  mappingsPath,
  removeAll,
  runCounts,
  runFlowId,
  seedMappings,
  seedUsers,
  syntheticFlowIds,
} from './mapped-enrollments-helpers.mjs';

const collator = new Intl.Collator('en');
// Bulk courses with a mapped rule in both years: 6 + 2 * 124 = 254 mapped
// rules, two planned pages of 250 and 4.
const bulkCourses = 124;
const invalidAggregate = /INVALID_AGGREGATE/u;
const legacyRefused =
  /INVALID_RULE_PAGE Rule \d+ of page p0001 has the mode legacy_regex/u;
const historyDomain =
  /needs an enrollments claim, and the current claim runs history_index/u;
const planMismatch = 'PAGE_PLAN_MISMATCH';
const upstreamDirty = /upstream_dirty/u;
const byKey = (left, right) => collator.compare(left.key, right.key);
const privateText =
  /Mapped (?:Alpha|Beta|Common|Gamma|Unlisted)|Synthetic Mapped/u;
const firstCounts = {
  'a/y1': 2,
  'a/y2': 0,
  'b/y1': 2,
  'b/y2': 1,
  'c/y1': 2,
  'c/y2': 0,
};

const pairPayload = (state, [course, year], extra = {}) => ({
  academic_year: state.ids.get(year),
  claim: state.claim.token,
  course: state.ids.get(course),
  revision: state.claim.revision,
  ...extra,
});

const pagePayload = (state, extra = {}) => ({
  claim: state.claim.token,
  ...state.page,
  revision: state.claim.revision,
  ...extra,
});

const claimEnrollments = async (target, state, retry = null) => {
  const claim = await act(target, {
    action: 'claim',
    domain: 'enrollments',
    retry,
  });
  assert.equal(claim.claimed, true, JSON.stringify(claim));
  state.claim = claim;
  const plan = await act(target, {
    action: 'plan_pages',
    source: 'rules',
    token: claim.token,
  });
  const [page] = plan.pages;
  assert.equal(plan.pages.length, 1);
  assert.equal(page.rows, 6);
  state.page = page;
};

// The two templates are installed once, live exactly as defined, with the
// probed query and the repository script; the synthetic test parent, the
// driver and the coordinator probe join them for this run only.
const installsFlows = async (target, directus, state) => {
  const listed = await get(target, '/flows?fields=id&limit=-1');
  const present = new Set(listed.map(({ id }) => id));
  state.templatesCreated = [...historyIndexFlows, ...mappedEnrollmentFlows]
    .map(({ id }) => id)
    .filter((id) => !present.has(id));
  await installHistoryIndexFlows(directus);
  const first = await installMappedEnrollmentFlows(directus);
  assert.equal(
    first.created.length + first.skipped.length,
    mappedEnrollmentFlows.length,
  );
  assert.deepEqual(await installMappedEnrollmentFlows(directus), {
    created: [],
    skipped: mappedEnrollmentFlows.map(({ name }) => name),
  });
  for (const flow of mappedEnrollmentFlows) {
    const live = await get(
      target,
      `/flows/${flow.id}?fields=name,description,status,trigger,accountability,operation,options`,
    );
    assert.deepEqual(live, {
      accountability: 'activity',
      description: flow.description,
      name: flow.name,
      operation: flow.entry,
      options: flow.options,
      status: 'active',
      trigger: 'operation',
    });
    const operations = await get(
      target,
      `/operations?fields=key,name,type,options,resolve,reject&filter[flow][_eq]=${flow.id}&limit=-1`,
    );
    assert.deepEqual(
      operations.toSorted(byKey),
      flow.operations
        .map(({ key, name, options, reject, resolve, type }) => ({
          key,
          name,
          options,
          reject,
          resolve,
          type,
        }))
        .toSorted(byKey),
    );
  }
  const [readCount] = await get(
    target,
    `/operations?fields=options&filter[id][_eq]=${mappedPairFlow.operations[1].id}`,
  );
  assert.deepEqual(readCount.options.query, mappedCountQuery);
  // Each id is recorded before its install: a Flow whose operations fail
  // to install is still removed by the cleanup (403/404 when never made).
  state.flows.push(coordinateFlowId);
  await installSyntheticFlow(target);
  state.flows.push(driverFlowId);
  await installDriverFlow(target);
  state.flows.push(runFlowId);
  await installRunFlow(target);
};

// Users are indexed first (the history index is upstream of the counts),
// then the courses, years, rules and explicit mappings are added.
const seeds = async (target, state) => {
  for (const [key, courses] of seedUsers) {
    state.ids.set(
      key,
      await create(target, state, [
        'moodle_users',
        { Courses: courses, Name: `Synthetic Mapped User ${key}` },
      ]),
    );
  }
  const run = await rebuild(target);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.completed, true);
  for (const key of ['a', 'b', 'c', 'd']) {
    const id = await create(target, state, [
      'courses',
      { name: `Synthetic Mapped Course ${key.toUpperCase()}` },
    ]);
    state.ids.set(key, id);
    state.courses.set(id, key);
  }
  for (const [key, label, sort] of [
    ['y1', '2081/2082', 81],
    ['y2', '2082/2083', 82],
  ]) {
    const id = await create(target, state, ['academic_years', { label, sort }]);
    state.ids.set(key, id);
    state.years.set(id, key);
  }
  for (const [course, year] of mappedPairs) {
    await create(target, state, [
      'course_enrollment_rules',
      {
        academic_year: state.ids.get(year),
        course: state.ids.get(course),
        mode: 'mapped_entries',
      },
    ]);
  }
  const entries = await entriesByLabel(target);
  for (const [key, label, course, year] of seedMappings) {
    state.ids.set(
      key,
      await create(target, state, [
        'moodle_course_mappings',
        {
          academic_year: state.ids.get(year),
          course: state.ids.get(course),
          entry: entries.get(label).id,
        },
      ]),
    );
  }
  assert.equal(await count(target, 'moodle_history_memberships'), 8);
  const report = await status(target);
  assert.deepEqual(report.pending, ['enrollments', 'publication']);
};

// One pair at a time through the installed pair Flow: the counts, the 2
// users (not the 3 matching memberships) of course A in year 1, explicit
// zeros, and answers that carry ids and counts only.
const countsPairs = async (target, state, context) => {
  await claimEnrollments(target, state);
  const results = await drive(
    target,
    mappedEnrollmentFlowIds.pair,
    mappedPairs.map((pair) => pairPayload(state, pair)),
  );
  assert.deepEqual(
    results,
    mappedPairs.map(([course, year]) => ({
      academic_year: state.ids.get(year),
      count: firstCounts[`${course}/${year}`],
      course: state.ids.get(course),
      revision: state.claim.revision,
    })),
  );
  assert.doesNotMatch(JSON.stringify(results), privateText);
  const memberships = await get(
    target,
    `/items/moodle_history_memberships?aggregate[count]=*&filter[entry][mappings][course][_eq]=${state.ids.get('a')}&filter[entry][mappings][academic_year][_eq]=${state.ids.get('y1')}`,
  );
  assert.equal(memberships[0].count, '3', 'three memberships match A/Y1');
  // Tampered requests answer failure records, never a count.
  const [textual, foreign, missing] = await drive(
    target,
    mappedEnrollmentFlowIds.pair,
    [
      pairPayload(state, ['a', 'y1'], { course: 'abc' }),
      pairPayload(state, ['a', 'y1'], { claim: randomUUID() }),
      pairPayload(state, ['a', 'y1'], { academic_year: undefined }),
    ],
  );
  context.diagnostic(
    JSON.stringify({
      foreign: [foreign.stage, foreign.code],
      missing: [missing.stage, missing.code],
      textual: [textual.stage, textual.code],
    }),
  );
  assert.equal(textual.ok, false, JSON.stringify(textual));
  assert.ok(['read', 'validate'].includes(textual.stage));
  assert.deepEqual(
    [foreign.ok, foreign.stage, foreign.code],
    [false, 'claim', 'COORDINATION_CLAIM_MISMATCH'],
  );
  assert.equal(missing.ok, false, JSON.stringify(missing));
  // A course nobody maps counts zero; the pair Flow never writes, and
  // stage_page refuses a pair whose course does not exist.
  const [unknown] = await drive(target, mappedEnrollmentFlowIds.pair, [
    pairPayload(state, ['a', 'y1'], { course: 999_999 }),
  ]);
  assert.equal(unknown.count, 0);
  const staged = await invoke(target, {
    action: 'stage_page',
    page: state.page.token,
    rows: [{ academic_year: state.ids.get('y1'), count: 0, course: 999_999 }],
    token: state.claim.token,
  });
  assert.notEqual(staged.status, 200, JSON.stringify(staged.body));
  assert.deepEqual(await candidates(target), []);
};

// The page Flow stages every mapped pair of the page at once, zeros
// included; completion installs them.
const stagesAndCompletes = async (target, state) => {
  const [staged] = await drive(target, mappedEnrollmentFlowIds.page, [
    pagePayload(state),
  ]);
  assert.deepEqual(staged, { page: 'p0001', replaced: 0, staged: 6 });
  const rows = await candidates(target);
  assert.deepEqual(
    rows.map(
      ({ academic_year, count: value, course, page_token, revision }) => [
        `${state.courses.get(course)}/${state.years.get(academic_year)}`,
        value,
        page_token,
        revision,
      ],
    ),
    Object.entries(firstCounts).map(([pair, value]) => [
      pair,
      value,
      'p0001',
      state.claim.revision,
    ]),
  );
  // A replayed page replaces itself.
  const [replayed] = await drive(target, mappedEnrollmentFlowIds.page, [
    pagePayload(state),
  ]);
  assert.deepEqual(replayed, { page: 'p0001', replaced: 6, staged: 6 });
  const completed = await act(target, {
    action: 'complete',
    token: state.claim.token,
  });
  assert.deepEqual(completed, {
    completed: true,
    domain: 'enrollments',
    installed: 6,
    revision: state.claim.revision,
  });
  assert.deepEqual(await enrollmentCounts(target, state), firstCounts);
  const installed = await get(
    target,
    '/items/course_enrollments?fields=computed_revision&limit=-1',
  );
  assert.ok(
    installed.every(
      ({ computed_revision }) => computed_revision === state.claim.revision,
    ),
  );
  assert.deepEqual(await candidates(target), []);
  const report = await status(target);
  assert.equal(report.claim, null);
  assert.deepEqual(report.pending, ['publication']);
};

// Replaces the aggregate of the installed pair Flow's read with a plain
// count (a Studio edit would do the same), runs the body and restores the
// exact options; the managed graph fingerprint returns to its value.
const withInvalidAggregate = async (target, body) => {
  const [readCount] = mappedPairFlow.operations.slice(1, 2);
  const path = `/operations/${readCount.id}`;
  const original = await get(target, `${path}?fields=options`);
  const before = await status(target);
  await patch(target, path, {
    options: {
      ...original.options,
      query: { ...original.options.query, aggregate: { count: ['id'] } },
    },
  });
  try {
    await body();
  } finally {
    await patch(target, path, { options: original.options });
  }
  const restored = await get(target, `${path}?fields=options`);
  assert.deepEqual(restored.options, readCount.options);
  const after = await status(target);
  assert.equal(after.fingerprints.current, before.fingerprints.current);
};

const pageFailure = async (target, state, { code, extra, stage }) => {
  const [result] = await drive(target, mappedEnrollmentFlowIds.page, [
    pagePayload(state, extra),
  ]);
  assert.deepEqual(
    [result.ok, result.stage, result.code],
    [false, stage, code],
    JSON.stringify(result),
  );
  assert.doesNotMatch(JSON.stringify(result), privateText);
  assert.deepEqual(await candidates(target), [], 'nothing was staged');
  return result;
};

// A mapped rule page that also holds a legacy_regex rule is refused whole:
// staging its mapped rules alone would let the completion, which replaces
// every installed row, drop the legacy pair's count. The run fails without
// a completion and the legacy pair's installed row survives.
const refusesLegacyRulePage = async (target, state) => {
  const legacy = await create(target, state, [
    'course_enrollment_rules',
    {
      academic_year: state.ids.get('y1'),
      course: state.ids.get('d'),
      mode: 'legacy_regex',
      pattern: 'Mapped Unlisted',
    },
  ]);
  const before = await status(target);
  // Stands in for the count a legacy-aware run installed earlier.
  const kept = await post(target, enrollmentsPath, {
    academic_year: state.ids.get('y1'),
    computed_at: '2081-09-01T00:00:00.000Z',
    computed_revision: before.revisions.completed,
    count: 1,
    course: state.ids.get('d'),
  });
  const installed = { ...firstCounts, 'd/y1': 1 };
  assert.deepEqual(await enrollmentCounts(target, state), installed);
  const run = await runCounts(target);
  assert.equal(run.status, 500, JSON.stringify(run.body));
  assert.equal(errorCode(run.body), 'MAPPED_COUNT_FAILED');
  assert.match(run.body.errors[0].message, legacyRefused);
  assert.doesNotMatch(JSON.stringify(run.body), privateText);
  assert.deepEqual(await candidates(target), [], 'nothing was staged');
  assert.deepEqual(await enrollmentCounts(target, state), installed);
  const after = await status(target);
  assert.equal(after.claim, null);
  assert.equal(after.lastError.code, 'MAPPED_COUNT_FAILED');
  // The legacy rule and its row go again; the later runs count the mapped
  // rules alone.
  await remove(target, `${enrollmentsPath}/${kept.data.id}`);
  await remove(target, `/items/course_enrollment_rules/${legacy}`);
  state.items = state.items.filter(
    ([collection, id]) =>
      collection !== 'course_enrollment_rules' || id !== legacy,
  );
  assert.deepEqual(await enrollmentCounts(target, state), firstCounts);
};

// A claim of another domain: under a history index claim with a plan over
// the Moodle users, the page Flow refuses before a rule is read. The
// history index is then rebuilt through the runner's explicit retry.
const refusesHistoryClaim = async (target) => {
  await act(target, { action: 'mark', domains: ['history_index'] });
  const claim = await act(target, {
    action: 'claim',
    domain: 'history_index',
    retry: null,
  });
  assert.equal(claim.claimed, true, JSON.stringify(claim));
  const plan = await act(target, {
    action: 'plan_pages',
    source: 'history',
    token: claim.token,
  });
  const [page] = plan.pages;
  const [result] = await drive(target, mappedEnrollmentFlowIds.page, [
    {
      claim: claim.token,
      from: page.from,
      revision: claim.revision,
      rows: page.rows,
      to: page.to,
      token: page.token,
    },
  ]);
  assert.deepEqual(
    [result.ok, result.stage, result.code],
    [false, 'page', planMismatch],
    JSON.stringify(result),
  );
  assert.match(result.message, historyDomain);
  assert.ok(!JSON.stringify(result).includes(claim.token));
  assert.deepEqual(await candidates(target), []);
  const failed = await act(target, {
    action: 'fail',
    code: 'SYNTHETIC_FOREIGN_DOMAIN',
    token: claim.token,
  });
  assert.equal(failed.failed, true);
  const rebuilt = await rebuild(target, { retry: true });
  assert.equal(rebuilt.status, 200, JSON.stringify(rebuilt.body));
  assert.equal(rebuilt.body.completed, true);
};

// Pages that do not match the claim's stored plan (a row count off by one,
// a consistent sub-range, a foreign claim, another revision, an unplanned
// token), a foreign claim domain and an invalid aggregate stage nothing,
// the completion refuses the unstaged page, and the installed counts stay
// as they were: a failure is never a zero.
const failuresWriteNoZero = async (target, state) => {
  await refusesHistoryClaim(target);
  await act(target, { action: 'mark', domains: ['enrollments'] });
  await claimEnrollments(target, state);
  for (const extra of [
    { rows: 5 },
    { rows: 1, to: state.page.from },
    { claim: randomUUID() },
    { revision: state.claim.revision - 1 },
    { token: 'p0002' },
  ]) {
    await pageFailure(target, state, {
      code: planMismatch,
      extra,
      stage: 'page',
    });
  }
  // stage_page itself refuses a token outside the plan.
  await refused(
    target,
    {
      action: 'stage_page',
      page: 'p0002',
      rows: [],
      token: state.claim.token,
    },
    'COORDINATION_PAGE_UNPLANNED',
  );
  // An invalid aggregate, as a Studio edit of the query would produce it.
  await withInvalidAggregate(target, async () => {
    const invalid = await pageFailure(target, state, {
      code: 'COUNT_FAILED',
      extra: {},
      stage: 'candidates',
    });
    assert.match(invalid.message, invalidAggregate);
  });
  const completion = await invoke(target, {
    action: 'complete',
    token: state.claim.token,
  });
  assert.equal(completion.status, 409, JSON.stringify(completion.body));
  assert.equal(errorCode(completion.body), 'COORDINATION_PAGES_MISSING');
  assert.deepEqual(await enrollmentCounts(target, state), firstCounts);
  const failed = await act(target, {
    action: 'fail',
    code: 'SYNTHETIC_MAPPED_FAILURE',
    token: state.claim.token,
  });
  assert.equal(failed.failed, true);
  assert.deepEqual(await enrollmentCounts(target, state), firstCounts);
};

// Remapping a course and a year through the API changes exactly the pairs
// involved once a run succeeds; the unrelated pairs keep their counts.
const remapsAndRecounts = async (target, state) => {
  await patch(target, `${mappingsPath}/${state.ids.get('beta')}`, {
    course: state.ids.get('c'),
  });
  await patch(target, `${mappingsPath}/${state.ids.get('alpha')}`, {
    academic_year: state.ids.get('y2'),
  });
  // A Studio edit of the count query changes the managed graph: every
  // calculation domain is pending again, the history index first. A run
  // under the broken query fails visibly and installs nothing.
  await withInvalidAggregate(target, async () => {
    const upstream = await runCounts(target);
    assert.equal(upstream.status, 409, JSON.stringify(upstream.body));
    assert.match(upstream.body.errors[0].message, upstreamDirty);
    const indexed = await rebuild(target);
    assert.equal(indexed.status, 200, JSON.stringify(indexed.body));
    const failed = await runCounts(target);
    assert.equal(failed.status, 500, JSON.stringify(failed.body));
    assert.equal(errorCode(failed.body), 'MAPPED_COUNT_FAILED');
    assert.match(failed.body.errors[0].message, invalidAggregate);
    assert.doesNotMatch(JSON.stringify(failed.body), privateText);
    const report = await status(target);
    assert.equal(report.claim, null);
    assert.equal(report.lastError.code, 'MAPPED_COUNT_FAILED');
  });
  assert.deepEqual(await enrollmentCounts(target, state), firstCounts);
  const reindexed = await rebuild(target);
  assert.equal(reindexed.status, 200, JSON.stringify(reindexed.body));
  const run = await runCounts(target);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.completed, true);
  assert.equal(run.body.installed, 6);
  assert.deepEqual(run.body.pages, { pages: 1, staged: 6 });
  assert.doesNotMatch(JSON.stringify(run.body), privateText);
  assert.deepEqual(await enrollmentCounts(target, state), {
    ...firstCounts,
    'a/y1': 1,
    'a/y2': 1,
    'b/y2': 0,
    'c/y2': 1,
  });
};

// Deleting a mapping leaves an explicit zero for its course/year.
const deletesMapping = async (target, state) => {
  await remove(target, `${mappingsPath}/${state.ids.get('commonB')}`);
  state.items = state.items.filter(
    ([collection, id]) =>
      collection !== 'moodle_course_mappings' ||
      id !== state.ids.get('commonB'),
  );
  const run = await runCounts(target);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.deepEqual(await enrollmentCounts(target, state), {
    ...firstCounts,
    'a/y1': 1,
    'a/y2': 1,
    'b/y1': 0,
    'b/y2': 0,
    'c/y2': 1,
  });
  const report = await status(target);
  assert.equal(report.claim, null);
  assert.equal(report.revisions.completed, run.body.revision);
};

// Two planned pages in one run of the test parent: bulk courses with a
// mapped rule in both years push the rules past one page, every pair is
// counted serially (one heartbeat each) and each page staged at once.
const countsTwoPages = async (target, state, context) => {
  const created = await post(
    target,
    '/items/courses',
    Array.from({ length: bulkCourses }, (_, index) => ({
      name: `Synthetic Mapped Bulk Course ${index + 1}`,
    })),
  );
  const bulk = created.data.map(({ id }) => id);
  for (const id of bulk) state.bulkCourses.add(id);
  await post(
    target,
    '/items/course_enrollment_rules',
    bulk.flatMap((course) =>
      ['y1', 'y2'].map((year) => ({
        academic_year: state.ids.get(year),
        course,
        mode: 'mapped_entries',
      })),
    ),
  );
  const entries = await entriesByLabel(target);
  await post(target, mappingsPath, {
    academic_year: state.ids.get('y2'),
    course: bulk.at(-1),
    entry: entries.get('Mapped Unlisted').id,
  });
  // The first page's range under the second page's token is consistent in
  // itself and still refused: the page must be the one the claim planned.
  const claim = await act(target, {
    action: 'claim',
    domain: 'enrollments',
    retry: null,
  });
  assert.equal(claim.claimed, true, JSON.stringify(claim));
  const plan = await act(target, {
    action: 'plan_pages',
    source: 'rules',
    token: claim.token,
  });
  const [first, second] = plan.pages;
  assert.deepEqual(
    plan.pages.map(({ rows }) => rows),
    [250, 4],
  );
  const [swapped] = await drive(target, mappedEnrollmentFlowIds.page, [
    {
      claim: claim.token,
      from: first.from,
      revision: claim.revision,
      rows: first.rows,
      to: first.to,
      token: second.token,
    },
  ]);
  assert.deepEqual(
    [swapped.ok, swapped.stage, swapped.code],
    [false, 'page', planMismatch],
    JSON.stringify(swapped),
  );
  assert.deepEqual(await candidates(target), [], 'nothing was staged');
  await act(target, {
    action: 'fail',
    code: 'SYNTHETIC_SWAPPED_PAGE',
    token: claim.token,
  });
  const started = performance.now();
  const run = await runCounts(target, { retry: true });
  const runMs = Math.round(performance.now() - started);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const pairs = 6 + 2 * bulkCourses;
  assert.deepEqual(run.body.pages, { pages: 2, staged: pairs });
  assert.equal(run.body.installed, pairs);
  const counted = await get(
    target,
    `${enrollmentsPath}?fields=course,academic_year,count&filter[course][_in]=${bulk.join(',')}&limit=-1`,
  );
  assert.equal(counted.length, 2 * bulkCourses);
  assert.deepEqual(
    counted.filter(({ count: value }) => value !== 0),
    [{ academic_year: state.ids.get('y2'), count: 1, course: bulk.at(-1) }],
  );
  context.diagnostic(
    JSON.stringify({
      pages: 2,
      pairs,
      perPairMs: Math.round((runMs / pairs) * 10) / 10,
      runMs,
    }),
  );
  await removeAll(target, '/items/courses', bulk);
  state.bulkCourses.clear();
};

// Operation-triggered Flows cannot be reached over REST, and nobody runs
// the synthetic manual Flows without signing in.
const refusesAnonymousTriggers = async (target) => {
  for (const id of [
    mappedEnrollmentFlowIds.pair,
    mappedEnrollmentFlowIds.page,
    runFlowId,
    driverFlowId,
  ]) {
    assert.equal(await anonymousTrigger(target, id), 403, id);
  }
  const direct = await request(
    target,
    `/flows/trigger/${mappedEnrollmentFlowIds.pair}`,
    json('POST', { collection: 'data_operations' }, target.token),
  );
  assert.equal(direct.status, 403);
  await direct.text();
};

const cleansUp = async (target, state) => {
  await removeAll(target, '/items/courses', [...state.bulkCourses]);
  for (const id of [...state.flows, ...state.templatesCreated]) {
    const response = await request(target, `/flows/${id}`, {
      method: 'DELETE',
      token: target.token,
    });
    await response.text();
    assert.ok([204, 403, 404].includes(response.status), `${id}`);
  }
  const listed = await get(target, '/flows?fields=id&limit=-1');
  const flows = new Set(listed.map(({ id }) => id));
  for (const id of [
    ...syntheticFlowIds,
    coordinateFlowId,
    ...state.templatesCreated,
  ]) {
    assert.ok(!flows.has(id), `Flow ${id} is gone`);
  }
  for (const [collection, id] of state.items) {
    await remove(target, `/items/${collection}/${id}`);
  }
  const entries = await get(target, `${entriesPath}?fields=id&limit=-1`);
  for (const { id } of entries) {
    await remove(target, `${entriesPath}/${id}`);
  }
  // The installed counts, rules and mappings went with their courses and
  // years (ON DELETE CASCADE), the memberships with their users.
  for (const collection of dataModelCollectionKeys) {
    if (collection === 'data_operations') continue;
    assert.equal(
      await count(target, collection),
      0,
      `${collection} must be empty again`,
    );
  }
};

test('derives enrollment counts from explicit mappings with native Flows', async (t) => {
  const target = targetFrom(process.env);
  const directus = adminRequest(target);
  const state = {
    bulkCourses: new Set(),
    claim: null,
    courses: new Map(),
    flows: [],
    ids: new Map(),
    items: [],
    page: null,
    templatesCreated: [],
    years: new Map(),
  };

  await withDataModel(target, async () => {
    try {
      await installDataModel(directus);
      await applySchemaConstraints(directus);
      await applySourceInvalidation(directus);
      await t.test('installs the mapped enrollment flows once', () =>
        installsFlows(target, directus, state),
      );
      await t.test('seeds users, entries, rules and explicit mappings', () =>
        seeds(target, state),
      );
      await t.test(
        'counts each pair once per user through the installed pair flow',
        (context) => countsPairs(target, state, context),
      );
      await t.test(
        'stages a whole page, zeros included, and completes at the claimed revision',
        () => stagesAndCompletes(target, state),
      );
      await t.test(
        'refuses a rule page holding a legacy rule and keeps its installed count',
        () => refusesLegacyRulePage(target, state),
      );
      await t.test(
        'stages nothing and keeps the installed counts when a page, its plan or an aggregate fails',
        () => failuresWriteNoZero(target, state),
      );
      await t.test(
        'recounts exactly the remapped course and year through the test parent',
        () => remapsAndRecounts(target, state),
      );
      await t.test('installs an explicit zero after a mapping is deleted', () =>
        deletesMapping(target, state),
      );
      await t.test(
        'counts two planned pages serially in one run of the test parent',
        (context) => countsTwoPages(target, state, context),
      );
      await t.test('refuses anonymous and REST triggers', () =>
        refusesAnonymousTriggers(target),
      );
    } finally {
      await t.test('removes exactly what it created', () =>
        cleansUp(target, state),
      );
    }
  });

  await assertMarkerPresent(target);
  assert.deepEqual(await userCollections(target), [target.markerCollection]);
});
