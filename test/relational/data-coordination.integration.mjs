import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import { dataModelCollectionKeys } from '../../src/data-model/collections.js';
import {
  applySchemaConstraints,
  applySourceInvalidation,
} from '../../src/data-model/constraints.js';
import { installDataModel } from '../../src/data-model/install.js';
import { targetFrom } from '../search-integration-helpers.mjs';
import {
  adminRequest,
  assertMarkerPresent,
  createItem,
  errorCode,
  json,
  read,
  request,
  userCollections,
  withDataModel,
} from './data-model-helpers.mjs';

const runCommand = promisify(execFile);
const flowId = '9e4d826c-5b1a-4c0e-8f2d-000000000501';
const operationId = '9e4d826c-5b1a-4c0e-8f2d-000000000502';
const operationType = 'finki-hub-data-coordinate';
const statusPath = '/finki-hub-data-operations/status';
const triggerPath = `/flows/trigger/${flowId}`;
const containerPattern = /^[a-z0-9][a-z0-9_.-]{0,127}$/u;
const uuidPattern = /^[0-9a-f-]{36}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const expectedStatements = 22;
const allDomains = ['history_index', 'enrollments', 'publication'];
const optionKeys = [
  'action',
  'domain',
  'domains',
  'token',
  'page',
  'rows',
  'source',
  'code',
  'retry',
  'files',
];
const blankBody = Object.fromEntries(optionKeys.map((key) => [key, null]));
const templatedOptions = Object.fromEntries(
  optionKeys.map((key) => [key, `{{ $trigger.body.${key} }}`]),
);
const restartContainer = process.env.DIRECTUS_COORDINATION_RESTART_CONTAINER;
const claimMismatch = 'COORDINATION_CLAIM_MISMATCH';
const pageUnplanned = 'COORDINATION_PAGE_UNPLANNED';

const get = async (target, path) => {
  const body = await read(
    await request(target, path, { token: target.token }),
    200,
  );
  return body.data;
};

const remove = async (target, path) =>
  read(
    await request(target, path, { method: 'DELETE', token: target.token }),
    204,
  );

const patch = async (target, path, body) =>
  read(await request(target, path, json('PATCH', body, target.token)), 200);

const post = async (target, path, body) =>
  read(await request(target, path, json('POST', body, target.token)), 200);

const status = (target) => get(target, statusPath);

const count = async (target, collection) => {
  const rows = await get(target, `/items/${collection}?aggregate[count]=*`);
  return Number(rows[0]?.count ?? 0);
};

// Invokes the synthetic manual Flow. A 200 carries the raw `$last` value
// (no data envelope), a 204 a falsy value, an error status the Directus
// error body that error_on_reject surfaces.
const invoke = async (target, body) => {
  const response = await request(
    target,
    triggerPath,
    json(
      'POST',
      { collection: 'data_operations', ...blankBody, ...body },
      target.token,
    ),
  );
  const text = await response.text();
  return {
    body: text === '' ? null : JSON.parse(text),
    status: response.status,
  };
};

const act = async (target, body) => {
  const outcome = await invoke(target, body);
  assert.equal(
    outcome.status,
    200,
    `${body.action} answered HTTP ${outcome.status}: ${JSON.stringify(outcome.body)}`,
  );
  return outcome.body;
};

// Invalid options and duplicate rows are 400s; every other refusal is a 409.
const statusOfCode = (code) =>
  code === 'COORDINATION_INVALID_OPTIONS' ||
  code === 'COORDINATION_DUPLICATE_ROWS'
    ? 400
    : 409;

const refused = async (target, body, code) => {
  const outcome = await invoke(target, body);
  assert.equal(
    outcome.status,
    statusOfCode(code),
    JSON.stringify(outcome.body),
  );
  assert.equal(errorCode(outcome.body), code);
  return outcome.body;
};

const claimNow = (target, domain, retry = null) =>
  act(target, { action: 'claim', domain, retry });

