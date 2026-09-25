import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  maxRowsPerPage,
  pageSize,
} from '../../directus/extensions/directus-extension-data-operations/src/coordination/state.js';
import { maxLabelBytes } from '../../directus/extensions/directus-extension-data-operations/src/history-contract.js';
import { dataModelCollectionKeys } from '../../src/data-model/collections.js';
import {
  applySchemaConstraints,
  applySourceInvalidation,
} from '../../src/data-model/constraints.js';
import { installDataModel } from '../../src/data-model/install.js';
import { flowFamilyCodes } from '../../src/flows/flow-template.js';
import { historyIndexFlows } from '../../src/flows/index-histories.js';
import { installFlowFamily } from '../../src/flows/registry.js';
import { assertMarkerPresent, targetFrom } from '../isolated-target.mjs';
import {
  adminRequest,
  createItem,
  errorCode,
  json,
  read,
  request,
  userCollections,
  withDataModel,
} from './data-model-helpers.mjs';
import {
  act,
  alphaCourse,
  alphaLeadingSpace,
  alphaTrailingSpace,
  betaCourse,
  bulkCourse,
  bulkUserPrefix,
  claimHistory,
  claimMismatch,
  collator,
  count,
  coursesCount,
  create,
  derivedIndex,
  entriesByLabel,
  entriesPath,
  failureCode,
  flowId,
  get,
  historyRunnerId,
  indexPageBody,
  installProbeFlow,
  installSyntheticFlow,
  invalidOptions,
  membershipsOf,
  membershipsPath,
  pageIncomplete,
  pageRows,
  patch,
  post,
  probeFlowId,
  readerPolicyPrefix,
  rebuild,
  rebuildAs,
  refused,
  refusedRun,
  remove,
  retryRequired,
  rowsPattern,
  seedLabels,
  seedUsers,
  status,
  trigger,
  withReader,
} from './history-index-helpers.mjs';
import {
  installHistoryRunner,
  removeHistoryRunner,
} from './history-runner.mjs';

// The Flows a family install created and skipped.
const flowLists = ({ created, skipped }) => ({ created, skipped });

const leftOutTwoPattern = /left out 2 of them/u;
const busyPattern = /not claimed \(busy\)/u;

// The three template Flows are installed once; a second install changes
// nothing and every Flow is active with its entry operation wired.
const installsFlows = async (target, directus, state) => {
  const listed = await get(target, '/flows?fields=id&limit=-1');
  const present = new Set(listed.map(({ id }) => id));
  state.templatesCreated = historyIndexFlows
    .map(({ id }) => id)
    .filter((id) => !present.has(id));
  const first = await installFlowFamily(directus, flowFamilyCodes.history);
  assert.deepEqual(
    first.created.length + first.skipped.length,
    historyIndexFlows.length,
  );
  assert.deepEqual(
    flowLists(await installFlowFamily(directus, flowFamilyCodes.history)),
    {
      created: [],
      skipped: historyIndexFlows.map(({ name }) => name),
    },
  );
  for (const flow of historyIndexFlows) {
    const live = await get(
      target,
      `/flows/${flow.id}?fields=status,trigger,accountability,operation,options`,
    );
    assert.deepEqual(live, {
      accountability: 'activity',
      operation: flow.entry,
      options: flow.options,
      status: 'active',
      trigger: flow.trigger,
    });
    const operations = await get(
      target,
      `/operations?fields=key,type,resolve,reject&filter[flow][_eq]=${flow.id}&limit=-1&sort=key`,
    );
    assert.deepEqual(
      operations,
      flow.operations
        .map(({ key, reject, resolve, type }) => ({
          key,
          reject,
          resolve,
          type,
        }))
        .toSorted((left, right) => collator.compare(left.key, right.key)),
    );
  }
  await installSyntheticFlow(target);
  state.flowInstalled = true;
  await installHistoryRunner(target);
  state.runnerInstalled = true;
  const report = await status(target);
  assert.equal(report.claim, null);
  assert.deepEqual(report.historyIndex, {
    countMismatches: 0,
    entries: 0,
    indexedUsers: 0,
    memberships: 0,
    needsMapping: 0,
    users: 0,
  });
};

