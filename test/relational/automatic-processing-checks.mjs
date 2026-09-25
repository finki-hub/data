import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import { interruptedCode } from '../../directus/extensions/directus-extension-data-operations/src/coordination/failures.js';
import { claimStaleAfterMs } from '../../directus/extensions/directus-extension-data-operations/src/coordination/state.js';
import { dataModelCollectionKeys } from '../../src/data-model/collections.js';
import { dispatcherFlowId } from '../../src/flows/count-enrollments.js';
import { mappedPairFlow } from '../../src/flows/count-mapped-enrollments.js';
import { markPendingFlowId } from '../../src/flows/mark-pending.js';
import { processPendingFlowId } from '../../src/flows/process-pending.js';
import {
  afterTick,
  countsOf,
  createMany,
  databaseContainer,
  dispatcherRuns,
  installFlow,
  intervalMs,
  isCurrent,
  latencyOf,
  lines,
  operationOf,
  psql,
  record,
  removeFlow,
  restartContainer,
  restartDirectus,
  runsSince,
  settle,
  syntheticId,
  waitForStatus,
  waitLimitMs,
  wallClock,
  withOperationsReader,
} from './automatic-processing-helpers.mjs';
import { errorCode, json, request } from './data-model-helpers.mjs';
import {
  partitionsFingerprints,
  storesClaimOptions,
} from './fingerprint-partition-checks.mjs';
import {
  count,
  get,
  patch,
  remove,
  status,
  trigger,
} from './history-index-helpers.mjs';

// The checks of the automatic processing suite that run on the seeded
// project: failure blocking, Flow graph changes, changes during a run, a
// restart while work is pending, idle ticks and transaction visibility.

const markPendingPath = `/flows/trigger/${markPendingFlowId}`;
const shapeCount = mappedPairFlow.operations.find(
  ({ key }) => key === 'shape_count',
);
const childFlowId = syntheticId('10');
const parentFlowId = syntheticId('20');
const slowFlowId = syntheticId('30');
const skipUnless = (value, name) =>
  value === undefined ? `${name} is not set` : false;

export const freshState = () => ({
  bulkCourses: [],
  bulkYears: [],
  courses: new Map(),
  entries: new Map(),
  flows: [],
  latencies: [],
  mappings: new Map(),
  restore: new Map(),
  rooms: [],
  rules: [],
  templatesCreated: [],
  users: [],
  years: new Map(),
});