const installFlow = async (target) => {
  await post(target, '/flows', {
    accountability: 'activity',
    description:
      'Synthetic coordination QA; removed by the test that installs it.',
    icon: 'sync_lock',
    id: flowId,
    name: 'Synthetic coordination QA',
    options: {
      async: false,
      collections: ['data_operations'],
      error_on_reject: true,
      requireSelection: false,
    },
    status: 'inactive',
    trigger: 'manual',
  });
  await post(target, '/operations', {
    flow: flowId,
    id: operationId,
    key: 'coordinate',
    name: 'Coordinate',
    options: templatedOptions,
    position_x: 19,
    position_y: 1,
    type: operationType,
  });
  await patch(target, `/flows/${flowId}`, {
    operation: operationId,
    status: 'active',
  });
};

const waitForDirectus = async (target) => {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      const response = await fetch(new URL('/server/ping', target.base), {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 200) return attempt;
    } catch {
      // The container is still starting; try again.
    }
    await sleep(1_000);
  }
  assert.fail('Directus did not answer /server/ping after the restart');
  return -1;
};

const restartDirectus = async (target) => {
  assert.match(restartContainer, containerPattern);
  await runCommand('docker', ['restart', restartContainer]);
  return waitForDirectus(target);
};

// Creates a synthetic item and remembers it for the cleanup.
const create = async (target, state, [collection, item]) => {
  const created = await createItem(target, collection, item);
  state.items.unshift([collection, created.data.id]);
  return created.data.id;
};

const appliesInvalidationTwice = async (target, directus) => {
  const first = await applySourceInvalidation(directus);
  const second = await applySourceInvalidation(directus);
  assert.deepEqual(first, {
    applied: 'source-invalidation',
    statements: expectedStatements,
  });
  assert.deepEqual(second, first);
  const singleton = await get(target, '/items/data_operations');
  assert.notEqual(singleton.id, null, 'the migration creates the status row');
  assert.equal(singleton.source_revision, 0);
  assert.equal(singleton.claim_token, null);
};

const installsFlow = async (target, state) => {
  await installFlow(target);
  state.flowInstalled = true;
  const flow = await get(
    target,
    `/flows/${flowId}?fields=status,operation,trigger,accountability`,
  );
  assert.deepEqual(flow, {
    accountability: 'activity',
    operation: operationId,
    status: 'active',
    trigger: 'manual',
  });
  const report = await status(target);
  assert.equal(report.claim, null);
  assert.deepEqual(report.pending, allDomains);
  assert.deepEqual(report.dirty, []);
  assert.deepEqual(report.revisions, { completed: 0, requested: 0, source: 0 });
  assert.match(report.fingerprints.current, sha256Pattern);
  assert.equal(report.fingerprints.calculation, null);
  assert.equal(report.lastError, null);
  const viaFlow = await act(target, { action: 'status' });
  assert.equal(viaFlow.revisions.source, 0);
  assert.equal(viaFlow.process, report.process);
  await refused(
    target,
    { action: 'complete', token: 'not-a-uuid' },
    'COORDINATION_INVALID_OPTIONS',
  );
};

// Every source statement bumps the revision inside its own transaction; a
// statement the database rejects and a derived-table write bump nothing.
const recordsSourceStatements = async (target, state) => {
  const courseA = await create(target, state, [
    'courses',
    { name: 'Synthetic Coordination Course A' },
  ]);
  let report = await status(target);
  assert.equal(report.revisions.source, 1);
  assert.deepEqual(report.dirty, ['publication']);
  const courseB = await create(target, state, [
    'courses',
    { name: 'Synthetic Coordination Course B' },
  ]);
  const yearA = await create(target, state, [
    'academic_years',
    { label: '2031/2032', sort: 1 },
  ]);
  report = await status(target);
  assert.equal(report.revisions.source, 3);
  assert.deepEqual(report.dirty, ['enrollments', 'publication']);
  const yearB = await create(target, state, [
    'academic_years',
    { label: '2032/2033', sort: 2 },
  ]);
  const userId = await create(target, state, [
    'moodle_users',
    { Name: 'Synthetic Coordination User' },
  ]);
  report = await status(target);
  assert.equal(report.revisions.source, 5);
  assert.deepEqual(report.dirty, allDomains);
  const ruleIds = [];
  for (const [course, year] of [
    [courseA, yearA],
    [courseB, yearA],
    [courseA, yearB],
  ]) {
    const rule = await create(target, state, [
      'course_enrollment_rules',
      { academic_year: year, course, mode: 'mapped_entries' },
    ]);
    ruleIds.push(rule);
  }
  Object.assign(state, { courseA, courseB, ruleIds, userId, yearA, yearB });
  const duplicate = await request(
    target,
    '/items/academic_years',
    json('POST', { label: '2031/2032' }, target.token),
  );
  assert.equal(duplicate.status, 400);
  assert.equal(errorCode(await duplicate.json()), 'RECORD_NOT_UNIQUE');
  await createItem(target, 'course_enrollments', {
    academic_year: yearB,
    computed_at: '2026-09-22T00:00:00Z',
    computed_revision: 0,
    count: 42,
    course: courseB,
  });
  report = await status(target);
  assert.equal(
    report.revisions.source,
    8,
    'a rejected statement and a derived-table write mark nothing',
  );
  await patch(target, `/items/courses/${courseB}`, {
    name: 'Synthetic Coordination Course B (renamed)',
  });
  report = await status(target);
  assert.equal(report.revisions.source, 9, 'an update statement counts');
  const marked = await act(target, {
    action: 'mark',
    domains: ['publication'],
  });
  assert.deepEqual(marked, { domains: allDomains, revision: 10 });
  const raw = await get(target, '/items/data_operations');
  assert.equal(raw.source_revision, 10);
  assert.equal(raw.requested_revision, 10);
  assert.deepEqual(raw.dirty_domains, allDomains);
};