const seedsHistories = async (target, state) => {
  const users = [];
  for (const user of seedUsers) {
    const id = await create(target, state, ['moodle_users', user]);
    users.push({ ...user, id });
  }
  const course = await create(target, state, [
    'courses',
    { name: 'Synthetic History Course' },
  ]);
  const year = await create(target, state, [
    'academic_years',
    { label: '2031/2032', sort: 1 },
  ]);
  Object.assign(state, { course, users, year });
  const report = await status(target);
  assert.deepEqual(report.dirty, [
    'history_index',
    'enrollments',
    'publication',
  ]);
  assert.equal(report.historyIndex.users, 6);
  assert.equal(report.historyIndex.countMismatches, 5);
};

// One page over the six users: seven exact entries, ten memberships, a
// replay that creates nothing, the coordinator status comparing the
// index against the raw counts, and a completion at the adopted revision.
const indexesThroughCoordinator = async (target, state) => {
  const claim = await claimHistory(target);
  // A claim that never planned cannot mark the index current.
  await refused(
    target,
    { action: 'complete', token: claim.token },
    'COORDINATION_PAGES_MISSING',
  );
  const ids = state.users.map(({ id }) => id);
  const plan = await act(target, {
    action: 'plan_pages',
    source: 'history',
    token: claim.token,
  });
  assert.deepEqual(plan.pages, [
    { from: Math.min(...ids), rows: 6, to: Math.max(...ids), token: 'p0001' },
  ]);
  // A page must name exactly the users of its planned range: a Read Data
  // capped by QUERY_LIMIT_MAX (the first users only) or a foreign id is
  // refused before anything is written.
  const rows = pageRows(state.users);
  const truncated = await refused(
    target,
    indexPageBody(state, claim.token, { rows: rows.slice(0, 4) }),
    pageIncomplete,
  );
  assert.match(truncated.errors[0].message, leftOutTwoPattern);
  await refused(
    target,
    indexPageBody(state, claim.token, {
      rows: [...rows, { entries: [], id: Math.max(...ids) + 1_000 }],
    }),
    pageIncomplete,
  );
  const untouched = await status(target);
  assert.equal(untouched.claim.staged, 0);
  assert.equal(untouched.historyIndex.entries, 0);
  assert.equal(untouched.historyIndex.memberships, 0);
  const before = await status(target);
  assert.deepEqual(await act(target, indexPageBody(state, claim.token, {})), {
    entriesCreated: 7,
    membershipsRemoved: 0,
    membershipsWritten: 10,
    page: 'p0001',
    users: 6,
  });
  let report = await status(target);
  assert.equal(
    report.revisions.source,
    before.revisions.source + 1,
    'creating entries is one source statement',
  );
  assert.equal(
    report.claim.revision,
    report.revisions.source,
    'the claim adopted the revision its own statement caused',
  );
  assert.equal(report.claim.staged, 1);
  assert.deepEqual(report.dirty, [
    'history_index',
    'enrollments',
    'publication',
  ]);
  const entries = await entriesByLabel(target);
  assert.deepEqual(
    entries.keys().toArray().toSorted(),
    [...seedLabels].toSorted(),
  );
  assert.ok(
    entries
      .values()
      .every(
        ({ review_reason, review_state }) =>
          review_state === 'needs_mapping' && review_reason === null,
      ),
  );
  const [one, two, three, four, five, six] = state.users;
  assert.deepEqual(await membershipsOf(target, one.id), [
    [alphaCourse, 0],
    [betaCourse, 1],
  ]);
  assert.deepEqual(await membershipsOf(target, two.id), [
    [alphaCourse, 0],
    ['Gamma Course', 1],
  ]);
  assert.deepEqual(await membershipsOf(target, three.id), [
    ['alpha course', 0],
    [alphaLeadingSpace, 1],
    [alphaTrailingSpace, 2],
  ]);
  assert.deepEqual(await membershipsOf(target, four.id), [
    ['Дизајн на софтвер', 0],
    [alphaCourse, 1],
  ]);
  assert.deepEqual(await membershipsOf(target, five.id), []);
  assert.deepEqual(await membershipsOf(target, six.id), [[betaCourse, 0]]);
  assert.deepEqual(report.historyIndex, {
    countMismatches: 1,
    entries: 7,
    indexedUsers: 5,
    memberships: 10,
    needsMapping: 7,
    users: 6,
  });
  // The raw scraper field is untouched: user one still counts three lines.
  const rawOne = await get(
    target,
    `/items/moodle_users/${one.id}?fields=Courses,Courses Count`,
  );
  assert.equal(rawOne['Courses Count'], 3);
  assert.equal(rawOne.Courses, one.Courses);

  assert.deepEqual(await act(target, indexPageBody(state, claim.token, {})), {
    entriesCreated: 0,
    membershipsRemoved: 10,
    membershipsWritten: 10,
    page: 'p0001',
    users: 6,
  });
  report = await status(target);
  assert.equal(
    report.revisions.source,
    before.revisions.source + 1,
    'a replay without new labels runs no entry statement',
  );
  assert.deepEqual(
    await act(target, { action: 'complete', token: claim.token }),
    {
      completed: true,
      domain: 'history_index',
      installed: 0,
      revision: report.revisions.source,
    },
  );
  report = await status(target);
  assert.equal(report.claim, null);
  assert.deepEqual(report.dirty, ['enrollments', 'publication']);
  assert.equal(report.revisions.completed, report.revisions.source);
  assert.equal(await count(target, 'moodle_history_memberships'), 10);
};

