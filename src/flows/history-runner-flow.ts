import {
  condition,
  coordinateOperation,
  type FlowTemplate,
  historyId,
  operation,
  raise,
} from './flow-template.js';
import { historyFlowIds } from './history-page-flows.js';
import { describeFailureScript } from './history-script.js';

const claimToken = '{{ claim.token }}';

// The manual entry point on moodle_users: an administrator claims
// history_index, runs "Data / Index Moodle histories" and completes the
// claim at the claimed revision. Only "nothing pending" answers 200 without
// a run; a refused claim, a failed run or a refused completion ends in a
// throw-error whose status and message say why, so Studio never reports a
// run that did not happen as a success.
export const runnerFlow: FlowTemplate = {
  accountability: 'activity',
  description:
    'Rebuilds the Moodle history index (administrators only): claims history_index, runs "Data / Index Moodle histories" and completes the claim at the claimed revision. A page failure marks the run failed and leaves the previous index flagged stale until an explicit retry.',
  entry: historyId('41'),
  icon: 'history_edu',
  id: historyFlowIds.runner,
  name: 'Data / Rebuild Moodle history index',
  operations: [
    // Directus lets any user who may read moodle_users trigger a manual
    // Flow on it; the run itself reads with full permissions and writes
    // the index, so it is gated on the administrator flag.
    condition({
      edges: { reject: historyId('42'), resolve: historyId('31') },
      filter: { $accountability: { admin: { _eq: true } } },
      key: 'admin_only',
      name: 'Administrator?',
      position: [19, 1],
      suffix: '41',
    }),
    raise({
      error: {
        code: 'FORBIDDEN',
        message: 'Only administrators may rebuild the Moodle history index.',
        status: 403,
      },
      key: 'raise_forbidden',
      name: 'Refuse a non-administrator',
      position: [19, 19],
      suffix: '42',
    }),
    operation({
      edges: { resolve: historyId('32') },
      key: 'claim',
      name: 'Claim the history index',
      options: {
        action: 'claim',
        domain: 'history_index',
        retry: '{{ $trigger.body.retry }}',
      },
      position: [37, 1],
      suffix: '31',
      type: coordinateOperation,
    }),
    condition({
      edges: { reject: historyId('43'), resolve: historyId('33') },
      filter: { claim: { claimed: { _eq: true } } },
      key: 'claimed',
      name: 'Claimed?',
      position: [55, 1],
      suffix: '32',
    }),
    condition({
      edges: { reject: historyId('44'), resolve: historyId('37') },
      filter: { claim: { reason: { _eq: 'nothing_pending' } } },
      key: 'up_to_date',
      name: 'Nothing pending?',
      position: [55, 19],
      suffix: '43',
    }),
    operation({
      key: 'not_claimed',
      name: 'Answer that the index is current',
      options: { json: '{{ claim }}' },
      position: [55, 37],
      suffix: '37',
      type: 'transform',
    }),
    condition({
      edges: { reject: historyId('46'), resolve: historyId('45') },
      filter: { claim: { reason: { _eq: 'failed' } } },
      key: 'failed_before',
      name: 'Failed at this revision?',
      position: [73, 19],
      suffix: '44',
    }),
    raise({
      error: {
        code: 'RETRY_REQUIRED',
        message:
          'The last Moodle history index run failed at source revision {{ claim.revision }} ({{ claim.error }}). Fix the cause, then run this Flow again with "Retry a failed run" switched on.',
        status: 409,
      },
      key: 'raise_retry',
      name: 'Ask for an explicit retry',
      position: [73, 37],
      suffix: '45',
    }),
    raise({
      error: {
        code: 'CLAIM_BUSY',
        message:
          'The Moodle history index was not claimed ({{ claim.reason }}): another data operation holds the claim. Run this Flow again once it has finished.',
        status: 409,
      },
      key: 'raise_busy',
      name: 'Report the busy claim',
      position: [73, 55],
      suffix: '46',
    }),
    // The Trigger Flow operation never rejects (an unknown child answers
    // null, a child failure answers a failure record), so the check that
    // follows is the one place a failed run is detected.
    operation({
      edges: { resolve: historyId('34') },
      key: 'index',
      name: 'Index every history page',
      options: {
        flow: historyFlowIds.run,
        iterationMode: 'serial',
        payload: { token: claimToken },
      },
      position: [73, 1],
      suffix: '33',
      type: 'trigger',
    }),
    condition({
      edges: { reject: historyId('38'), resolve: historyId('35') },
      filter: { index: { ok: { _eq: true } } },
      key: 'index_ok',
      name: 'Every page indexed?',
      position: [91, 1],
      suffix: '34',
    }),
    // A refusal of the fail action itself (a foreign owner) ends the chain
    // in reject and surfaces as the coordinator's own error.
    operation({
      edges: { resolve: historyId('47') },
      key: 'fail_run',
      name: 'Mark the run failed',
      options: { action: 'fail', code: 'INDEX_FAILED', token: claimToken },
      position: [91, 19],
      suffix: '38',
      type: coordinateOperation,
    }),
    operation({
      edges: { resolve: historyId('39') },
      key: 'describe_failure',
      name: 'Describe the first failure',
      options: { code: describeFailureScript },
      position: [91, 37],
      suffix: '47',
      type: 'exec',
    }),
    raise({
      error: {
        code: 'INDEX_FAILED',
        message: '{{ describe_failure }}',
        status: 500,
      },
      key: 'raise_failure',
      name: 'Report the failed run',
      position: [91, 55],
      suffix: '39',
    }),
    operation({
      edges: { reject: historyId('40'), resolve: historyId('36') },
      key: 'complete',
      name: 'Complete the claim',
      options: { action: 'complete', token: claimToken },
      position: [109, 1],
      suffix: '35',
      type: coordinateOperation,
    }),
    raise({
      error: {
        code: 'COMPLETION_REFUSED',
        message: '{{ complete.message }}',
        status: 409,
      },
      key: 'raise_completion',
      name: 'Report the refused completion',
      position: [109, 19],
      suffix: '40',
    }),
    operation({
      key: 'finished',
      name: 'Answer the run summary',
      options: {
        json: {
          completed: true,
          index: '{{ index }}',
          revision: '{{ complete.revision }}',
        },
      },
      position: [127, 1],
      suffix: '36',
      type: 'transform',
    }),
  ],
  options: {
    async: false,
    collections: ['moodle_users'],
    confirmationDescription:
      'Rebuild the Moodle course-history index from every raw history? A run that failed at this same source revision is retried only with the switch below.',
    error_on_reject: true,
    fields: [
      {
        field: 'retry',
        meta: { interface: 'boolean', width: 'half' },
        name: 'Retry a failed run',
        type: 'boolean',
      },
    ],
    location: 'collection',
    requireConfirmation: true,
    requireSelection: false,
  },
  trigger: 'manual',
};
