import assert from 'node:assert/strict';

import { mappedEnrollmentFlowIds } from '../../src/flows/shared.js';
import { json, read, request } from './data-model-helpers.mjs';
import { get, patch, post, trigger } from './history-index-helpers.mjs';

// Synthetic Flows, seeds and request helpers of the mapped enrollment
// fixture suite (mapped-enrollments.integration.mjs). The two synthetic
// Flows are the "minimal test parent" of Task 11: the installed templates
// are operation-triggered children and cannot be reached over REST.

const idPrefix = '9e4d826c-5b1a-4c0e-8f2d-0000000011';
const syntheticId = (suffix) => `${idPrefix}${suffix}`;

export const driverFlowId = syntheticId('01');
export const runFlowId = syntheticId('10');
const driverPath = `/flows/trigger/${driverFlowId}`;
const runPath = `/flows/trigger/${runFlowId}`;
const resultsPath = '/items/data_operation_results';
export const enrollmentsPath = '/items/course_enrollments';
export const mappingsPath = '/items/moodle_course_mappings';

// Synthetic raw histories. U1 carries the cross-pair trap (course A in
// year 1, course B in year 2), U2 two entries mapped to the same pair, U3
// and U4 an entry mapped to two courses, U4 a second entry of one of them,
// U5 an entry nobody maps.
export const seedUsers = [
  ['u1', 'Mapped Alpha 1\nMapped Beta 2'],
  ['u2', 'Mapped Alpha 1 twin\nMapped Alpha 1 other'],
  ['u3', 'Mapped Common 1'],
  ['u4', 'Mapped Common 1\r\nMapped Gamma 1'],
  ['u5', 'Mapped Unlisted'],
];

// entry label, course, academic year
export const seedMappings = [
  ['alpha', 'Mapped Alpha 1', 'a', 'y1'],
  ['beta', 'Mapped Beta 2', 'b', 'y2'],
  ['twin', 'Mapped Alpha 1 twin', 'a', 'y1'],
  ['other', 'Mapped Alpha 1 other', 'a', 'y1'],
  ['commonB', 'Mapped Common 1', 'b', 'y1'],
  ['commonC', 'Mapped Common 1', 'c', 'y1'],
  ['gamma', 'Mapped Gamma 1', 'c', 'y1'],
];

export const mappedPairs = [
  ['a', 'y1'],
  ['a', 'y2'],
  ['b', 'y1'],
  ['b', 'y2'],
  ['c', 'y1'],
  ['c', 'y2'],
];

// Adds the claim and its revision to every planned page, the payload the
// page Flow expects.
const withClaimScript = `module.exports = function (data) {
  return data.plan.pages.map(function (page) {
    return { claim: data.claim.token, from: page.from, revision: data.claim.revision, rows: page.rows, to: page.to, token: page.token };
  });
};`;

// Every page must answer its stage_page result; the first failure record
// becomes the run's error.
const pagesOkScript = `module.exports = function (data) {
  const results = Array.isArray(data.count_pages) ? data.count_pages : [];
  const failed = results.filter(function (result) { return result === null || typeof result !== 'object' || typeof result.staged !== 'number'; });
  if (failed.length > 0 || results.length !== data.with_claim.length) {
    const first = failed[0] || {};
    throw new Error('Mapped count failed at page ' + String(first.page) + ' (' + String(first.stage) + '): ' + String(first.code) + ' ' + String(first.message).slice(0, 300));
  }
  return { pages: results.length, staged: results.reduce(function (total, result) { return total + result.staged; }, 0) };
};`;

const coordinate = 'finki-hub-data-coordinate';

const step = ({ edges = {}, key, options, suffix, type }) => ({
  id: syntheticId(suffix),
  key,
  name: key,
  options,
  position_x: 18 * Number.parseInt(suffix, 16),
  position_y: 1,
  reject: edges.reject === undefined ? null : syntheticId(edges.reject),
  resolve: edges.resolve === undefined ? null : syntheticId(edges.resolve),
  type,
});