const markPending = async (target, domains) => {
  const answer = await trigger(target, markPendingPath, {
    collection: 'data_operations',
    domains,
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body;
};

// Changes a template operation the way Studio would; the cleanup puts
// back what the template defines.
const editOperation = async (target, state, { body, step }) => {
  state.restore.set(`/operations/${step.id}`, {
    name: step.name,
    options: step.options,
  });
  await patch(target, `/operations/${step.id}`, body);
};

const restoreOperation = async (target, state, step) => {
  const path = `/operations/${step.id}`;
  await patch(target, path, state.restore.get(path));
  state.restore.delete(path);
};

const removeMany = async (target, collection, ids) => {
  if (ids.length === 0) return;
  const response = await request(
    target,
    `/items/${collection}`,
    json('DELETE', ids, target.token),
  );
  await response.text();
  assert.ok(
    [204, 403].includes(response.status),
    `${collection} ${response.status}`,
  );
};

const failedAfter = (at) => (report) =>
  report.claim === null &&
  report.domains.enrollments.state === 'failed' &&
  report.lastError?.at !== at;

// A child that fails (a legacy pattern that does not compile) records the
// failure with its message; the schedule does not retry it on later ticks
// until Mark pending or an edit, and the installed counts stay.
const blocksFailedWork = async (t, target, state) => {
  const since = wallClock();
  const before = await countsOf(target, state);
  const [rule] = await createMany(target, 'course_enrollment_rules', [
    {
      academic_year: state.years.get('y2'),
      course: state.courses.get('gamma'),
      mode: 'legacy_regex',
      pattern: '(',
    },
  ]);
  state.rules.push(rule);
  const failed = await waitForStatus(target, failedAfter(null));
  const error = failed.report.lastError;
  assert.equal(error.code, 'LEGACY_COUNT_FAILED');
  assert.equal(error.domain, 'enrollments');
  assert.equal(error.blocking, true);
  assert.ok(error.message.includes(`Rule ${rule} (course `), error.message);
  assert.equal(failed.report.domains.enrollments.current, false);
  assert.deepEqual(await countsOf(target, state), before, 'counts stay');
  assert.equal(await dispatcherRuns(target, since, 1), 1);
  t.diagnostic(`failure recorded ${JSON.stringify(error)}`);

  const ticksBefore = await runsSince(target, processPendingFlowId, since);
  await sleep(3 * intervalMs);
  const idle = await status(target);
  assert.equal(idle.domains.enrollments.state, 'failed');
  assert.equal(idle.lastError.at, error.at, 'no retry on later ticks');
  assert.equal(await runsSince(target, dispatcherFlowId, since), 1);
  assert.ok(
    (await runsSince(target, processPendingFlowId, since)) >= ticksBefore + 2,
    'the schedule kept ticking',
  );

  const marked = await markPending(target, ['enrollments']);
  assert.equal(marked.domains.enrollments.state, 'pending');
  await waitForStatus(target, failedAfter(error.at));
  assert.equal(await dispatcherRuns(target, since, 2), 2);

  await patch(target, `/items/course_enrollment_rules/${rule}`, {
    pattern: lines.legacy,
  });
  const edited = wallClock();
  const fixed = await settle(target);
  record(
    t,
    state,
    latencyOf('counts after fixing the pattern', edited, fixed.report),
  );
  assert.deepEqual(await countsOf(target, state), {
    ...before,
    'gamma/y2': 2,
  });
  assert.equal(fixed.report.lastError.blocking, false);
};

// Only administrators may ask for a recalculation.
const gatesMarkPending = async (target) => {
  const before = await status(target);
  await withOperationsReader(target, async (token) => {
    const response = await request(
      target,
      markPendingPath,
      json('POST', { collection: 'data_operations' }, token),
    );
    const body = await response.json();
    assert.equal(response.status, 403, JSON.stringify(body));
    assert.equal(errorCode(body), 'FORBIDDEN');
  });
  const after = await status(target);
  assert.deepEqual(after.revisions, before.revisions);
};

// A name alone is no graph change; an option of a child Flow is, and the
// schedule recalculates both domains on its own, twice (change, restore).
const followsGraphChanges = async (t, target, state) => {
  const original = state.fingerprint;
  const before = await status(target);
  const publishedGraph = before.fingerprints.current.publication;
  await editOperation(target, state, {
    body: { name: 'Synthetic rename' },
    step: shapeCount,
  });
  let report = await status(target);
  assert.equal(report.fingerprints.current.calculation, original);
  assert.deepEqual(report.pending, ['publication']);
  await patch(target, `/operations/${shapeCount.id}`, {
    name: shapeCount.name,
  });

  await editOperation(target, state, {
    body: {
      options: { ...shapeCount.options, synthetic_note: 'Task 13' },
    },
    step: shapeCount,
  });
  const edited = wallClock();
  report = await status(target);
  assert.notEqual(report.fingerprints.current.calculation, original);
  // The publication fingerprint includes the calculation fingerprint.
  assert.notEqual(report.fingerprints.current.publication, publishedGraph);
  assert.deepEqual(report.pending, [
    'history_index',
    'enrollments',
    'publication',
  ]);
  const indexed = await waitForStatus(target, isCurrent('history_index'));
  record(
    t,
    state,
    latencyOf(
      'history index after a Flow option change',
      edited,
      indexed.report,
    ),
  );
  const counted = await settle(target);
  record(
    t,
    state,
    latencyOf('counts after a Flow option change', edited, counted.report),
  );
  assert.equal(
    counted.report.fingerprints.calculation,
    counted.report.fingerprints.current.calculation,
  );

  await restoreOperation(target, state, shapeCount);
  const restored = await settle(target);
  assert.equal(restored.report.fingerprints.current.calculation, original);
  assert.equal(restored.report.fingerprints.calculation, original);
};

// A Flow that holds no coordinate step is managed once a managed Flow
// reaches it through a Trigger Flow step; its descriptions, icons and
// operation names still are not part of the fingerprint. A Flow is managed
// by what its coordinate step does: a claim of a calculation roots the
// calculation graph, a status read roots nothing.
const followsReachableChildren = async (target, state) => {
  const fingerprint = async () => {
    const report = await status(target);
    return report.fingerprints.current.calculation;
  };
  const original = await fingerprint();
  state.flows.push(childFlowId);
  await installFlow(
    target,
    {
      accountability: 'activity',
      description: 'Synthetic child of the reachability check.',
      icon: 'science',
      id: childFlowId,
      name: 'Synthetic unmanaged child',
      options: { return: '$last' },
      trigger: 'operation',
    },
    [
      operationOf({
        id: syntheticId('11'),
        key: 'answer',
        options: { json: { note: 'a' } },
        type: 'transform',
      }),
    ],
  );
  assert.equal(
    await fingerprint(),
    original,
    'an unreached Flow is not managed',
  );
  state.flows.push(parentFlowId);
  await installFlow(
    target,
    {
      accountability: 'activity',
      description: 'Synthetic managed parent of the reachability check.',
      icon: 'science',
      id: parentFlowId,
      name: 'Synthetic managed parent',
      options: {
        async: false,
        collections: ['data_operations'],
        requireSelection: false,
      },
      trigger: 'manual',
    },
    [
      operationOf({
        edges: { resolve: syntheticId('22') },
        id: syntheticId('21'),
        key: 'status',
        options: { action: 'status' },
        type: 'finki-hub-data-coordinate',
      }),
      operationOf({
        id: syntheticId('22'),
        key: 'call_child',
        options: { flow: childFlowId, iterationMode: 'serial', payload: {} },
        type: 'trigger',
      }),
    ],
  );
  // A parent that only reads the status roots no graph (Task 15), so its
  // child is still unmanaged; one that claims a calculation roots the
  // calculation graph, and its child with it.
  assert.equal(await fingerprint(), original, 'a status step roots nothing');
  await patch(target, `/operations/${syntheticId('21')}`, {
    key: 'claim',
    options: { action: 'claim', domain: 'enrollments' },
  });
  const managed = await fingerprint();
  assert.notEqual(managed, original);
  await patch(target, `/operations/${syntheticId('11')}`, {
    options: { json: { note: 'b' } },
  });
  const changed = await fingerprint();
  assert.notEqual(changed, managed, 'the child option is covered');
  await patch(target, `/operations/${syntheticId('11')}`, { name: 'renamed' });
  await patch(target, `/flows/${childFlowId}`, {
    description: 'Synthetic child, described again.',
    icon: 'bolt',
  });
  assert.equal(await fingerprint(), changed, 'names and icons are not');
  await removeFlow(target, parentFlowId);
  assert.equal(await fingerprint(), original);
  await removeFlow(target, childFlowId);
  state.flows = state.flows.filter(
    (id) => id !== childFlowId && id !== parentFlowId,
  );
  await settle(target);
};

// Enough mapped rules that one enrollment run lasts seconds.
const seedBulk = async (t, target, state) => {
  const bulkCourses = await createMany(
    target,
    'courses',
    Array.from({ length: 30 }, (_, index) => ({
      name: `Synthetic Automatic Bulk ${String(index + 1).padStart(2, '0')}`,
    })),
  );
  const bulkYears = await createMany(
    target,
    'academic_years',
    Array.from({ length: 15 }, (_, index) => ({
      label: `${2_081 + index}/${2_082 + index}`,
      sort: 100 + index,
    })),
  );
  Object.assign(state, { bulkCourses, bulkYears });
  await createMany(
    target,
    'course_enrollment_rules',
    bulkCourses.flatMap((course) =>
      bulkYears.map((academic_year) => ({
        academic_year,
        course,
        mode: 'mapped_entries',
      })),
    ),
  );
  const edited = wallClock();
  const counted = await settle(target, { limitMs: waitLimitMs + 60_000 });
  record(
    t,
    state,
    latencyOf('counts after 450 new mapped rules', edited, counted.report),
  );
};

const room = (name) => ({ location: 'Synthetic Wing', name });

const running = (target) =>
  waitForStatus(target, (report) => report.claim?.domain === 'enrollments', {
    pollMs: 100,
  });

const overtaken = (target, code) =>
  waitForStatus(
    target,
    (report) => report.claim === null && report.lastError?.code === code,
    { pollMs: 250 },
  );

// A source edit during a run: the run's output is discarded, the domain
// stays dirty, and the next tick runs it again; likewise a graph change.
const discardsOvertakenRuns = async (t, target, state) => {
  await seedBulk(t, target, state);
  const since = wallClock();
  await markPending(target, ['enrollments']);
  await running(target);
  const [entry] = state.entries.values().toArray();
  await patch(target, `/items/moodle_course_entries/${entry}`, {
    review_reason: 'Synthetic mid-run edit',
  });
  const discarded = await overtaken(target, 'SOURCE_CHANGED');
  assert.equal(discarded.report.lastError.blocking, false);
  assert.equal(discarded.report.domains.enrollments.current, false);
  const rerun = await settle(target);
  assert.equal(await dispatcherRuns(target, since, 2), 2);
  t.diagnostic(
    `rerun after SOURCE_CHANGED: ${JSON.stringify(rerun.report.lastRun)}`,
  );

  await markPending(target, ['enrollments']);
  await running(target);
  await editOperation(target, state, {
    body: {
      options: { ...shapeCount.options, synthetic_note: 'mid-run' },
    },
    step: shapeCount,
  });
  const regraphed = await overtaken(target, 'FINGERPRINT_CHANGED');
  assert.equal(regraphed.report.lastError.blocking, false);
  await restoreOperation(target, state, shapeCount);
  await settle(target, { limitMs: waitLimitMs + 30_000 });
};

// An edit that only marks publication (a room) during a long enrollment
// run does not discard it: the run completes at its claimed revision,
// publication stays pending, and nothing reruns. Then the bulk rules go.
const keepsRunThroughPublicationEdit = async (t, target, state) => {
  const before = await status(target);
  const since = wallClock();
  await markPending(target, ['enrollments']);
  const run = await running(target);
  const claimRevision = run.report.claim.revision;
  const rooms = await createMany(target, 'rooms', [
    room('Synthetic Mid-run Room'),
  ]);
  state.rooms.push(...rooms);
  const during = await status(target);
  assert.equal(during.claim?.domain, 'enrollments', 'the run was still going');
  assert.equal(during.claim?.revision, claimRevision);
  assert.ok(during.revisions.source > claimRevision, 'the room edit committed');
  assert.equal(during.revisions.inputs.enrollments, claimRevision);
  const done = await settle(target);
  assert.equal(await dispatcherRuns(target, since, 1), 1, 'kept');
  assert.equal(done.report.revisions.completed, claimRevision);
  assert.deepEqual(done.report.pending, ['publication']);
  assert.equal(done.report.lastError?.at, before.lastError?.at, 'no failure');
  t.diagnostic(
    `run at ${claimRevision} kept through a room edit (source ${done.report.revisions.source})`,
  );

  await removeMany(target, 'rooms', rooms);
  state.rooms = state.rooms.filter((id) => !rooms.includes(id));
  const { bulkCourses, bulkYears } = state;
  Object.assign(state, { bulkCourses: [], bulkYears: [] });
  await removeMany(target, 'courses', bulkCourses);
  await removeMany(target, 'academic_years', bulkYears);
  await settle(target, { limitMs: waitLimitMs + 30_000 });
};

// A restart that kills a long enrollment run leaves its claim behind; the
// restarted process releases it once its heartbeat is older than the
// stale window and reruns the domain by itself, no Mark pending.
const rerunsInterruptedRun = async (t, target, state) => {
  const since = wallClock();
  await markPending(target, ['enrollments']);
  const run = await running(target);
  const restartedAt = wallClock();
  const polls = await restartDirectus(target);
  const after = await status(target);
  assert.equal(after.claim?.owner, run.report.claim.owner, 'the run was cut');
  assert.equal(after.claim?.ownedByThisProcess, false);
  const done = await waitForStatus(
    target,
    (report) =>
      isCurrent('history_index', 'enrollments')(report) &&
      report.lastError?.code === interruptedCode,
    { limitMs: claimStaleAfterMs + waitLimitMs + 30_000 },
  );
  record(
    t,
    state,
    latencyOf('counts rerun after a restart mid-run', restartedAt, done.report),
  );
  t.diagnostic(`Directus answered /server/ping after ${polls} polls`);
  assert.equal(done.report.lastError.blocking, false);
  assert.equal(done.report.lastError.domain, 'enrollments');
  assert.equal(done.report.revisions.completed, done.report.revisions.source);
  assert.ok((await dispatcherRuns(target, since, 1)) >= 1);
};

// Work pending when Directus restarts is processed by the restarted
// process's schedule; nothing is abandoned because nothing was claimed.
const recoversAfterRestart = async (t, target, state) => {
  await afterTick(1_000);
  await patch(
    target,
    `/items/moodle_course_mappings/${state.mappings.get('beta72')}`,
    { academic_year: state.years.get('y2'), course: state.courses.get('beta') },
  );
  const edited = wallClock();
  const pending = await status(target);
  assert.equal(pending.domains.enrollments.current, false);
  assert.equal(pending.claim, null);
  const polls = await restartDirectus(target);
  const done = await settle(target, { limitMs: waitLimitMs + 30_000 });
  record(
    t,
    state,
    latencyOf('counts after a restart while pending', edited, done.report),
  );
  t.diagnostic(`Directus answered /server/ping after ${polls} polls`);
  assert.notEqual(done.report.lastError?.code, 'CLAIM_ABANDONED');
  const counts = await countsOf(target, state);
  assert.equal(counts['alpha/y1'], 2);
  assert.equal(counts['beta/y2'], 1);
};

const quoted = (table) => `'${table}'`;

const statsSql = (tables) =>
  `SELECT relname, seq_scan, COALESCE(idx_scan, 0), n_tup_ins, n_tup_upd, n_tup_del FROM pg_stat_user_tables WHERE relname IN (${tables.map((table) => quoted(table)).join(', ')}) ORDER BY relname`;

const scans = (counters) => counters[0] + counters[1];

// Idle ticks read the status row and the Flow graph only: over a minute of
// ticks no model collection is scanned, read or written (PostgreSQL's own
// statistics, flushed at least every ten seconds), while data_operations
// is read by every claim.
const idlesWithoutReads = async (t, target) => {
  await settle(target);
  await sleep(12_000);
  const collections = dataModelCollectionKeys.filter(
    (collection) => collection !== 'data_operations',
  );
  const snapshot = async () => {
    const rows = await psql(statsSql([...collections, 'data_operations']));
    return new Map(
      rows.map(([name, ...counters]) => [name, counters.map(Number)]),
    );
  };
  const before = await snapshot();
  const since = wallClock();
  await sleep(60_000);
  const ticks = await runsSince(target, processPendingFlowId, since);
  await sleep(12_000);
  const after = await snapshot();
  assert.ok(ticks >= 4, `${ticks} ticks`);
  for (const collection of collections) {
    assert.ok(before.has(collection), `${collection} has statistics`);
    assert.deepEqual(after.get(collection), before.get(collection), collection);
  }
  const operationsReads =
    scans(after.get('data_operations')) - scans(before.get('data_operations'));
  assert.ok(operationsReads >= ticks, `${operationsReads} status-row reads`);
  t.diagnostic(
    `idle: ${ticks} ticks in 60 s, ${operationsReads} status-row reads, ${collections.length} collections unchanged`,
  );
};

const revisionSql = `SELECT (SELECT "source_revision" FROM "data_operations"), (SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'data_operations' AND l.mode = 'RowExclusiveLock' AND l.granted)`;

const sample = async () => {
  const [[revision, locks]] = await psql(revisionSql);
  return { locked: Number(locks) > 0, revision: Number(revision) };
};

// Creates rooms through a filter Flow that sleeps before each insert, and
// samples the revision from another connection while the transaction is
// open.
const observeCreate = async (target, rows) => {
  const before = await sample();
  const progress = { finished: false };
  const pending = (async () => {
    const answer = await request(
      target,
      '/items/rooms',
      json('POST', rows, target.token),
    );
    progress.finished = true;
    return answer;
  })();
  const samples = [];
  while (!progress.finished) samples.push(await sample());
  const response = await pending;
  const body = await response.json();
  return { after: await sample(), before, body, response, samples };
};

// The source revision moves inside the edit's own transaction: invisible
// to every other connection while it is open (its row lock is held), gone
// with a rollback, visible with the commit.
const bumpsInsideTransaction = async (t, target, state) => {
  state.flows.push(slowFlowId);
  await installFlow(
    target,
    {
      accountability: 'activity',
      description: 'Synthetic filter of the transaction check.',
      icon: 'science',
      id: slowFlowId,
      name: 'Synthetic slow room create',
      options: {
        collections: ['rooms'],
        scope: ['items.create'],
        type: 'filter',
      },
      trigger: 'event',
    },
    [
      operationOf({
        edges: { resolve: syntheticId('32') },
        id: syntheticId('31'),
        key: 'pause',
        options: { milliseconds: 2_000 },
        type: 'sleep',
      }),
      operationOf({
        id: syntheticId('32'),
        key: 'guard',
        options: {
          filter: {
            $trigger: { payload: { name: { _ncontains: 'Rollback' } } },
          },
        },
        type: 'condition',
      }),
    ],
  );
  await afterTick(500);
  const rolledBack = await observeCreate(target, [
    room('Synthetic Commit Room A'),
    room('Synthetic Rollback Room'),
  ]);
  assert.equal(
    rolledBack.response.status,
    400,
    JSON.stringify(rolledBack.body),
  );
  assert.ok(
    rolledBack.samples.some(({ locked }) => locked),
    'lock seen',
  );
  assert.ok(
    rolledBack.samples.every(
      ({ revision }) => revision === rolledBack.before.revision,
    ),
  );
  assert.equal(rolledBack.after.revision, rolledBack.before.revision);
  assert.equal(await count(target, 'rooms'), 0);

  await afterTick(500);
  const committed = await observeCreate(target, [
    room('Synthetic Commit Room B'),
    room('Synthetic Commit Room C'),
  ]);
  assert.equal(committed.response.status, 200, JSON.stringify(committed.body));
  state.rooms.push(...committed.body.data.map(({ id }) => id));
  const open = committed.samples.filter(({ locked }) => locked);
  assert.ok(open.length > 0, 'lock seen');
  assert.ok(
    open.every(({ revision }) => revision === committed.before.revision),
  );
  assert.equal(committed.after.revision, committed.before.revision + 2);
  t.diagnostic(
    `rollback: ${rolledBack.samples.length} samples, revision ${rolledBack.before.revision} throughout; commit: ${open.length} samples inside the transaction at ${committed.before.revision}, ${committed.after.revision} after`,
  );
  await removeFlow(target, slowFlowId);
  state.flows = state.flows.filter((id) => id !== slowFlowId);
};

export const checksAfterSeeding = async (t, target, state) => {
  await t.test(
    'records a failed child and retries it only on request or edit',
    () => blocksFailedWork(t, target, state),
  );
  await t.test('lets only administrators mark work pending', () =>
    gatesMarkPending(target),
  );
  await t.test(
    'recalculates after a Flow option change and never for a name',
    () => followsGraphChanges(t, target, state),
  );
  await t.test('fingerprints Flows reached through Trigger Flow steps', () =>
    followsReachableChildren(target, state),
  );
  await t.test(
    'partitions the fingerprints: a dialog edit changes neither, a publish-step edit only publication',
    () => partitionsFingerprints(t, target),
  );
  await t.test(
    'stores the claim action and domain where the fingerprint reads them',
    {
      skip: skipUnless(
        databaseContainer,
        'DIRECTUS_AUTOMATIC_DATABASE_CONTAINER',
      ),
    },
    () => storesClaimOptions(t, target),
  );
  await t.test(
    'discards a run overtaken by an edit or a graph change and reruns it',
    () => discardsOvertakenRuns(t, target, state),
  );
  await t.test(
    'reruns a run cut short by a restart without Mark pending',
    {
      skip: skipUnless(
        restartContainer,
        'DIRECTUS_COORDINATION_RESTART_CONTAINER',
      ),
    },
    () => rerunsInterruptedRun(t, target, state),
  );
  await t.test(
    'keeps a run through an edit that only concerns publication',
    () => keepsRunThroughPublicationEdit(t, target, state),
  );
  await t.test(
    'processes work left pending by a restart',
    {
      skip: skipUnless(
        restartContainer,
        'DIRECTUS_COORDINATION_RESTART_CONTAINER',
      ),
    },
    () => recoversAfterRestart(t, target, state),
  );
  await t.test(
    'reads no collection on idle ticks',
    {
      skip: skipUnless(
        databaseContainer,
        'DIRECTUS_AUTOMATIC_DATABASE_CONTAINER',
      ),
    },
    () => idlesWithoutReads(t, target),
  );
  await t.test(
    'moves the source revision inside the edit transaction only',
    {
      skip: skipUnless(
        databaseContainer,
        'DIRECTUS_AUTOMATIC_DATABASE_CONTAINER',
      ),
    },
    () => bumpsInsideTransaction(t, target, state),
  );
};

// Removes every row and Flow the run created, restores the template
// operations it edited, and deletes templates this run installed itself.
export const cleansUp = async (target, state) => {
  for (const [path, body] of state.restore) await patch(target, path, body);
  state.restore.clear();
  for (const id of [...state.flows, slowFlowId, parentFlowId, childFlowId]) {
    await removeFlow(target, id);
  }
  await removeMany(target, 'rooms', state.rooms);
  await removeMany(target, 'courses', [
    ...state.courses.values(),
    ...state.bulkCourses,
  ]);
  await removeMany(target, 'academic_years', [
    ...state.years.values(),
    ...state.bulkYears,
  ]);
  await removeMany(target, 'moodle_users', state.users);
  const entries = await get(
    target,
    '/items/moodle_course_entries?fields=id&limit=-1',
  );
  for (const { id } of entries) {
    await remove(target, `/items/moodle_course_entries/${id}`);
  }
  // The deletions are edits too: the schedule settles them (an empty
  // index, no counts) before the model is checked and torn down.
  await settle(target, { limitMs: 2 * waitLimitMs });
  const settled = await status(target);
  if (state.fingerprint !== undefined) {
    assert.equal(
      settled.fingerprints.current.calculation,
      state.fingerprint,
      'the managed graph is as it was',
    );
  }
  for (const id of state.templatesCreated) await removeFlow(target, id);
  for (const collection of dataModelCollectionKeys) {
    if (collection === 'data_operations') continue;
    assert.equal(await count(target, collection), 0, `${collection} is empty`);
  }
};
