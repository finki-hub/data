import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import { dispatcherFlowId } from '../../src/flows/count-enrollments.js';
import { insertionOrder } from '../../src/flows/flow-template.js';
import { get, patch, post, remove, status } from './history-index-helpers.mjs';

// Constants, waits, seeds and opt-in Docker probes of the automatic
// processing fixture suite (automatic-processing.integration.mjs). Every
// row is invented; no name, address or history of a real person.

const runCommand = promisify(execFile);
const containerPattern = /^[a-z0-9][a-z0-9_.-]{0,127}$/u;
const selectPattern = /^SELECT\b/u;
// Side effects a read-only transaction still allows: signalling other
// backends and reloading the server configuration.
const signallingPattern =
  /\bpg_(?:cancel_backend|reload_conf|rotate_logfile|signal_backend|terminate_backend|advisory\w*)\s*\(/iu;
const lineBreak = /\r?\n/u;
const collator = new Intl.Collator('en');

// The schedule of Data / Process pending fires at every 15th second of the
// wall clock (seconds 0, 15, 30, 45).
export const intervalMs = 15_000;
// How long a wait for the schedule may take: three intervals plus room for
// the run itself.
export const waitLimitMs = 3 * intervalMs + 15_000;

// Opt-in: the Directus container to restart, and the PostgreSQL container
// whose statistics and locks read-only psql SELECTs may inspect.
export const restartContainer =
  process.env.DIRECTUS_COORDINATION_RESTART_CONTAINER;
export const databaseContainer =
  process.env.DIRECTUS_AUTOMATIC_DATABASE_CONTAINER;

export const syntheticId = (suffix) =>
  `9e4d826c-5b1a-4c0e-8f2d-0000000014${suffix}`;

export const courses = {
  alpha: 'Synthetic Automatic Course Alpha',
  beta: 'Synthetic Automatic Course Beta',
  gamma: 'Synthetic Automatic Course Gamma',
};
export const years = { y1: '2071/2072', y2: '2072/2073' };
export const lines = {
  alpha71: 'Synthetic Automatic Alpha 71',
  beta71: 'Synthetic Automatic Beta 71',
  beta72: 'Synthetic Automatic Beta 72',
  legacy: 'Synthetic Automatic Legacy Line',
};
export const seedUsers = [
  [lines.alpha71, lines.beta71].join('\n'),
  lines.alpha71,
  [lines.beta72, lines.legacy].join('\r\n'),
  lines.legacy,
].map((Courses, index) => ({
  Courses,
  'Courses Count': Courses.split(lineBreak).length,
  Name: `Synthetic Automatic User ${index + 1}`,
}));

// Every course/year the synthetic rules name, with its expected count
// before any edit: two users carry Alpha 71, one Beta 71, one Beta 72, two
// the legacy line (matched by a legacy_regex rule of Gamma).
export const expectedCounts = {
  'alpha/y1': 2,
  'beta/y1': 1,
  'beta/y2': 1,
  'gamma/y1': 2,
};

export const wallClock = () => new Date().toISOString();

// Waits until the wall clock stands `offsetMs` past a tick of the
// schedule, so a burst or an edit lands between two ticks.
export const afterTick = async (offsetMs = 1_500) => {
  const into = Date.now() % intervalMs;
  await sleep(
    into <= offsetMs ? offsetMs - into : intervalMs - into + offsetMs,
  );
};

const summaryOf = (report) =>
  report === undefined
    ? null
    : {
        claim: report.claim?.domain ?? null,
        domains: Object.fromEntries(
          Object.entries(report.domains).map(([domain, value]) => [
            domain,
            value.state,
          ]),
        ),
        lastError: report.lastError,
        revisions: report.revisions,
      };

// Polls the coordinator status until the predicate holds; answers the
// report and how long the wait took.
export const waitForStatus = async (
  target,
  predicate,
  { limitMs = waitLimitMs, pollMs = 500 } = {},
) => {
  const started = Date.now();
  let report;
  while (Date.now() - started <= limitMs) {
    report = await status(target);
    if (predicate(report)) return { elapsedMs: Date.now() - started, report };
    await sleep(pollMs);
  }
  return assert.fail(
    `The status did not settle within ${limitMs} ms: ${JSON.stringify(summaryOf(report))}`,
  );
};

export const isCurrent =
  (...domains) =>
  (report) =>
    report.claim === null &&
    domains.every((domain) => report.domains[domain].current);

// The latency of the last completed run after an edit made at `editedAt`:
// the wait for the tick that claimed it, the run itself, and the whole.
export const latencyOf = (label, editedAt, report) => {
  const edited = Date.parse(editedAt);
  const started = Date.parse(report.lastRun.startedAt);
  const finished = Date.parse(report.lastRun.finishedAt);
  return {
    label,
    runMs: finished - started,
    totalMs: finished - edited,
    waitMs: started - edited,
  };
};

// Flow runs Directus recorded (accountability activity) since a moment.
export const runsSince = async (target, flowId, since) => {
  const [row] = await get(
    target,
    `/activity?aggregate[count]=*&filter[collection][_eq]=directus_flows&filter[action][_eq]=run&filter[item][_eq]=${flowId}&filter[timestamp][_gte]=${encodeURIComponent(since)}`,
  );
  return Number(row?.count ?? 0);
};

// Directus records a Flow run once its last operation finished, so the
// dispatcher's run lands a moment after the status its child wrote (a
// failure, a completion). Waits briefly for the expected count of
// "Data / Count enrollments" runs since a moment.
export const dispatcherRuns = async (target, since, expected) => {
  const started = Date.now();
  let runs = await runsSince(target, dispatcherFlowId, since);
  while (runs < expected && Date.now() - started < 10_000) {
    await sleep(250);
    runs = await runsSince(target, dispatcherFlowId, since);
  }
  return runs;
};

export const createMany = async (target, collection, rows) => {
  const created = await post(target, `/items/${collection}`, rows);
  return created.data.map(({ id }) => id);
};

export const countsOf = async (target, state) => {
  const rows = await get(
    target,
    '/items/course_enrollments?fields=course,academic_year,count&limit=-1',
  );
  const names = new Map([...state.courses].map(([key, id]) => [id, key]));
  const labels = new Map([...state.years].map(([key, id]) => [id, key]));
  return Object.fromEntries(
    rows
      .filter(({ course }) => names.has(course))
      .map(({ academic_year, count, course }) => [
        `${names.get(course)}/${labels.get(academic_year)}`,
        count,
      ])
      .toSorted(([left], [right]) => collator.compare(left, right)),
  );
};

// One read-only SELECT on the fixture database (by default the container
// DIRECTUS_AUTOMATIC_DATABASE_CONTAINER names; a suite that validated its
// containers through isolatedTargets passes the bound one). The helper
// refuses, before Docker is called, anything that is not a single SELECT
// (no statement separator) or that signals other backends; the session
// itself runs every transaction read-only (default_transaction_read_only),
// so a SELECT that would write (SELECT INTO, setval, nextval) fails in the
// database, and psql stops at the first error.
export const psql = async (sql, container = databaseContainer) => {
  assert.match(container ?? '', containerPattern);
  assert.match(sql, selectPattern, 'only SELECT statements are allowed');
  assert.ok(!sql.includes(';'), 'exactly one statement is allowed');
  assert.doesNotMatch(sql, signallingPattern, 'no signalling function');
  const { stdout } = await runCommand('docker', [
    'exec',
    '-e',
    'PGOPTIONS=-c default_transaction_read_only=on',
    container,
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'directus',
    '-d',
    'directus',
    '-At',
    '-F',
    '|',
    '-c',
    sql,
  ]);
  return stdout
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split('|'));
};

