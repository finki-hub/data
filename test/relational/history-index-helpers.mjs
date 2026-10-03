import assert from 'node:assert/strict';

import { splitHistoryEntries } from '../../directus/extensions/directus-extension-data-operations/src/history-contract.js';
import {
  createItem,
  errorCode,
  json,
  read,
  request,
} from './data-model-helpers.mjs';

// Shared constants, seeds and request helpers of the history index fixture
// suite (history-index.integration.mjs).

export const flowId = '9e4d826c-5b1a-4c0e-8f2d-000000000901';
const operationId = '9e4d826c-5b1a-4c0e-8f2d-000000000902';
// A synthetic Flow that deletes one item of the collection it is run on
// through the items service without emitting events, the one Directus
// path that passes the hook: on the memberships only the database guard
// stands in its way, on the mappings nothing does (the control).
export const probeFlowId = '9e4d826c-5b1a-4c0e-8f2d-000000000903';
const probeOperationId = '9e4d826c-5b1a-4c0e-8f2d-000000000904';
const operationType = 'finki-hub-data-coordinate';
const statusPath = '/finki-hub-data-operations/status';
const triggerPath = `/flows/trigger/${flowId}`;
// The synthetic manual history runner (history-runner.mjs), which the
// suites install beside their other synthetic Flows.
export const historyRunnerId = '9e4d826c-5b1a-4c0e-8f2d-000000001300';
export const runnerPath = `/flows/trigger/${historyRunnerId}`;
export const entriesPath = '/items/moodle_course_entries';
export const membershipsPath = '/items/moodle_history_memberships';
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
export const claimMismatch = 'COORDINATION_CLAIM_MISMATCH';
export const invalidOptions = 'COORDINATION_INVALID_OPTIONS';
export const pageIncomplete = 'COORDINATION_PAGE_INCOMPLETE';
export const derivedIndex = 'COORDINATION_WRITE_GUARDED';
export const retryRequired = 'RETRY_REQUIRED';
export const bulkCourse = 'Synthetic Bulk Course';
export const bulkUserPrefix = 'Synthetic Bulk User ';
export const failureCode = 'SYNTHETIC_OVERSIZED_PAGE';
export const coursesCount = 'Courses Count';
export const alphaCourse = 'Alpha Course';
export const betaCourse = 'Beta Course';
export const alphaLeadingSpace = ' Alpha Course';
export const alphaTrailingSpace = 'Alpha Course ';
export const collator = new Intl.Collator('en');
export const rowsPattern = /rows/u;

// Synthetic raw histories: an exact repeat, CRLF with a trailing CR, case
// and whitespace variants, Cyrillic, a null history and empty lines. The
// raw `Courses Count` is the scraper's own line count and stays untouched.
export const seedUsers = [
  {
    Courses: 'Alpha Course\nBeta Course\nAlpha Course',
    [coursesCount]: 3,
    Name: 'Synthetic History User One',
  },
  {
    Courses: 'Alpha Course\r\nGamma Course\r',
    [coursesCount]: 2,
    Name: 'Synthetic History User Two',
  },
  {
    Courses: 'alpha course\n Alpha Course\nAlpha Course ',
    [coursesCount]: 3,
    Name: 'Synthetic History User Three',
  },
  {
    Courses: 'Дизајн на софтвер\nAlpha Course',
    [coursesCount]: 2,
    Name: 'Synthetic History User Four',
  },
  { Courses: null, [coursesCount]: null, Name: 'Synthetic History User Five' },
  {
    Courses: '\r\n\r\nBeta Course\n\n',
    [coursesCount]: 1,
    Name: 'Synthetic History User Six',
  },
];
export const seedLabels = [
  alphaCourse,
  betaCourse,
  'Gamma Course',
  'alpha course',
  alphaLeadingSpace,
  alphaTrailingSpace,
  'Дизајн на софтвер',
];

export const get = async (target, path) => {
  const body = await read(
    await request(target, path, { token: target.token }),
    200,
  );
  return body.data;
};

export const remove = async (target, path) =>
  read(
    await request(target, path, { method: 'DELETE', token: target.token }),
    204,
  );

export const patch = async (target, path, body) =>
  read(await request(target, path, json('PATCH', body, target.token)), 200);

export const post = async (target, path, body) =>
  read(await request(target, path, json('POST', body, target.token)), 200);

export const status = (target) => get(target, statusPath);