const claimsOnce = async (target, state) => {
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      invoke(target, { action: 'claim', domain: 'history_index' }),
    ),
  );
  for (const outcome of results) {
    assert.equal(outcome.status, 200, JSON.stringify(outcome.body));
  }
  const winners = results.filter(({ body }) => body.claimed === true);
  const losers = results.filter(({ body }) => body.claimed === false);
  assert.equal(winners.length, 1, 'exactly one of twenty claims wins');
  assert.equal(losers.length, 19);
  assert.deepEqual(
    new Set(losers.map(({ body }) => body.reason)),
    new Set(['busy']),
  );
  const winner = winners[0].body;
  assert.match(winner.token, uuidPattern);
  assert.equal(winner.revision, 10);
  assert.deepEqual(winner.domains, allDomains);
  state.owner = winner.owner;
  const second = await claimNow(target, 'history_index');
  assert.deepEqual(second, {
    claimed: false,
    domain: 'history_index',
    owner: winner.owner,
    reason: 'busy',
  });
  let report = await status(target);
  assert.equal(report.claim.owner, winner.owner);
  assert.equal(report.claim.ownedByThisProcess, true);
  assert.equal(report.claim.stale, false);
  assert.equal(report.claim.domain, 'history_index');
  assert.ok(
    !JSON.stringify(report).includes(winner.token),
    'the status never carries the token',
  );
  assert.deepEqual(
    await act(target, { action: 'heartbeat', token: winner.token }),
    { heartbeat: true },
  );
  assert.deepEqual(
    await act(target, { action: 'complete', token: winner.token }),
    { completed: true, domain: 'history_index', installed: 0, revision: 10 },
  );
  report = await status(target);
  assert.equal(report.claim, null);
  assert.deepEqual(report.dirty, ['enrollments', 'publication']);
  assert.equal(report.fingerprints.calculation, report.fingerprints.current);
  assert.equal(report.revisions.completed, 10);
  assert.deepEqual(await claimNow(target, 'publication'), {
    blocking: ['enrollments'],
    claimed: false,
    reason: 'upstream_dirty',
  });
};

const refusesStaleCompletion = async (target, state) => {
  const claim = await claimNow(target, 'enrollments');
  assert.equal(claim.claimed, true);
  assert.equal(claim.revision, 10);
  await create(target, state, [
    'rooms',
    { location: 'Synthetic Building', name: 'Synthetic Coordination Room' },
  ]);
  const error = await refused(
    target,
    { action: 'complete', token: claim.token },
    'COORDINATION_SOURCE_CHANGED',
  );
  assert.equal(error.errors[0].extensions.reason, 'SOURCE_CHANGED');
  const report = await status(target);
  assert.equal(report.claim, null);
  assert.deepEqual(report.dirty, ['enrollments', 'publication']);
  assert.equal(report.lastError.code, 'SOURCE_CHANGED');
  assert.equal(report.lastError.domain, 'enrollments');
  assert.equal(report.lastError.revision, 10);
  assert.equal(report.candidates, 0);
  assert.equal(report.revisions.completed, 10);
  assert.equal(report.revisions.source, 11);
  assert.equal(await count(target, 'data_operation_results'), 0);
  await refused(
    target,
    { action: 'heartbeat', token: claim.token },
    claimMismatch,
  );
  assert.deepEqual(
    await act(target, { action: 'fail', code: 'late', token: claim.token }),
    { failed: false, reason: 'claim_mismatch' },
  );
};

