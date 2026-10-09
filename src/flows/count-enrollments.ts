import { pagesCheckScript, pagesScript } from './count-enrollments-scripts.js';
import {
  automationId,
  coordinateOperation,
  flowFamilyCodes,
  type FlowTemplate,
  operation,
} from './flow-template.js';
import { matchFlow, matchFlowId } from './match-history-lines.js';
import {
  chainStep,
  type ReleaseBranch,
  releaseSteps,
} from './release-steps.js';
import { flowDescription } from './text-fragments.js';

const family = flowFamilyCodes.automation;

const claimToken = '{{ $trigger.claim }}';

export const dispatcherFlowId = automationId('01');

// The code the dispatcher fails its claim with when a step of its own
// fails.
export const enrollmentsFailureCode = 'ENROLLMENTS_FAILED';

type Failure = Omit<ReleaseBranch, 'family' | 'position' | 'token'> & {
  readonly column: number;
};

const release = ({ column, ...failure }: Failure): ReleaseBranch => ({
  ...failure,
  family,
  position: [column, 19],
  token: claimToken,
});

// Every step that can fail, with the code kept with the claim. A page
// fails the claim itself (MATCH_FAILED), so the check branch here finds
// the claim released and keeps the page's code and message.
const branches = {
  check: release({
    code: enrollmentsFailureCode,
    column: 73,
    message: '{{ pages_ok.message }}',
    stage: 'check',
    suffixes: ['27', '28'],
  }),
  complete: release({
    code: 'COMPLETION_REFUSED',
    column: 91,
    message: '{{ complete.message }}',
    recordCode: '{{ complete.code }}',
    stage: 'complete',
    suffixes: ['29', '2a'],
  }),
  match: release({
    code: enrollmentsFailureCode,
    column: 55,
    message: '{{ match_pages.message }}',
    recordCode: '{{ match_pages.code }}',
    stage: 'match',
    suffixes: ['25', '26'],
  }),
  pages: release({
    code: enrollmentsFailureCode,
    column: 37,
    message: '{{ pages.message }}',
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

// The enrollment count of one claim ({claim, revision}): one plan of the
// history lines in pages of 250, every page serially through "Data / Match
// history lines", then one completion that rebuilds the counted lines and
// every count row at once. The completion refuses until every planned page
// is staged, so a page that did not run never drops its matches. Pages
// never run in parallel, every page and the plan refresh the claim, and
// any failure fails the claim so nothing partial is installed.
export const dispatcherFlow: FlowTemplate = {
  accountability: 'activity',
  description: flowDescription({
    answers: [
      'ok: true',
      'completed',
      'domain',
      'counted',
      'installed',
      'revision',
      'pages',
      'staged',
    ],
    caller: 'Data / Process pending',
    does: `Counts every course and academic year of an enrollments claim: plans the history lines, matches each page through "${matchFlow.name}", completes the claim`,
    failure: {},
    input: ['claim', 'revision'],
  }),
  entry: automationId('11'),
  icon: 'functions',
  id: dispatcherFlowId,
  name: 'Data / Count enrollments',
  operations: [
    chainStep({
      column: 19,
      failure: branches.plan,
      key: 'plan',
      name: 'Plan the history line pages',
      next: '12',
      options: {
        action: 'plan_pages',
        source: 'entries',
        token: claimToken,
      },
      suffix: '11',
      type: coordinateOperation,
    }),
    chainStep({
      column: 37,
      failure: branches.pages,
      key: 'pages',
      name: 'List the planned pages',
      next: '13',
      options: { code: pagesScript },
      suffix: '12',
      type: 'exec',
    }),
    chainStep({
      column: 55,
      failure: branches.match,
      key: 'match_pages',
      name: 'Match every page in turn',
      next: '14',
      options: {
        flow: matchFlowId,
        iterationMode: 'serial',
        payload: '{{ pages }}',
      },
      suffix: '13',
      type: 'trigger',
    }),
    chainStep({
      column: 73,
      failure: branches.check,
      key: 'pages_ok',
      name: 'Check every page answer',
      next: '15',
      options: { code: pagesCheckScript },
      suffix: '14',
      type: 'exec',
    }),
    chainStep({
      column: 91,
      failure: branches.complete,
      key: 'complete',
      name: 'Complete the claim',
      next: '16',
      options: { action: 'complete', token: claimToken },
      suffix: '15',
      type: coordinateOperation,
    }),
    operation({
      family,
      key: 'answer',
      name: 'Answer the installed counts',
      options: {
        json: {
          completed: true,
          counted: '{{ complete.counted }}',
          domain: 'enrollments',
          installed: '{{ complete.installed }}',
          ok: true,
          pages: '{{ pages_ok.pages }}',
          revision: '{{ complete.revision }}',
          staged: '{{ pages_ok.staged }}',
        },
      },
      position: [109, 1],
      suffix: '16',
      type: 'transform',
    }),
    ...Object.values(branches).flatMap((branch) => releaseSteps(branch)),
  ],
  options: { return: '$last' },
  trigger: 'operation',
};