export const waitForDirectus = async (target) => {
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
  return assert.fail('Directus did not answer /server/ping after the restart');
};

// Restarts the Directus container (by default the one
// DIRECTUS_COORDINATION_RESTART_CONTAINER names; a suite that validated its
// containers through isolatedTargets passes the bound one).
export const restartDirectus = async (target, container = restartContainer) => {
  assert.match(container ?? '', containerPattern);
  await runCommand('docker', ['restart', container]);
  return waitForDirectus(target);
};

// Installs a synthetic Flow the way the template installer does: inactive,
// operations edge targets first, then wired and activated.
export const installFlow = async (target, flow, operations) => {
  await post(target, '/flows', {
    ...flow,
    operation: null,
    status: 'inactive',
  });
  for (const entry of insertionOrder(operations)) {
    await post(target, '/operations', { ...entry, flow: flow.id });
  }
  await patch(target, `/flows/${flow.id}`, {
    operation: operations[0].id,
    status: 'active',
  });
};

export const removeFlow = async (target, id) => {
  const present = await get(target, `/flows?fields=id&filter[id][_eq]=${id}`);
  if (present.length > 0) await remove(target, `/flows/${id}`);
};

// One operation of a synthetic Flow.
export const operationOf = ({ edges = {}, id, key, options, type }) => ({
  id,
  key,
  name: key,
  options,
  position_x: 19,
  position_y: 1,
  reject: edges.reject ?? null,
  resolve: edges.resolve ?? null,
  type,
});

// A user without administrator rights who may read the coordination
// singleton, so Directus lets it trigger a manual Flow on it.
export const withOperationsReader = async (target, body) => {
  const policy = await post(target, '/policies', {
    admin_access: false,
    app_access: false,
    icon: 'lock',
    name: `Synthetic operations reader ${randomUUID()}`,
  });
  let user = null;
  try {
    await post(target, '/permissions', {
      action: 'read',
      collection: 'data_operations',
      fields: ['id'],
      permissions: {},
      policy: policy.data.id,
    });
    const token = `synthetic-${randomUUID()}`;
    user = await post(target, '/users', {
      first_name: 'Synthetic',
      last_name: 'Operations Reader',
      policies: [{ policy: policy.data.id }],
      status: 'active',
      token,
    });
    await body(token);
  } finally {
    if (user !== null) await remove(target, `/users/${user.data.id}`);
    await remove(target, `/policies/${policy.data.id}`);
  }
};

export const calculations = ['history_index', 'enrollments'];

// Waits until both calculation domains are current and nothing runs.
export const settle = (target, options) =>
  waitForStatus(target, isCurrent(...calculations), options);

export const record = (t, state, latency) => {
  state.latencies.push(latency);
  t.diagnostic(`latency ${JSON.stringify(latency)}`);
};