// An edited history plus a manual mapping, then the installed Flows end
// to end: the removed label keeps its entry and its mapping, the user's
// memberships are replaced, a new label arrives as needs_mapping.
const runsFlowsAfterEdit = async (target, state) => {
  const [one] = state.users;
  const entries = await entriesByLabel(target);
  const alpha = entries.get(alphaCourse);
  await patch(target, `${entriesPath}/${alpha.id}`, {
    review_reason: 'Checked by hand',
    review_state: 'mapped',
  });
  await createItem(target, 'moodle_course_mappings', {
    academic_year: state.year,
    course: state.course,
    entry: alpha.id,
  });
  await patch(target, `/items/moodle_users/${one.id}`, {
    Courses: 'Beta Course\nDelta Course',
  });
  let report = await status(target);
  assert.deepEqual(report.dirty, [
    'history_index',
    'enrollments',
    'publication',
  ]);

  const run = await rebuild(target);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.deepEqual(run.body, {
    completed: true,
    index: {
      entriesCreated: 1,
      failed: [],
      membershipsWritten: 10,
      ok: true,
      pages: 1,
      users: 6,
    },
    revision: run.body.revision,
  });
  assert.equal(typeof run.body.revision, 'number');
  report = await status(target);
  assert.equal(report.claim, null);
  assert.deepEqual(report.dirty, ['enrollments', 'publication']);
  assert.equal(report.revisions.completed, run.body.revision);
  assert.equal(report.lastError, null);
  assert.deepEqual(report.historyIndex, {
    countMismatches: 1,
    entries: 8,
    indexedUsers: 5,
    memberships: 10,
    needsMapping: 7,
    users: 6,
  });
  const after = await entriesByLabel(target);
  assert.deepEqual(after.get(alphaCourse), {
    id: alpha.id,
    label: alphaCourse,
    review_reason: 'Checked by hand',
    review_state: 'mapped',
  });
  assert.equal(after.get('Delta Course')?.review_state, 'needs_mapping');
  assert.equal(await count(target, 'moodle_course_mappings'), 1);
  assert.deepEqual(await membershipsOf(target, one.id), [
    [betaCourse, 0],
    ['Delta Course', 1],
  ]);
  const activity = await get(
    target,
    `/activity?fields=item&filter[collection][_eq]=directus_flows&filter[action][_eq]=run&limit=-1`,
  );
  assert.ok(
    activity.some(({ item }) => item === historyRunnerId),
    'the runner logs an activity row',
  );

  const idle = await rebuild(target);
  assert.equal(idle.status, 200, JSON.stringify(idle.body));
  assert.deepEqual(idle.body, { claimed: false, reason: 'nothing_pending' });
};

