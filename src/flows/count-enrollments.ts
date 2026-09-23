import {
  mappedCheckScript,
  mappedPagesScript,
} from './count-enrollments-scripts.js';
import {
  automationId,
  condition,
  coordinateOperation,
  flowFamilyCodes,
  type FlowTemplate,
  operation,
} from './flow-template.js';
import {
  chainStep,
  failStepId,
  type ReleaseBranch,
  releaseSteps,
} from './release-steps.js';
import {
  legacyEnrollmentFlowIds,
  legacyFailureCode,
  mappedEnrollmentFlowIds,
} from './shared.js';

const family = flowFamilyCodes.automation;

const claimToken = '{{ $trigger.claim }}';

export const dispatcherFlowId = automationId('01');

type Failure = Omit<ReleaseBranch, 'family' | 'position' | 'token'> & {
  readonly column: number;
};

const release = ({ column, ...failure }: Failure): ReleaseBranch => ({
  ...failure,
  family,
  position: [column, 19],
  token: claimToken,
});

// Every step that can fail, with the code kept with the claim. The legacy
// parent and its pages fail the claim themselves (fail first), so their
// branches here only record the parent's answer; the fail finds the claim
// released and keeps the child's code and message.
const branches = {
  complete: release({
    code: 'COMPLETION_REFUSED',
    column: 145,
    message: '{{ complete.message }}',
    recordCode: '{{ complete.code }}',
    stage: 'complete',
    suffixes: ['2d', '2e'],
  }),
  count: release({
    code: 'MAPPED_COUNT_FAILED',
    column: 55,
    message: '{{ count_mapped.message }}',
    stage: 'count',
    suffixes: ['25', '26'],
  }),
  heartbeat: release({
    code: 'ENROLLMENTS_FAILED',
    column: 91,
    message: '{{ keep_alive.message }}',
    recordCode: '{{ keep_alive.code }}',
    stage: 'heartbeat',
    suffixes: ['29', '2a'],
  }),
  legacy: release({
    code: legacyFailureCode,
    column: 127,
    message: 'The legacy count answered {{ count_legacy }}',
    stage: 'legacy',
    suffixes: ['2b', '2c'],
  }),
  legacyRun: release({
    code: legacyFailureCode,
    column: 109,
    message: '{{ count_legacy.message }}',
    stage: 'legacy_run',
    suffixes: ['2f', '30'],
  }),
  mapped: release({
    code: 'MAPPED_COUNT_FAILED',
    column: 73,
    message: '{{ mapped_ok.message }}',
    stage: 'mapped',
    suffixes: ['27', '28'],
  }),
  pages: release({
    code: 'ENROLLMENTS_FAILED',
    column: 37,
    message: '{{ mapped_pages.message }}',
    stage: 'pages',
    suffixes: ['23', '24'],
  }),
  plan: release({
    code: 'PLAN_FAILED',
    column: 19,
    message: '{{ plan.message }}',
    recordCode: '{{ plan.code }}',
    stage: 'plan',
    suffixes: ['21', '22'],
  }),
} as const;

// The enrollment count of one claim ({claim, revision}): one plan of both
// rule families, the mapped pages serially through the Task 11 page Flow,
// a heartbeat, the legacy family through the Task 12 parent, then one
// completion that installs every pair at once. Pages never run in
// parallel, the claim is refreshed by every pair, page and plan (at most a
// few seconds apart, far inside the 60 s stale window), and any failure
// fails the claim so nothing partial is installed.
export const dispatcherFlow: FlowTemplate = {
  accountability: 'activity',
  description:
    'Counts every enrollment pair under an enrollments claim the caller holds ({claim, revision}): plans both rule families once (plan_pages source enrollments), runs the mapped pages serially with "Data / Count mapped enrollment page", heartbeats, runs "Data / Count legacy enrollments" (legacy pages and explicit zeros), then completes the claim, which installs every pair at once. Any failure fails the claim with its code and message. Answers {ok: true, completed, domain, installed, revision, pages, mapped, legacy} or {ok: false, stage, code, message}. Called by "Data / Process pending".',
  entry: automationId('11'),
  icon: 'functions',
  id: dispatcherFlowId,
  name: 'Data / Count enrollments',
  operations: [
    chainStep({
      column: 19,
      failure: branches.plan,
      key: 'plan',
      name: 'Plan both rule families',
      next: '12',
      options: {
        action: 'plan_pages',
        source: 'enrollments',
        token: claimToken,
      },
      suffix: '11',
      type: coordinateOperation,
    }),
    chainStep({
      column: 37,
      failure: branches.pages,
      key: 'mapped_pages',
      name: 'List the mapped pages',
      next: '13',
      options: { code: mappedPagesScript },
      suffix: '12',
      type: 'exec',
    }),
    chainStep({
      column: 55,
      failure: branches.count,
      key: 'count_mapped',
      name: 'Count every mapped page in turn',
      next: '14',
      options: {
        flow: mappedEnrollmentFlowIds.page,
        iterationMode: 'serial',
        payload: '{{ mapped_pages }}',
      },
      suffix: '13',
      type: 'trigger',
    }),
    chainStep({
      column: 73,
      failure: branches.mapped,
      key: 'mapped_ok',
      name: 'Check every mapped page answer',
      next: '15',
      options: { code: mappedCheckScript },
      suffix: '14',
      type: 'exec',
    }),
    chainStep({
      column: 91,
      failure: branches.heartbeat,
      key: 'keep_alive',
      name: 'Refresh the claim',
      next: '16',
      options: { action: 'heartbeat', token: claimToken },
      suffix: '15',
      type: coordinateOperation,
    }),
    chainStep({
      column: 109,
      failure: branches.legacyRun,
      key: 'count_legacy',
      name: 'Count the legacy rules',
      next: '17',
      options: {
        flow: legacyEnrollmentFlowIds.parent,
        iterationMode: 'serial',
        payload: { claim: claimToken },
      },
      suffix: '16',
      type: 'trigger',
    }),
    condition({
      edges: {
        reject: failStepId(branches.legacy),
        resolve: automationId('18'),
      },
      family,
      filter: { count_legacy: { ok: { _eq: true } } },
      key: 'legacy_ok',
      name: 'Legacy rules counted?',
      position: [127, 1],
      suffix: '17',
    }),
    chainStep({
      column: 145,
      failure: branches.complete,
      key: 'complete',
      name: 'Complete the claim',
      next: '19',
      options: { action: 'complete', token: claimToken },
      suffix: '18',
      type: coordinateOperation,
    }),
    operation({
      family,
      key: 'answer',
      name: 'Answer the installed counts',
      options: {
        json: {
          completed: true,
          domain: 'enrollments',
          installed: '{{ complete.installed }}',
          legacy: '{{ count_legacy }}',
          mapped: '{{ mapped_ok }}',
          ok: true,
          pages: '{{ plan.total }}',
          revision: '{{ complete.revision }}',
        },
      },
      position: [163, 1],
      suffix: '19',
      type: 'transform',
    }),
    ...Object.values(branches).flatMap((branch) => releaseSteps(branch)),
  ],
  options: { return: '$last' },
  trigger: 'operation',
};
