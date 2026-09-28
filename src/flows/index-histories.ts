import {
  condition,
  coordinateOperation,
  flowFamilyCodes,
  type FlowTemplate,
  historyId,
} from './flow-template.js';
import {
  historyFlowIds,
  pageFlow,
  runFlow,
  historyStep as step,
} from './history-page-flows.js';
import { describeFailureScript } from './history-script.js';
import {
  failStepId,
  type ReleaseBranch,
  releaseSteps,
} from './release-steps.js';

const claimToken = '{{ $trigger.claim }}';

const branch = (
  spec: Omit<ReleaseBranch, 'family' | 'token'>,
): ReleaseBranch => ({
  ...spec,
  family: flowFamilyCodes.history,
  token: claimToken,
});

// Every way the refresh can fail: the page run itself (the Trigger Flow
// step rejected), a page that failed (the described summary), the
// description script, and a refused completion (a source or graph change
// during the run, which the coordinator released already, or pages
// missing).
const crashed = branch({
  code: 'INDEX_FAILED',
  message: '{{ index.message }}',
  position: [19, 19],
  stage: 'run',
  suffixes: ['5a', '5b'],
});
const failed = branch({
  code: 'INDEX_FAILED',
  message: '{{ describe }}',
  position: [37, 37],
  stage: 'index',
  suffixes: ['54', '55'],
});
const undescribed = branch({
  code: 'INDEX_FAILED',
  message: '{{ describe.message }}',
  position: [55, 37],
  stage: 'describe',
  suffixes: ['58', '59'],
});
const refused = branch({
  code: 'COMPLETION_REFUSED',
  message: '{{ complete.message }}',
  position: [73, 19],
  recordCode: '{{ complete.code }}',
  stage: 'complete',
  suffixes: ['56', '57'],
});

// The history index run of one claim ({claim}): indexes every planned page
// serially through "Data / Index Moodle histories" and completes the claim
// at the claimed revision, or fails it with the first failure described
// (page, stage, refusal, the Moodle user it names). It never claims: the
// scheduled Process pending does, and Mark pending asks for a run.
const refreshFlow: FlowTemplate = {
  accountability: 'activity',
  description:
    'Refreshes the Moodle history index under a history_index claim the caller holds ({claim}): runs "Data / Index Moodle histories" (every planned page serially), then completes the claim, or fails it (INDEX_FAILED, COMPLETION_REFUSED) with the first failure described so the status shows why. Answers {ok: true, completed, domain, index, revision} or {ok: false, stage, code, message}. Called by "Data / Process pending".',
  entry: historyId('51'),
  icon: 'history_edu',
  id: historyFlowIds.refresh,
  name: 'Data / Refresh history index',
  operations: [
    // The Trigger Flow step never rejects for a failed child (an unknown
    // child answers null, a failed page a record), so the condition after
    // it is where a failed run is detected.
    step({
      edges: { reject: failStepId(crashed), resolve: historyId('52') },
      key: 'index',
      name: 'Index every history page',
      options: {
        flow: historyFlowIds.run,
        iterationMode: 'serial',
        payload: { token: claimToken },
      },
      position: [19, 1],
      suffix: '51',
      type: 'trigger',
    }),
    condition({
      edges: { reject: historyId('53'), resolve: historyId('5c') },
      family: flowFamilyCodes.history,
      filter: { index: { ok: { _eq: true } } },
      key: 'index_ok',
      name: 'Every page indexed?',
      position: [37, 1],
      suffix: '52',
    }),
    step({
      edges: { reject: failStepId(undescribed), resolve: failStepId(failed) },
      key: 'describe',
      name: 'Describe the first failure',
      options: { code: describeFailureScript },
      position: [37, 19],
      suffix: '53',
      type: 'exec',
    }),
    step({
      edges: { reject: failStepId(refused), resolve: historyId('5d') },
      key: 'complete',
      name: 'Complete the claim',
      options: { action: 'complete', token: claimToken },
      position: [55, 1],
      suffix: '5c',
      type: coordinateOperation,
    }),
    step({
      key: 'answer',
      name: 'Answer the refreshed index',
      options: {
        json: {
          completed: true,
          domain: 'history_index',
          index: '{{ index }}',
          ok: true,
          revision: '{{ complete.revision }}',
        },
      },
      position: [73, 1],
      suffix: '5d',
      type: 'transform',
    }),
    ...[crashed, failed, undescribed, refused].flatMap((entry) =>
      releaseSteps(entry),
    ),
  ],
  options: { return: '$last' },
  trigger: 'operation',
};

// The Moodle history index Flows in installation order: the page Flow
// before the run Flow that calls it, the claim-bound refresh last.
export const historyIndexFlows: readonly FlowTemplate[] = [
  pageFlow,
  runFlow,
  refreshFlow,
];