// Directus refuses every item write on the derived index with a 403 (the
// hook); a Flow that skips events reaches the database guard instead and
// fails. A deleted entry cascades its memberships through that guard,
// marks the index stale, and the next run brings the entry back as
// needs_mapping with the users' memberships.
const guardsMemberships = async (target, state) => {
  const [membership] = await get(
    target,
    `${membershipsPath}?fields=id,entry,sort&limit=1&sort=id`,
  );
  const attempts = [
    [
      'POST',
      membershipsPath,
      { entry: membership.entry, moodle_user: state.users[4].id, sort: 0 },
    ],
    ['PATCH', `${membershipsPath}/${membership.id}`, { sort: 7 }],
    ['DELETE', `${membershipsPath}/${membership.id}`, null],
  ];
  for (const [method, path, body] of attempts) {
    const response = await request(
      target,
      path,
      body === null
        ? { method, token: target.token }
        : json(method, body, target.token),
    );
    const answer = await response.json();
    assert.equal(response.status, 403, JSON.stringify(answer));
    assert.equal(errorCode(answer), derivedIndex);
  }
  await installProbeFlow(target);
  Object.assign(state, { probeInstalled: true });
  const probe = await trigger(target, `/flows/trigger/${probeFlowId}`, {
    collection: 'moodle_history_memberships',
    key: membership.id,
  });
  assert.equal(probe.status, 500, JSON.stringify(probe.body));
  assert.deepEqual(
    await get(target, `${membershipsPath}/${membership.id}?fields=id,sort`),
    { id: membership.id, sort: membership.sort },
  );
  assert.equal(await count(target, 'moodle_history_memberships'), 10);
  // The control: the same event-less delete succeeds on a collection the
  // guard does not cover.
  const labels = await entriesByLabel(target);
  const throwaway = await createItem(target, 'moodle_course_mappings', {
    academic_year: state.year,
    course: state.course,
    entry: labels.get('Gamma Course').id,
  });
  const control = await trigger(target, `/flows/trigger/${probeFlowId}`, {
    collection: 'moodle_course_mappings',
    key: throwaway.data.id,
  });
  assert.equal(control.status, 200, JSON.stringify(control.body));
  assert.equal(await count(target, 'moodle_course_mappings'), 1);
  await remove(target, `/flows/${probeFlowId}`);
  Object.assign(state, { probeInstalled: false });

  const before = await entriesByLabel(target);
  const beta = before.get(betaCourse);
  const carriers = await get(
    target,
    `${membershipsPath}?fields=id&filter[entry][_eq]=${beta.id}&limit=-1`,
  );
  assert.equal(carriers.length, 2);
  await remove(target, `${entriesPath}/${beta.id}`);
  let report = await status(target);
  assert.deepEqual(report.dirty, [
    'history_index',
    'enrollments',
    'publication',
  ]);
  assert.equal(report.historyIndex.memberships, 8);
  const run = await rebuild(target);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.completed, true);
  assert.deepEqual(run.body.index, {
    entriesCreated: 1,
    failed: [],
    membershipsWritten: 10,
    ok: true,
    pages: 1,
    users: 6,
  });
  const after = await entriesByLabel(target);
  const restored = after.get(betaCourse);
  assert.notEqual(restored.id, beta.id);
  assert.equal(restored.review_state, 'needs_mapping');
  assert.deepEqual(await membershipsOf(target, state.users[0].id), [
    [betaCourse, 0],
    ['Delta Course', 1],
  ]);
  report = await status(target);
  assert.deepEqual(report.pending, ['enrollments', 'publication']);
  assert.equal(report.historyIndex.memberships, 10);
};