const stagesPages = async (target, state) => {
  const claim = await claimNow(target, 'enrollments');
  assert.equal(claim.claimed, true);
  assert.equal(claim.revision, 11);
  state.token = claim.token;
  const again = await claimNow(target, 'enrollments');
  assert.equal(again.reason, 'busy');
  const rows = [
    { academic_year: state.yearA, count: 2, course: state.courseA },
    { academic_year: state.yearA, count: 5, course: state.courseB },
  ];
  const page = (body) => ({
    action: 'stage_page',
    page: 'p0001',
    rows,
    token: claim.token,
    ...body,
  });
  await refused(target, page({}), pageUnplanned);
  // A first plan over the Moodle users, one page staged under it; the plan
  // over the rules that follows must discard that page's candidates.
  const replaced = await act(target, {
    action: 'plan_pages',
    source: 'history',
    token: claim.token,
  });
  assert.deepEqual(replaced, {
    discarded: 0,
    pages: [{ from: state.userId, rows: 1, to: state.userId, token: 'p0001' }],
    source: 'history',
    total: 1,
  });
  assert.deepEqual(await act(target, page({ rows: [rows[0]] })), {
    page: 'p0001',
    replaced: 0,
    staged: 1,
  });
  assert.equal(await count(target, 'data_operation_results'), 1);
  const plan = await act(target, {
    action: 'plan_pages',
    source: 'rules',
    token: claim.token,
  });
  assert.deepEqual(plan, {
    discarded: 1,
    pages: [
      {
        from: Math.min(...state.ruleIds),
        rows: 3,
        to: Math.max(...state.ruleIds),
        token: 'p0001',
      },
    ],
    source: 'rules',
    total: 1,
  });
  assert.equal(
    await count(target, 'data_operation_results'),
    0,
    'a new plan discards the candidates of the plan it replaces',
  );
  let report = await status(target);
  assert.equal(report.claim.pages, 1);
  assert.equal(report.claim.staged, 0);
  assert.equal(report.candidates, 0);
  assert.deepEqual(await act(target, page({})), {
    page: 'p0001',
    replaced: 0,
    staged: 2,
  });
  assert.deepEqual(await act(target, page({})), {
    page: 'p0001',
    replaced: 2,
    staged: 2,
  });
  assert.equal(await count(target, 'data_operation_results'), 2);
  const candidates = await get(
    target,
    '/items/data_operation_results?fields=course,academic_year,count,page_token,revision&sort=course',
  );
  assert.deepEqual(candidates, [
    {
      academic_year: state.yearA,
      count: 2,
      course: state.courseA,
      page_token: 'p0001',
      revision: 11,
    },
    {
      academic_year: state.yearA,
      count: 5,
      course: state.courseB,
      page_token: 'p0001',
      revision: 11,
    },
  ]);
  await refused(target, page({ page: 'p0002' }), pageUnplanned);
  await refused(
    target,
    page({ rows: [...rows, { ...rows[0], count: 9 }] }),
    'COORDINATION_DUPLICATE_ROWS',
  );
  await refused(
    target,
    { action: 'complete', token: randomUUID() },
    claimMismatch,
  );
  await refused(target, page({ token: randomUUID() }), claimMismatch);
  report = await status(target);
  assert.equal(report.claim.pages, 1);
  assert.equal(report.claim.staged, 1);
  assert.equal(report.candidates, 2);
};

