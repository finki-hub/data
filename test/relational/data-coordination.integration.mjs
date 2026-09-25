import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import { declaredFilenames as publicFiles } from '../../directus/extensions/directus-extension-data-operations/src/coordination/outcomes.js';
import { sourceInvalidation } from '../../directus/extensions/directus-extension-data-operations/src/migrations.js';
import { ruleMode } from '../../directus/extensions/directus-extension-data-operations/src/rule-modes.js';
import { dataModelCollectionKeys } from '../../src/data-model/collections.js';
import {
  applySchemaConstraints,
  applySourceInvalidation,
} from '../../src/data-model/constraints.js';
import { installDataModel } from '../../src/data-model/install.js';
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

const runCommand = promisify(execFile);
const flowId = '9e4d826c-5b1a-4c0e-8f2d-000000000501';
const operationId = '9e4d826c-5b1a-4c0e-8f2d-000000000502';
const operationType = 'finki-hub-data-coordinate';
const statusPath = '/finki-hub-data-operations/status';
const triggerPath = `/flows/trigger/${flowId}`;
const containerPattern = /^[a-z0-9][a-z0-9_.-]{0,127}$/u;
const uuidPattern = /^[0-9a-f-]{36}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
// The singleton row and index, the function, one trigger per source table
// of the collection-role registry (the optional ones guarded) and the
// entry label trigger of Task 13.
const expectedStatements = sourceInvalidation.statements.length;
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
  'filename',
  'outcome',
  'bytes',
];
const blankBody = Object.fromEntries(optionKeys.map((key) => [key, null]));
const templatedOptions = Object.fromEntries(
  optionKeys.map((key) => [key, `{{ $trigger.body.${key} }}`]),
);
const restartContainer = process.env.DIRECTUS_COORDINATION_RESTART_CONTAINER;
const claimMismatch = 'COORDINATION_CLAIM_MISMATCH';
const pageUnplanned = 'COORDINATION_PAGE_UNPLANNED';
const unrecordedUpload = /without being recorded/u;

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
// A publication completes with every declared file uploaded.
const everyFileUploaded = Object.fromEntries(
  publicFiles.map((filename) => [filename, { outcome: 'uploaded' }]),
);

const badRequestCodes = new Set([
  'COORDINATION_DUPLICATE_ROWS',
  'COORDINATION_INVALID_OPTIONS',
  'COORDINATION_UNKNOWN_FILE',
]);

const statusOfCode = (code) => (badRequestCodes.has(code) ? 400 : 409);

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
  assert.deepEqual(report.revisions, {
    completed: 0,
    inputs: { enrollments: 0, history_index: 0 },
    requested: 0,
    source: 0,
  });
  // The probe's templated coordinate step roots both graphs.
  assert.match(report.fingerprints.current.calculation, sha256Pattern);
  assert.match(report.fingerprints.current.publication, sha256Pattern);
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
  // Derived counts are guarded: the REST write is refused before any
  // statement runs, and derived tables carry no invalidation trigger.
  const derived = await request(
    target,
    '/items/course_enrollments',
    json(
      'POST',
      {
        academic_year: yearB,
        computed_at: '2026-09-22T00:00:00Z',
        computed_revision: 0,
        count: 42,
        course: courseB,
      },
      target.token,
    ),
  );
  assert.equal(derived.status, 403);
  assert.equal(errorCode(await derived.json()), 'COORDINATION_WRITE_GUARDED');
  report = await status(target);
  assert.equal(
    report.revisions.source,
    8,
    'a rejected statement and a refused derived-table write mark nothing',
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
  // A history run completes only after it planned and indexed its pages;
  // the one synthetic user has no raw history, so nothing is written.
  await refused(
    target,
    { action: 'complete', token: winner.token },
    'COORDINATION_PAGES_MISSING',
  );
  const plan = await act(target, {
    action: 'plan_pages',
    source: 'history',
    token: winner.token,
  });
  assert.deepEqual(plan.pages, [
    { from: state.userId, rows: 1, to: state.userId, token: 'p0001' },
  ]);
  assert.deepEqual(
    await act(target, {
      action: 'index_page',
      page: 'p0001',
      rows: [{ entries: [], id: state.userId }],
      token: winner.token,
    }),
    {
      entriesCreated: 0,
      membershipsRemoved: 0,
      membershipsWritten: 0,
      page: 'p0001',
      users: 1,
    },
  );
  assert.deepEqual(
    await act(target, { action: 'complete', token: winner.token }),
    { completed: true, domain: 'history_index', installed: 0, revision: 10 },
  );
  report = await status(target);
  assert.equal(report.claim, null);
  assert.deepEqual(report.dirty, ['enrollments', 'publication']);
  assert.equal(
    report.fingerprints.calculation,
    report.fingerprints.current.calculation,
  );
  assert.equal(report.revisions.completed, 10);
  assert.deepEqual(await claimNow(target, 'publication'), {
    blocking: ['enrollments'],
    claimed: false,
    reason: 'upstream_dirty',
  });
};