// The minimal test parent: claim enrollments, plan the rule pages, stage
// every page through the installed page Flow, complete (or fail) the
// claim. Operations are listed so that every edge target comes first.
const runOperations = [
  step({
    key: 'answer',
    options: {
      json: {
        completed: true,
        installed: '{{ complete.installed }}',
        pages: '{{ pages_ok }}',
        revision: '{{ complete.revision }}',
      },
    },
    suffix: '1f',
    type: 'transform',
  }),
  step({
    key: 'raise_completion',
    options: {
      code: 'COMPLETION_REFUSED',
      message: '{{ complete.message }}',
      status: 409,
    },
    suffix: '1e',
    type: 'throw-error',
  }),
  step({
    edges: { reject: '1e', resolve: '1f' },
    key: 'complete',
    options: { action: 'complete', token: '{{ claim.token }}' },
    suffix: '1d',
    type: coordinate,
  }),
  step({
    key: 'raise_failed',
    options: {
      code: 'MAPPED_COUNT_FAILED',
      message: '{{ pages_ok.message }}',
      status: 500,
    },
    suffix: '1c',
    type: 'throw-error',
  }),
  step({
    edges: { resolve: '1c' },
    key: 'fail_run',
    options: {
      action: 'fail',
      code: 'MAPPED_COUNT_FAILED',
      token: '{{ claim.token }}',
    },
    suffix: '1b',
    type: coordinate,
  }),
  step({
    edges: { reject: '1b', resolve: '1d' },
    key: 'pages_ok',
    options: { code: pagesOkScript },
    suffix: '1a',
    type: 'exec',
  }),
  step({
    edges: { resolve: '1a' },
    key: 'count_pages',
    options: {
      flow: mappedEnrollmentFlowIds.page,
      iterationMode: 'serial',
      payload: '{{ with_claim }}',
    },
    suffix: '19',
    type: 'trigger',
  }),
  step({
    edges: { resolve: '19' },
    key: 'with_claim',
    options: { code: withClaimScript },
    suffix: '18',
    type: 'exec',
  }),
  step({
    key: 'raise_plan',
    options: {
      code: 'PLAN_REFUSED',
      message: '{{ plan.message }}',
      status: 500,
    },
    suffix: '17',
    type: 'throw-error',
  }),
  // A refused plan releases the claim, as a dispatcher would.
  step({
    edges: { resolve: '17' },
    key: 'plan_fail',
    options: {
      action: 'fail',
      code: 'PLAN_FAILED',
      token: '{{ claim.token }}',
    },
    suffix: '20',
    type: coordinate,
  }),
  step({
    edges: { reject: '20', resolve: '18' },
    key: 'plan',
    options: {
      action: 'plan_pages',
      source: 'rules',
      token: '{{ claim.token }}',
    },
    suffix: '16',
    type: coordinate,
  }),
  step({
    key: 'not_claimed',
    options: {
      code: 'NOT_CLAIMED',
      message: 'Enrollments not claimed: {{ claim.reason }}',
      status: 409,
    },
    suffix: '15',
    type: 'throw-error',
  }),
  step({
    edges: { reject: '15', resolve: '16' },
    key: 'claimed',
    options: { filter: { claim: { claimed: { _eq: true } } } },
    suffix: '14',
    type: 'condition',
  }),
  step({
    edges: { resolve: '14' },
    key: 'claim',
    options: {
      action: 'claim',
      domain: 'enrollments',
      retry: '{{ $trigger.body.retry }}',
    },
    suffix: '13',
    type: coordinate,
  }),
];

const installFlow = async (target, flow, operations) => {
  await post(target, '/flows', {
    ...flow,
    operation: null,
    status: 'inactive',
  });
  for (const operation of operations) {
    await post(target, '/operations', { ...operation, flow: flow.id });
  }
  await patch(target, `/flows/${flow.id}`, {
    operation: operations.at(-1).id,
    status: 'active',
  });
};

const manual = {
  accountability: 'activity',
  icon: 'science',
  options: {
    async: false,
    collections: ['courses', 'data_operations'],
    error_on_reject: true,
    location: 'both',
    requireSelection: false,
  },
  trigger: 'manual',
};

export const installRunFlow = (target) =>
  installFlow(
    target,
    {
      ...manual,
      description:
        'Synthetic test parent of the mapped enrollment Flows; removed by the suite that installs it.',
      id: runFlowId,
      name: 'Synthetic mapped enrollment run',
    },
    runOperations,
  );

// Runs any operation-triggered Flow with the posted payload (an array runs
// serially and answers the results in order).
export const installDriverFlow = (target) =>
  installFlow(
    target,
    {
      ...manual,
      description:
        'Synthetic driver of operation-triggered Flows; removed by the suite that installs it.',
      id: driverFlowId,
      name: 'Synthetic operation Flow driver',
    },
    [
      step({
        key: 'run_child',
        options: {
          flow: '{{ $trigger.body.flow }}',
          iterationMode: 'serial',
          payload: '{{ $trigger.body.payload }}',
        },
        suffix: '02',
        type: 'trigger',
      }),
    ],
  );

export const syntheticFlowIds = [driverFlowId, runFlowId];

export const drive = async (target, flow, payload) => {
  const outcome = await trigger(target, driverPath, {
    collection: 'data_operations',
    flow,
    payload,
  });
  assert.equal(outcome.status, 200, JSON.stringify(outcome.body));
  return outcome.body;
};

export const runCounts = (target, body = {}) =>
  trigger(target, runPath, { collection: 'data_operations', ...body });

export const anonymousTrigger = async (target, id) => {
  const response = await request(
    target,
    `/flows/trigger/${id}`,
    json('POST', { collection: 'data_operations' }),
  );
  await response.text();
  return response.status;
};

// The installed counts by "course/year" key of the seeded ids.
export const enrollmentCounts = async (target, state) => {
  const rows = await get(
    target,
    `${enrollmentsPath}?fields=course,academic_year,count,computed_revision&limit=-1`,
  );
  return Object.fromEntries(
    rows.map((row) => [
      `${state.courses.get(row.course)}/${state.years.get(row.academic_year)}`,
      row.count,
    ]),
  );
};

export const candidates = (target) =>
  get(
    target,
    `${resultsPath}?fields=claim_token,page_token,course,academic_year,count,revision&sort=course,academic_year&limit=-1`,
  );

export const removeAll = async (target, path, ids) => {
  if (ids.length === 0) return;
  await read(
    await request(target, path, json('DELETE', ids, target.token)),
    204,
  );
};