const installsCounts = async (target, state) => {
  assert.deepEqual(
    await act(target, { action: 'complete', token: state.token }),
    { completed: true, domain: 'enrollments', installed: 2, revision: 11 },
  );
  const installed = await get(
    target,
    '/items/course_enrollments?fields=course,academic_year,count,computed_revision&sort=course',
  );
  assert.deepEqual(installed, [
    {
      academic_year: state.yearA,
      computed_revision: 11,
      count: 2,
      course: state.courseA,
    },
    {
      academic_year: state.yearA,
      computed_revision: 11,
      count: 5,
      course: state.courseB,
    },
  ]);
  assert.equal(await count(target, 'data_operation_results'), 0);
  const report = await status(target);
  assert.equal(report.claim, null);
  assert.deepEqual(report.dirty, ['publication']);
  assert.deepEqual(report.pending, ['publication']);
  assert.equal(report.revisions.completed, 11);
  assert.equal(
    report.revisions.source,
    11,
    'installing derived rows marks nothing',
  );
  await refused(
    target,
    { action: 'complete', token: state.token },
    claimMismatch,
  );
};

const refusesGraphChange = async (target) => {
  const claim = await claimNow(target, 'publication');
  assert.equal(claim.claimed, true);
  await patch(target, `/operations/${operationId}`, {
    options: { ...templatedOptions, probe: 'graph changed' },
  });
  await refused(
    target,
    { action: 'complete', token: claim.token },
    'COORDINATION_FINGERPRINT_CHANGED',
  );
  let report = await status(target);
  assert.equal(report.claim, null);
  assert.deepEqual(report.dirty, ['publication']);
  assert.deepEqual(
    report.pending,
    allDomains,
    'a changed graph makes every domain pending again',
  );
  assert.equal(report.lastError.code, 'FINGERPRINT_CHANGED');
  assert.notEqual(report.fingerprints.current, claim.fingerprint);
  assert.equal(report.publication.state, 'idle');
  await patch(target, `/operations/${operationId}`, {
    options: templatedOptions,
  });
  report = await status(target);
  assert.equal(
    report.fingerprints.current,
    claim.fingerprint,
    'the fingerprint is deterministic over the graph',
  );
  assert.deepEqual(report.pending, ['publication']);
};

const retriesFailure = async (target) => {
  const claim = await claimNow(target, 'publication');
  assert.equal(claim.claimed, true);
  assert.deepEqual(
    await act(target, {
      action: 'fail',
      code: 'synthetic_publish_failure',
      token: claim.token,
    }),
    {
      code: 'SYNTHETIC_PUBLISH_FAILURE',
      domain: 'publication',
      failed: true,
      revision: 11,
    },
  );
  let report = await status(target);
  assert.equal(report.publication.state, 'failed');
  assert.equal(report.lastError.code, 'SYNTHETIC_PUBLISH_FAILURE');
  assert.equal(report.lastError.revision, 11);
  assert.deepEqual(await claimNow(target, 'publication'), {
    claimed: false,
    error: 'SYNTHETIC_PUBLISH_FAILURE',
    reason: 'failed',
    revision: 11,
  });
  const retried = await claimNow(target, 'publication', true);
  assert.equal(retried.claimed, true);
  const files = {
    courses: 'published',
    rooms: 'published',
    staff: 'published',
    students: 'skipped',
  };
  assert.deepEqual(
    await act(target, { action: 'complete', files, token: retried.token }),
    { completed: true, domain: 'publication', installed: 0, revision: 11 },
  );
  report = await status(target);
  assert.equal(report.publication.state, 'completed');
  assert.deepEqual(report.publication.files, files);
  assert.deepEqual(report.pending, []);
  assert.deepEqual(report.dirty, []);
  assert.equal(report.fingerprints.publication, report.fingerprints.current);
  assert.deepEqual(await claimNow(target, 'publication'), {
    claimed: false,
    reason: 'nothing_pending',
  });
  const raw = await get(target, '/items/data_operations');
  assert.equal(raw.publication_state, 'completed');
  assert.equal(raw.publish_students_outcome, 'skipped');
  assert.equal(raw.claim_token, null);
  assert.notEqual(raw.finished_at, null);
};