// An edit of a collection the counts read (an academic year) overtakes an
// enrollments claim; a publication-only edit would not (Task 13, the
// automatic-processing scenario).
const refusesStaleCompletion = async (target, state) => {
  const claim = await claimNow(target, 'enrollments');
  assert.equal(claim.claimed, true);
  assert.equal(claim.revision, 10);
  await create(target, state, [
    'academic_years',
    { label: '2033/2034', sort: 3 },
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
  // An enrollments claim never plans the Moodle users (Task 12): a plan
  // without the legacy family could let the completion drop its rows.
  await refused(
    target,
    { action: 'plan_pages', source: 'history', token: claim.token },
    'COORDINATION_DOMAIN_MISMATCH',
  );
  // A first plan of both rule families, one page staged under it; the plan
  // over the rules that follows must discard that page's candidates.
  const ruleRange = {
    from: Math.min(...state.ruleIds),
    rows: 3,
    to: Math.max(...state.ruleIds),
  };
  const replaced = await act(target, {
    action: 'plan_pages',
    source: 'enrollments',
    token: claim.token,
  });
  assert.deepEqual(replaced, {
    discarded: 0,
    families: [
      {
        kind: 'mapped_entries',
        pages: [{ ...ruleRange, kind: 'mapped', token: 'p0001' }],
        runnerFlowId: ruleMode('mapped_entries').runnerFlowId,
      },
    ],
    source: 'enrollments',
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
    pages: [{ ...ruleRange, token: 'p0001' }],
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
  // A publication claim runs under the publication fingerprint.
  assert.notEqual(report.fingerprints.current.publication, claim.fingerprint);
  assert.equal(report.publication.state, 'idle');
  await patch(target, `/operations/${operationId}`, {
    options: templatedOptions,
  });
  report = await status(target);
  assert.equal(
    report.fingerprints.current.publication,
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
      publication: 'failed',
      revision: 11,
    },
  );
  let report = await status(target);
  assert.equal(report.publication.state, 'failed');
  assert.equal(report.lastError.code, 'SYNTHETIC_PUBLISH_FAILURE');
  assert.equal(report.lastError.revision, 11);
  assert.deepEqual(await claimNow(target, 'publication'), {
    claimed: false,
    domain: 'publication',
    error: 'SYNTHETIC_PUBLISH_FAILURE',
    reason: 'failed',
    revision: 11,
  });
  const retried = await claimNow(target, 'publication', true);
  assert.equal(retried.claimed, true);
  // The publish loop keeps the claim with a heartbeat right before each
  // upload, which leases it for the upload, and records each file's
  // outcome as soon as it is known, which ends the lease.
  assert.deepEqual(
    await act(target, { action: 'heartbeat', token: retried.token }),
    { heartbeat: true },
  );
  report = await status(target);
  assert.ok(report.claim.heartbeatAgeMs < 0, 'the upload lease runs');
  assert.equal(report.claim.stale, false);
  const [firstFile] = publicFiles;
  assert.deepEqual(
    await act(target, {
      action: 'record',
      bytes: 2,
      filename: firstFile,
      outcome: 'uploaded',
      token: retried.token,
    }),
    { filename: firstFile, outcome: 'uploaded', revision: 11 },
  );
  report = await status(target);
  assert.ok(report.claim.heartbeatAgeMs >= 0, 'the record ended the lease');
  assert.equal(report.publication.state, 'running');
  assert.deepEqual(report.publication.files, {
    [firstFile]: { bytes: 2, code: null, outcome: 'uploaded', revision: 11 },
  });
  await refused(
    target,
    {
      action: 'record',
      filename: 'undeclared.json',
      outcome: 'uploaded',
      token: retried.token,
    },
    'COORDINATION_UNKNOWN_FILE',
  );
  // A completion needs every declared file uploaded; the coordinator
  // keeps each outcome with the claimed revision.
  const files = Object.fromEntries(
    publicFiles.map((filename, index) => [
      filename,
      { bytes: index + 2, outcome: 'uploaded' },
    ]),
  );
  const recorded = Object.fromEntries(
    publicFiles.map((filename, index) => [
      filename,
      { bytes: index + 2, code: null, outcome: 'uploaded', revision: 11 },
    ]),
  );
  await refused(
    target,
    {
      action: 'complete',
      files: { ...files, 'undeclared.json': { outcome: 'uploaded' } },
      token: retried.token,
    },
    'COORDINATION_UNKNOWN_FILE',
  );
  assert.deepEqual(
    await act(target, { action: 'complete', files, token: retried.token }),
    {
      completed: true,
      domain: 'publication',
      installed: 0,
      pendingRevision: null,
      revision: 11,
    },
  );
  report = await status(target);
  assert.equal(report.publication.state, 'completed');
  assert.deepEqual(report.publication.files, recorded);
  assert.deepEqual(report.pending, []);
  assert.deepEqual(report.dirty, []);
  assert.equal(
    report.fingerprints.publication,
    report.fingerprints.current.publication,
  );
  assert.deepEqual(await claimNow(target, 'publication'), {
    claimed: false,
    reason: 'nothing_pending',
  });
  const raw = await get(target, '/items/data_operations');
  assert.equal(raw.publication_state, 'completed');
  assert.deepEqual(raw.publication_outcomes, recorded);
  assert.equal(raw.claim_token, null);
  assert.notEqual(raw.finished_at, null);
};

// The claim of a process that is gone stops heartbeating. Right after the
// restart it is still busy (a timeout alone steals nothing); once its
// heartbeat is older than the window the next claim attempt releases it as
// abandoned, keeps the failure details, and an explicit retry succeeds.
// The publish loop had recorded one file before the restart: the status
// keeps it and calls the publication partial, never "no file uploaded".
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
  const [firstFile, secondFile] = publicFiles;
  await act(target, {
    action: 'record',
    bytes: 3,
    filename: firstFile,
    outcome: 'uploaded',
    token: claim.token,
  });
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
    domain: 'publication',
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
  assert.match(report.lastError.message, unrecordedUpload);
  assert.equal(report.publication.state, 'partial');
  assert.deepEqual(report.publication.files[firstFile], {
    bytes: 3,
    code: null,
    outcome: 'uploaded',
    revision: 12,
  });
  // A file the run never reached keeps the earlier run's entry.
  assert.equal(report.publication.files[secondFile].revision, 11);
  const fresh = await claimNow(target, 'publication', true);
  assert.equal(fresh.claimed, true);
  assert.notEqual(fresh.owner, claim.owner);
  assert.equal(fresh.owner, report.process);
  assert.deepEqual(
    await act(target, {
      action: 'complete',
      files: everyFileUploaded,
      token: fresh.token,
    }),
    {
      completed: true,
      domain: 'publication',
      installed: 0,
      pendingRevision: null,
      revision: 12,
    },
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
  // Installed counts and candidates are guarded; they go with their
  // courses and years (a foreign key cascade passes the guard).
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