// A page above the bound, duplicated users, a broken label and a stale
// token are refused before any write; the planned page stays unstaged so
// the completion is refused too; the failed run leaves the previous index
// in place and flagged stale until an explicit retry through the runner.
const refusesOversizedPage = async (target, state) => {
  await act(target, { action: 'mark', domains: ['history_index'] });
  const claim = await claimHistory(target);
  await act(target, {
    action: 'plan_pages',
    source: 'history',
    token: claim.token,
  });
  const oversized = Array.from({ length: 251 }, (_, index) => ({
    entries: ['Synthetic Oversized Course'],
    id: index + 1,
  }));
  const error = await refused(
    target,
    indexPageBody(state, claim.token, { rows: oversized }),
    invalidOptions,
  );
  assert.match(error.errors[0].message, rowsPattern);
  await refused(
    target,
    indexPageBody(state, claim.token, {
      rows: [...pageRows(state.users), pageRows(state.users)[0]],
    }),
    'COORDINATION_DUPLICATE_ROWS',
  );
  await refused(
    target,
    indexPageBody(state, claim.token, {
      rows: [{ entries: ['Broken\nLabel'], id: state.users[0].id }],
    }),
    invalidOptions,
  );
  await refused(
    target,
    indexPageBody(state, claim.token, { token: randomUUID() }),
    claimMismatch,
  );
  await refused(
    target,
    { action: 'complete', token: claim.token },
    'COORDINATION_PAGES_MISSING',
  );
  // The runner cannot claim while this claim is held, and says so.
  assert.match(
    refusedRun(await rebuild(target), 409, 'CLAIM_BUSY'),
    busyPattern,
  );
  let report = await status(target);
  assert.equal(report.claim.staged, 0);
  assert.equal(report.historyIndex.memberships, 10);
  assert.equal(report.historyIndex.entries, 8);
  assert.deepEqual(
    await act(target, {
      action: 'fail',
      code: failureCode,
      token: claim.token,
    }),
    {
      code: failureCode,
      domain: 'history_index',
      failed: true,
      revision: claim.revision,
    },
  );
  report = await status(target);
  assert.equal(report.claim, null);
  assert.equal(report.lastError.code, failureCode);
  assert.ok(
    report.pending.includes('history_index'),
    'the index is flagged stale',
  );
  assert.equal(report.historyIndex.memberships, 10);
  const entries = await entriesByLabel(target);
  assert.equal(entries.has('Synthetic Oversized Course'), false);

  const blocked = refusedRun(await rebuild(target), 409, retryRequired);
  assert.ok(
    blocked.includes(
      `failed at source revision ${claim.revision} (${failureCode})`,
    ),
    blocked,
  );
  const retried = await rebuild(target, { retry: true });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.completed, true);
  assert.deepEqual(retried.body.index, {
    entriesCreated: 0,
    failed: [],
    membershipsWritten: 10,
    ok: true,
    pages: 1,
    users: 6,
  });
  report = await status(target);
  assert.deepEqual(report.pending, ['enrollments', 'publication']);
  assert.equal(report.historyIndex.memberships, 10);
};