// The claim of a process that is gone stops heartbeating. Right after the
// restart it is still busy (a timeout alone steals nothing); once its
// heartbeat is older than the window the next claim attempt releases it as
// abandoned, keeps the failure details, and an explicit retry succeeds.
const recoversAfterRestart = async (target, state) => {
  await create(target, state, [
    'discord_channels',
    {
      channel: 'synthetic-coordination',
      course_names: 'Synthetic Coordination Course A',
      semester: 1,
    },
  ]);
  const claim = await claimNow(target, 'publication');
  assert.equal(claim.claimed, true);
  assert.equal(claim.revision, 12);
  const attempts = await restartDirectus(target);
  Object.assign(state, { restart: { attempts, owner: claim.owner } });
  let report = await status(target);
  assert.notEqual(report.process, claim.owner, 'the process identity changed');
  assert.equal(report.claim.owner, claim.owner);
  assert.equal(report.claim.ownedByThisProcess, false);
  await refused(
    target,
    { action: 'complete', token: claim.token },
    'COORDINATION_OWNER_MISMATCH',
  );
  const early = await claimNow(target, 'publication');
  assert.equal(
    early.reason,
    'busy',
    'a live-looking claim is not stolen by time alone',
  );
  let outcome = early;
  for (
    let attempt = 0;
    attempt < 30 && outcome.reason === 'busy';
    attempt += 1
  ) {
    await sleep(5_000);
    outcome = await claimNow(target, 'publication');
  }
  assert.deepEqual(outcome, {
    claimed: false,
    error: 'CLAIM_ABANDONED',
    reason: 'failed',
    revision: 12,
  });
  report = await status(target);
  assert.equal(report.claim, null);
  assert.deepEqual(report.pending, ['publication']);
  assert.equal(report.lastError.code, 'CLAIM_ABANDONED');
  assert.equal(report.lastError.domain, 'publication');
  assert.equal(report.lastError.revision, 12);
  assert.equal(report.publication.state, 'failed');
  const fresh = await claimNow(target, 'publication', true);
  assert.equal(fresh.claimed, true);
  assert.notEqual(fresh.owner, claim.owner);
  assert.equal(fresh.owner, report.process);
  assert.deepEqual(
    await act(target, { action: 'complete', token: fresh.token }),
    { completed: true, domain: 'publication', installed: 0, revision: 12 },
  );
  report = await status(target);
  assert.deepEqual(report.pending, []);
  assert.equal(report.revisions.completed, 12);
};

const cleansUp = async (target, state) => {
  if (state.flowInstalled) {
    await remove(target, `/flows/${flowId}`);
    const flows = await get(target, '/flows?fields=id');
    assert.ok(
      flows.every(({ id }) => id !== flowId),
      'the QA flow is gone',
    );
  }
  for (const collection of ['course_enrollments', 'data_operation_results']) {
    const rows = await get(target, `/items/${collection}?fields=id&limit=-1`);
    for (const row of rows) {
      await remove(target, `/items/${collection}/${row.id}`);
    }
  }
  for (const [collection, id] of state.items) {
    await remove(target, `/items/${collection}/${id}`);
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

test('coordinates data operations with atomic claims, transaction-bound invalidation and restart recovery', async (t) => {
  const target = targetFrom(process.env);
  const directus = adminRequest(target);
  const state = { flowInstalled: false, items: [] };

  await withDataModel(target, async () => {
    try {
      await installDataModel(directus);
      await applySchemaConstraints(directus);
      await t.test('applies the source-invalidation migration twice', () =>
        appliesInvalidationTwice(target, directus),
      );
      await t.test(
        'installs the synthetic manual flow and reports an idle status',
        () => installsFlow(target, state),
      );
      await t.test(
        'records every source statement inside its own transaction',
        () => recordsSourceStatements(target, state),
      );
      await t.test('lets exactly one of twenty concurrent claims through', () =>
        claimsOnce(target, state),
      );
      await t.test(
        'keeps a source change during a run pending and refuses the completion',
        () => refusesStaleCompletion(target, state),
      );
      await t.test(
        'stages a retried page once and rejects unplanned pages, duplicates and wrong tokens',
        () => stagesPages(target, state),
      );
      await t.test(
        'installs aggregated counts atomically and drops the candidates',
        () => installsCounts(target, state),
      );
      await t.test(
        'refuses output when the managed flow graph changed mid-run',
        () => refusesGraphChange(target),
      );
      await t.test('keeps a failed job failed until an explicit retry', () =>
        retriesFailure(target),
      );
      await t.test(
        'releases the claim of a restarted process for an explicit retry',
        {
          skip:
            restartContainer === undefined
              ? 'DIRECTUS_COORDINATION_RESTART_CONTAINER is not set'
              : false,
        },
        () => recoversAfterRestart(target, state),
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