export const count = async (target, collection) => {
  const rows = await get(target, `/items/${collection}?aggregate[count]=*`);
  return Number(rows[0]?.count ?? 0);
};

export const trigger = async (target, path, body) => {
  const response = await request(
    target,
    path,
    json('POST', body, target.token),
  );
  const text = await response.text();
  return {
    body: text === '' ? null : JSON.parse(text),
    status: response.status,
  };
};

// Invokes the synthetic manual Flow that forwards its body to the
// coordinator; a 200 carries the raw `$last` value.
export const invoke = (target, body) =>
  trigger(target, triggerPath, {
    collection: 'data_operations',
    ...blankBody,
    ...body,
  });

export const act = async (target, body) => {
  const outcome = await invoke(target, body);
  assert.equal(
    outcome.status,
    200,
    `${body.action} answered HTTP ${outcome.status}: ${JSON.stringify(outcome.body)}`,
  );
  return outcome.body;
};

const statusOfCode = (code) =>
  code === invalidOptions || code === 'COORDINATION_DUPLICATE_ROWS' ? 400 : 409;

// A refused runner: the throw-error status and code, and its message.
export const refusedRun = (run, status, code) => {
  assert.equal(run.status, status, JSON.stringify(run.body));
  assert.equal(errorCode(run.body), code);
  return run.body.errors[0].message;
};

export const refused = async (target, body, code) => {
  const outcome = await invoke(target, body);
  assert.equal(
    outcome.status,
    statusOfCode(code),
    JSON.stringify(outcome.body),
  );
  assert.equal(errorCode(outcome.body), code);
  return outcome.body;
};

// Runs the synthetic manual runner Flow the way Studio does.
export const rebuild = (target, body = {}) =>
  trigger(target, runnerPath, { collection: 'moodle_users', ...body });

export const claimHistory = async (target, retry = null) => {
  const claim = await act(target, {
    action: 'claim',
    domain: 'history_index',
    retry,
  });
  assert.equal(claim.claimed, true, JSON.stringify(claim));
  return claim;
};

export const installSyntheticFlow = async (target) => {
  await post(target, '/flows', {
    accountability: 'activity',
    description:
      'Synthetic history index QA; removed by the test that installs it.',
    icon: 'history_edu',
    id: flowId,
    name: 'Synthetic history index QA',
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

export const create = async (target, state, [collection, item]) => {
  const created = await createItem(target, collection, item);
  state.items.unshift([collection, created.data.id]);
  return created.data.id;
};

export const entriesByLabel = async (target) => {
  const rows = await get(
    target,
    `${entriesPath}?fields=id,label,review_state,review_reason&limit=-1`,
  );
  return new Map(rows.map((row) => [row.label, row]));
};

export const membershipsOf = async (target, user) => {
  const rows = await get(
    target,
    `${membershipsPath}?fields=entry.label,sort&filter[moodle_user][_eq]=${user}&sort=sort&limit=-1`,
  );
  return rows.map(({ entry, sort }) => [entry.label, sort]);
};

export const pageRows = (users) =>
  users.map(({ Courses, id }) => ({
    entries: splitHistoryEntries(Courses),
    id,
  }));

// The index_page body of the one planned page over the seeded users.
export const indexPageBody = (state, token, body = {}) => ({
  action: 'index_page',
  page: 'p0001',
  rows: pageRows(state.users),
  token,
  ...body,
});

export const installProbeFlow = async (target) => {
  await post(target, '/flows', {
    accountability: null,
    description:
      'Synthetic probe of the membership write guard; removed by the test that installs it.',
    icon: 'block',
    id: probeFlowId,
    name: 'Synthetic membership guard probe',
    options: {
      async: false,
      collections: ['moodle_history_memberships', 'moodle_course_mappings'],
      error_on_reject: true,
      requireSelection: false,
    },
    status: 'inactive',
    trigger: 'manual',
  });
  await post(target, '/operations', {
    flow: probeFlowId,
    id: probeOperationId,
    key: 'delete_item',
    name: 'Delete one item without events',
    options: {
      collection: '{{ $trigger.body.collection }}',
      emitEvents: false,
      key: '{{ $trigger.body.key }}',
      permissions: '$full',
    },
    position_x: 19,
    position_y: 1,
    type: 'item-delete',
  });
  await patch(target, `/flows/${probeFlowId}`, {
    operation: probeOperationId,
    status: 'active',
  });
};