// A raw history with more distinct lines than one page row may carry fails
// its page inside the installed Flows: the page answers a failure record,
// the runner marks the run failed and answers a bounded 500, the previous
// index stays in place and flagged stale, a plain rerun at the same
// revision is refused, and once the source is fixed a plain rerun (a new
// revision, no retry switch) completes.
const failsOversizedHistoryThroughFlows = async (target, state) => {
  const lines = Array.from(
    { length: maxRowsPerPage + 1 },
    (_, index) => `Synthetic Oversized Line ${index}`,
  );
  const oversized = await create(target, state, [
    'moodle_users',
    {
      Courses: lines.join('\n'),
      [coursesCount]: lines.length,
      Name: 'Synthetic History User Oversized',
    },
  ]);
  let report = await status(target);
  assert.ok(report.pending.includes('history_index'));
  const revision = report.revisions.source;

  // The runner's bounded message names the page, the refusal and the
  // Moodle user whose raw history needs fixing.
  const failed = refusedRun(await rebuild(target), 500, 'INDEX_FAILED');
  assert.ok(
    failed.includes(
      `failed at page p0001 (index): ${invalidOptions} Invalid coordination options (rows.6.entries: Moodle user ${oversized}: ${maxRowsPerPage + 1} distinct history lines`,
    ),
    failed,
  );
  assert.ok(failed.length < 600, `${failed.length} characters`);
  report = await status(target);
  assert.equal(report.claim, null);
  assert.equal(report.lastError.code, 'INDEX_FAILED');
  assert.equal(report.revisions.source, revision, 'no entry was written');
  assert.ok(
    report.pending.includes('history_index'),
    'the index is flagged stale',
  );
  assert.deepEqual(report.historyIndex, {
    countMismatches: 2,
    entries: 8,
    indexedUsers: 5,
    memberships: 10,
    needsMapping: 7,
    users: 7,
  });
  const entries = await entriesByLabel(target);
  assert.equal(entries.has(lines[0]), false);

  refusedRun(await rebuild(target), 409, retryRequired);

  await remove(target, `/items/moodle_users/${oversized}`);
  state.items = state.items.filter(
    ([collection, id]) => collection !== 'moodle_users' || id !== oversized,
  );
  const fixed = await rebuild(target);
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.equal(fixed.body.completed, true, JSON.stringify(fixed.body));
  assert.deepEqual(fixed.body.index, {
    entriesCreated: 0,
    failed: [],
    membershipsWritten: 10,
    ok: true,
    pages: 1,
    users: 6,
  });
  report = await status(target);
  assert.equal(report.claim, null);
  assert.equal(report.revisions.completed, report.revisions.source);
  assert.deepEqual(report.pending, ['enrollments', 'publication']);
  assert.equal(report.historyIndex.memberships, 10);
};

// A history line longer than one entry may hold fails the run with a
// bounded message that names its Moodle user; editing that raw history
// fixes the next run without the retry switch.
const refusesOverlongLine = async (target, state) => {
  const line = `Synthetic Overlong Line ${'x'.repeat(maxLabelBytes)}`;
  const user = await create(target, state, [
    'moodle_users',
    {
      Courses: `${alphaCourse}\n${line}`,
      [coursesCount]: 2,
      Name: 'Synthetic History User Overlong',
    },
  ]);
  let report = await status(target);
  const revision = report.revisions.source;
  const failed = refusedRun(await rebuild(target), 500, 'INDEX_FAILED');
  assert.ok(
    failed.includes(
      `Moodle user ${user}: a history line of ${line.length} bytes, one entry holds at most ${maxLabelBytes} bytes`,
    ),
    failed,
  );
  assert.ok(failed.length < 600, `${failed.length} characters`);
  report = await status(target);
  assert.equal(report.revisions.source, revision, 'nothing was written');
  assert.equal(report.historyIndex.entries, 8);
  assert.equal(report.historyIndex.memberships, 10);
  refusedRun(await rebuild(target), 409, retryRequired);

  await patch(target, `/items/moodle_users/${user}`, {
    Courses: `${alphaCourse}\nSynthetic Shortened Line`,
  });
  const fixed = await rebuild(target);
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.deepEqual(fixed.body.index, {
    entriesCreated: 1,
    failed: [],
    membershipsWritten: 12,
    ok: true,
    pages: 1,
    users: 7,
  });
  const entries = await entriesByLabel(target);
  assert.equal(
    entries.get('Synthetic Shortened Line')?.review_state,
    'needs_mapping',
  );

  // Back to the six seeded users: the deletion marks the index again and
  // a plain run settles it; the new entry stays.
  await remove(target, `/items/moodle_users/${user}`);
  state.items = state.items.filter(
    ([collection, id]) => collection !== 'moodle_users' || id !== user,
  );
  const settled = await rebuild(target);
  assert.equal(settled.status, 200, JSON.stringify(settled.body));
  assert.deepEqual(settled.body.index, {
    entriesCreated: 0,
    failed: [],
    membershipsWritten: 10,
    ok: true,
    pages: 1,
    users: 6,
  });
  report = await status(target);
  assert.deepEqual(report.pending, ['enrollments', 'publication']);
  assert.equal(report.historyIndex.entries, 9);
};

