import {
  coordinateOperation,
  insertionOrder,
} from '../../src/flows/flow-template.js';
import { historyFlowIds } from '../../src/flows/history-page-flows.js';
import {
  get,
  historyRunnerId,
  patch,
  post,
  remove,
} from './history-index-helpers.mjs';

// A synthetic manual history runner for the fixture suites that drive the
// coordinator by hand while the scheduled Process pending is paused
// (withDataModel). It claims history_index on request and runs the
// installed "Data / Refresh history index", the same claim-bound Flow the
// schedule runs, so these suites exercise the production run path; it is
// no production Flow (Mark pending is the manual path there). It answers
// 200 with the summary or with "nothing pending", 409 RETRY_REQUIRED or
// CLAIM_BUSY for a refused claim, 500 with the failure record's code and
// message otherwise.

const syntheticId = (suffix) => `9e4d826c-5b1a-4c0e-8f2d-0000000013${suffix}`;

const step = ([suffix, key, type, options, edges = {}]) => ({
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

const gate = ({ edges, filter, key, suffix }) => [
  suffix,
  key,
  'condition',
  { filter },
  edges,
];

const raise = ({ code, key, message, status, suffix }) => [
  suffix,
  key,
  'throw-error',
  { code, message, status },
];

const operations = [
  [
    '03',
    'claim',
    coordinateOperation,
    {
      action: 'claim',
      domain: 'history_index',
      retry: '{{ $trigger.body.retry }}',
    },
    { resolve: '04' },
  ],
  gate({
    edges: { reject: '05', resolve: '0a' },
    filter: { claim: { claimed: { _eq: true } } },
    key: 'claimed',
    suffix: '04',
  }),
  gate({
    edges: { reject: '07', resolve: '06' },
    filter: { claim: { reason: { _eq: 'nothing_pending' } } },
    key: 'up_to_date',
    suffix: '05',
  }),
  ['06', 'not_claimed', 'transform', { json: '{{ claim }}' }],
  gate({
    edges: { reject: '09', resolve: '08' },
    filter: { claim: { reason: { _eq: 'failed' } } },
    key: 'failed_before',
    suffix: '07',
  }),
  raise({
    code: 'RETRY_REQUIRED',
    key: 'raise_retry',
    message:
      'The last Moodle history index run failed at source revision {{ claim.revision }} ({{ claim.error }}). Fix the cause, then run this Flow again with "Retry a failed run" switched on.',
    status: 409,
    suffix: '08',
  }),
  raise({
    code: 'CLAIM_BUSY',
    key: 'raise_busy',
    message:
      'The Moodle history index was not claimed ({{ claim.reason }}): another data operation holds the claim. Run this Flow again once it has finished.',
    status: 409,
    suffix: '09',
  }),
  [
    '0a',
    'refresh',
    'trigger',
    {
      flow: historyFlowIds.refresh,
      iterationMode: 'serial',
      payload: { claim: '{{ claim.token }}' },
    },
    { resolve: '0b' },
  ],
  gate({
    edges: { reject: '0d', resolve: '0c' },
    filter: { refresh: { ok: { _eq: true } } },
    key: 'refreshed',
    suffix: '0b',
  }),
  [
    '0c',
    'finished',
    'transform',
    {
      json: {
        completed: true,
        index: '{{ refresh.index }}',
        revision: '{{ refresh.revision }}',
      },
    },
  ],
  raise({
    code: '{{ refresh.code }}',
    key: 'raise_failure',
    message: '{{ refresh.message }}',
    status: 500,
    suffix: '0d',
  }),
].map((entry) => step(entry));

// Installs the harness inactive, its operations edge targets first, then
// wires and activates it, as the template installer does.
export const installHistoryRunner = async (target) => {
  await post(target, '/flows', {
    accountability: 'activity',
    description:
      'Synthetic manual history runner of the fixture suites; removed by the suite that installs it.',
    icon: 'science',
    id: historyRunnerId,
    name: 'Synthetic history runner',
    operation: null,
    options: {
      async: false,
      collections: ['moodle_users'],
      error_on_reject: true,
      requireSelection: false,
    },
    status: 'inactive',
    trigger: 'manual',
  });
  for (const entry of insertionOrder(operations)) {
    await post(target, '/operations', { ...entry, flow: historyRunnerId });
  }
  await patch(target, `/flows/${historyRunnerId}`, {
    operation: syntheticId('03'),
    status: 'active',
  });
};

export const removeHistoryRunner = async (target) => {
  const present = await get(
    target,
    `/flows?fields=id&filter[id][_eq]=${historyRunnerId}`,
  );
  if (present.length > 0) await remove(target, `/flows/${historyRunnerId}`);
};
