import {
  coordinateOperation,
  failureRecord,
  familyStep,
  flowFamilyCodes,
  type FlowTemplate,
  historyId,
} from './flow-template.js';
import {
  pagesWithTokenScript,
  splitEntriesScript,
  summaryScript,
} from './history-script.js';

const triggerToken = '{{ $trigger.token }}';

// An operation of the history index family.
export const historyStep = familyStep(flowFamilyCodes.history);

// The history index family (`03` is unused): the scheduled Process
// pending claims the index and runs the refresh Flow (`04`), and Mark
// pending is the manual path.
export const historyFlowIds = {
  page: historyId('02'),
  refresh: historyId('04'),
  run: historyId('01'),
} as const;

// A Directus Flow is a tree: every operation is the resolve or reject
// target of at most one other operation (both columns are unique), so each
// step that can fail gets a failure record of its own.

// One planned range of Moodle users: the claim is checked (and its
// heartbeat refreshed) first, so a page left over after its run was
// overtaken or failed stops before it reads anything; then native Read
// Data selects only id and Courses, a small script splits the exact
// entries and the narrow index writer replaces the memberships of those
// users inside one transaction. Any failure answers a failure record
// instead of a result.
export const pageFlow: FlowTemplate = {
  accountability: 'activity',
  description:
    'Indexes one planned range of Moodle users: checks that its claim is still live, reads id and Courses, splits the exact history entries and replaces the memberships of those users. Called serially by "Data / Index Moodle histories".',
  entry: historyId('27'),
  icon: 'history_edu',
  id: historyFlowIds.page,
  name: 'Data / Index history page',
  operations: [
    historyStep({
      edges: { reject: historyId('28'), resolve: historyId('21') },
      key: 'check_claim',
      name: 'Check that the claim is still live',
      options: { action: 'heartbeat', token: '{{ $trigger.claim }}' },
      position: [1, 1],
      suffix: '27',
      type: coordinateOperation,
    }),
    historyStep({
      key: 'claim_failed',
      name: 'Record the lost claim',
      options: failureRecord({ page: triggerToken, stage: 'claim' }),
      position: [1, 19],
      suffix: '28',
      type: 'transform',
    }),
    historyStep({
      edges: { reject: historyId('24'), resolve: historyId('22') },
      key: 'read_histories',
      name: 'Read raw histories of the page',
      options: {
        collection: 'moodle_users',
        emitEvents: false,
        permissions: '$full',
        query: {
          fields: ['id', 'Courses'],
          filter: {
            id: { _between: ['{{ $trigger.from }}', '{{ $trigger.to }}'] },
          },
          limit: -1,
          sort: ['id'],
        },
      },
      position: [19, 1],
      suffix: '21',
      type: 'item-read',
    }),
    historyStep({
      edges: { reject: historyId('25'), resolve: historyId('23') },
      key: 'split_entries',
      name: 'Split exact history entries',
      options: { code: splitEntriesScript },
      position: [37, 1],
      suffix: '22',
      type: 'exec',
    }),
    historyStep({
      edges: { reject: historyId('26') },
      key: 'index_page',
      name: 'Replace the memberships of the page',
      options: {
        action: 'index_page',
        page: triggerToken,
        rows: '{{ split_entries }}',
        token: '{{ $trigger.claim }}',
      },
      position: [55, 1],
      suffix: '23',
      type: coordinateOperation,
    }),
    historyStep({
      key: 'read_failed',
      name: 'Record the read failure',
      options: failureRecord({ page: triggerToken, stage: 'read' }),
      position: [19, 19],
      suffix: '24',
      type: 'transform',
    }),
    historyStep({
      key: 'split_failed',
      name: 'Record the split failure',
      options: failureRecord({ page: triggerToken, stage: 'split' }),
      position: [37, 19],
      suffix: '25',
      type: 'transform',
    }),
    historyStep({
      key: 'index_failed',
      name: 'Record the index failure',
      options: failureRecord({ page: triggerToken, stage: 'index' }),
      position: [55, 19],
      suffix: '26',
      type: 'transform',
    }),
  ],
  options: { return: '$last' },
  trigger: 'operation',
};

// The run over one claim ({ token }): plan the pages at the claimed
// revision, index them serially inside the same run, sum the results. The
// claim, its completion and its failure belong to the caller.
export const runFlow: FlowTemplate = {
  accountability: 'activity',
  description:
    'Plans the Moodle history pages of a claim ({ token }) and indexes them serially with "Data / Index history page"; answers a summary with ok, pages, users, entriesCreated, membershipsWritten and the failed pages. Claim, completion and failure belong to the caller.',
  entry: historyId('11'),
  icon: 'history_edu',
  id: historyFlowIds.run,
  name: 'Data / Index Moodle histories',
  operations: [
    historyStep({
      edges: { reject: historyId('15'), resolve: historyId('12') },
      key: 'plan_pages',
      name: 'Plan history pages',
      options: {
        action: 'plan_pages',
        source: 'history',
        token: triggerToken,
      },
      position: [19, 1],
      suffix: '11',
      type: coordinateOperation,
    }),
    historyStep({
      edges: { reject: historyId('16'), resolve: historyId('13') },
      key: 'with_token',
      name: 'Attach the claim token to every page',
      options: { code: pagesWithTokenScript },
      position: [37, 1],
      suffix: '12',
      type: 'exec',
    }),
    historyStep({
      edges: { reject: historyId('17'), resolve: historyId('14') },
      key: 'index_pages',
      name: 'Index every page in turn',
      options: {
        flow: historyFlowIds.page,
        iterationMode: 'serial',
        payload: '{{ with_token }}',
      },
      position: [55, 1],
      suffix: '13',
      type: 'trigger',
    }),
    historyStep({
      key: 'summary',
      name: 'Sum the page results',
      options: { code: summaryScript },
      position: [73, 1],
      suffix: '14',
      type: 'exec',
    }),
    historyStep({
      key: 'plan_failed',
      name: 'Record the planning failure',
      options: failureRecord({ pages: '0', stage: 'plan' }),
      position: [19, 19],
      suffix: '15',
      type: 'transform',
    }),
    historyStep({
      key: 'token_failed',
      name: 'Record the token failure',
      options: failureRecord({ pages: '0', stage: 'token' }),
      position: [37, 19],
      suffix: '16',
      type: 'transform',
    }),
    historyStep({
      key: 'pages_failed',
      name: 'Record the page-run failure',
      options: failureRecord({ pages: '0', stage: 'pages' }),
      position: [55, 19],
      suffix: '17',
      type: 'transform',
    }),
  ],
  options: { return: '$last' },
  trigger: 'operation',
};