// Directus lets anyone who may read moodle_users trigger a manual Flow on
// it; the synthetic runner, like every data-operations Flow, refuses a
// non-administrator in its first operation.
const gatesNonAdministrators = async (target) => {
  const before = await status(target);
  await withReader(target, async (token) => {
    const run = await rebuildAs(target, token);
    assert.equal(
      refusedRun(run, 403, 'FORBIDDEN'),
      'Only administrators may rebuild the Moodle history index.',
    );
  });
  const after = await status(target);
  assert.equal(after.claim, null);
  assert.deepEqual(after.revisions, before.revisions);
  assert.deepEqual(after.lastError, before.lastError);
  assert.deepEqual(
    await get(
      target,
      `/policies?fields=id&filter[name][_starts_with]=${encodeURIComponent(readerPolicyPrefix)}&limit=-1`,
    ),
    [],
  );
};

// The writer serves the history domain only; an enrollment claim is
// refused and released cleanly. Since Task 12 the coordinator refuses to
// plan the Moodle users under it at all, so no history page is planned
// for the writer to be offered; the writer's own domain check is covered
// by the unit suite.
const refusesForeignDomain = async (target, state) => {
  const claim = await act(target, { action: 'claim', domain: 'enrollments' });
  assert.equal(claim.claimed, true, JSON.stringify(claim));
  await refused(
    target,
    { action: 'plan_pages', source: 'history', token: claim.token },
    'COORDINATION_DOMAIN_MISMATCH',
  );
  await refused(
    target,
    {
      action: 'index_page',
      page: 'p0001',
      rows: pageRows(state.users),
      token: claim.token,
    },
    'COORDINATION_PAGE_UNPLANNED',
  );
  const rules = await act(target, {
    action: 'plan_pages',
    source: 'rules',
    token: claim.token,
  });
  assert.equal(rules.total, 0);
  assert.deepEqual(
    await act(target, { action: 'complete', token: claim.token }),
    {
      completed: true,
      domain: 'enrollments',
      installed: 0,
      revision: claim.revision,
    },
  );
  const report = await status(target);
  assert.deepEqual(report.pending, ['publication']);
  assert.equal(report.historyIndex.memberships, 10);
};

// More users than one page holds: the installed runner plans two pages
// and the Trigger Flow indexes both serially inside the same run, the
// second page after the first one's entry statement moved the revision.
const indexesSeveralPages = async (target, state) => {
  await post(
    target,
    '/items/moodle_users',
    Array.from({ length: pageSize + 1 }, (_, index) => ({
      Courses: bulkCourse,
      [coursesCount]: 1,
      Name: `${bulkUserPrefix}${index + 1}`,
    })),
  );
  const bulk = await get(
    target,
    `/items/moodle_users?fields=id&filter[Name][_starts_with]=${encodeURIComponent(bulkUserPrefix)}&sort=id&limit=-1`,
  );
  Object.assign(state, { bulkUsers: bulk.map(({ id }) => id) });
  assert.equal(state.bulkUsers.length, pageSize + 1);
  const run = await rebuild(target);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.completed, true);
  assert.deepEqual(run.body.index, {
    entriesCreated: 1,
    failed: [],
    membershipsWritten: 10 + pageSize + 1,
    ok: true,
    pages: 2,
    users: 6 + pageSize + 1,
  });
  const report = await status(target);
  assert.equal(report.claim, null);
  assert.equal(report.revisions.completed, run.body.revision);
  assert.equal(report.revisions.completed, report.revisions.source);
  assert.deepEqual(report.pending, ['enrollments', 'publication']);
  assert.equal(report.historyIndex.users, 6 + pageSize + 1);
  assert.equal(report.historyIndex.memberships, 10 + pageSize + 1);
  assert.deepEqual(await membershipsOf(target, state.bulkUsers.at(-1)), [
    [bulkCourse, 0],
  ]);
  await read(
    await request(
      target,
      '/items/moodle_users',
      json('DELETE', state.bulkUsers, target.token),
    ),
    204,
  );
  Object.assign(state, { bulkUsers: [] });
  assert.equal(await count(target, 'moodle_history_memberships'), 10);
};

const cleansUp = async (target, state) => {
  if (state.flowInstalled) {
    await remove(target, `/flows/${flowId}`);
  }
  if (state.runnerInstalled) {
    await removeHistoryRunner(target);
  }
  if (state.probeInstalled) {
    await remove(target, `/flows/${probeFlowId}`);
  }
  if (state.bulkUsers.length > 0) {
    await read(
      await request(
        target,
        '/items/moodle_users',
        json('DELETE', state.bulkUsers, target.token),
      ),
      204,
    );
  }
  const created = state.templatesCreated;
  for (const id of created) {
    await remove(target, `/flows/${id}`);
  }
  const flows = await get(target, '/flows?fields=id&limit=-1');
  assert.ok(
    flows.every(({ id }) => id !== flowId),
    'the QA flow is gone',
  );
  for (const id of created) {
    assert.ok(
      flows.every((flow) => flow.id !== id),
      'a created template is gone',
    );
  }
  for (const [collection, id] of state.items) {
    await remove(target, `/items/${collection}/${id}`);
  }
  const entries = await get(target, `${entriesPath}?fields=id&limit=-1`);
  for (const { id } of entries) {
    await remove(target, `${entriesPath}/${id}`);
  }
  for (const collection of dataModelCollectionKeys) {
    if (collection === 'data_operations') continue;
    assert.equal(
      await count(target, collection),
      0,
      `${collection} must be empty again`,
    );
  }
};

test('indexes raw Moodle histories into durable entries and replaceable memberships', async (t) => {
  const target = targetFrom(process.env);
  const directus = adminRequest(target);
  const state = {
    bulkUsers: [],
    flowInstalled: false,
    items: [],
    probeInstalled: false,
    runnerInstalled: false,
    templatesCreated: [],
  };

  await withDataModel(target, async () => {
    try {
      await installDataModel(directus);
      await applySchemaConstraints(directus);
      await applySourceInvalidation(directus);
      await t.test('installs the history index flows once', () =>
        installsFlows(target, directus, state),
      );
      await t.test('seeds synthetic raw histories', () =>
        seedsHistories(target, state),
      );
      await t.test(
        'indexes one page through the coordinator and completes at the adopted revision',
        () => indexesThroughCoordinator(target, state),
      );
      await t.test(
        'runs the installed flows end to end after an edit and keeps the manual mapping',
        () => runsFlowsAfterEdit(target, state),
      );
      await t.test(
        'refuses membership writes outside the index run and re-indexes a deleted entry',
        () => guardsMemberships(target, state),
      );
      await t.test(
        'refuses an oversized page with a bounded error and flags the prior index stale',
        () => refusesOversizedPage(target, state),
      );
      await t.test(
        'fails the installed run on an oversized history and keeps the prior index stale until the source is fixed',
        () => failsOversizedHistoryThroughFlows(target, state),
      );
      await t.test(
        'fails the run on an over-long history line naming its user until the raw history is fixed',
        () => refusesOverlongLine(target, state),
      );
      await t.test('refuses the runner to a non-administrator', () =>
        gatesNonAdministrators(target),
      );
      await t.test('refuses index pages under an enrollment claim', () =>
        refusesForeignDomain(target, state),
      );
      await t.test(
        'indexes two planned pages serially in one run of the installed flows',
        () => indexesSeveralPages(target, state),
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
