import {
  familiesCheckScript,
  familiesScript,
} from './count-enrollments-scripts.js';
import {
  automationId,
  coordinateOperation,
  flowFamilyCodes,
  type FlowTemplate,
  operation,
} from './flow-template.js';
import {
  chainStep,
  type ReleaseBranch,
  releaseSteps,
} from './release-steps.js';
import {
  familyFailureCode,
  familyRunnerFlowId,
} from './run-enrollment-family.js';

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

// Every step that can fail, with the code kept with the claim. A family
// fails the claim itself (its runner with its own code, or "Data / Run
// enrollment family" when the runner could not), so the family branch
// here finds the claim released and keeps the family's code and message.
const branches = {
  complete: release({
    code: 'COMPLETION_REFUSED',
    column: 91,
    message: '{{ complete.message }}',
    recordCode: '{{ complete.code }}',
    stage: 'complete',
    suffixes: ['29', '2a'],
  }),
  families: release({
    code: familyFailureCode,
    column: 37,
    message: '{{ families.message }}',
    stage: 'families',
    suffixes: ['23', '24'],
  }),
  family: release({
    code: familyFailureCode,
    column: 73,
    message: '{{ families_ok.message }}',
    stage: 'family',
    suffixes: ['27', '28'],
  }),
  plan: release({
    code: 'PLAN_FAILED',
    column: 19,
    message: '{{ plan.message }}',
    recordCode: '{{ plan.code }}',
    stage: 'plan',
    suffixes: ['21', '22'],
  }),
  run: release({
    code: familyFailureCode,
    column: 55,
    message: '{{ run_families.message }}',
    stage: 'run',
    suffixes: ['25', '26'],
  }),
} as const;

// The enrollment count of one claim ({claim, revision}): one plan of every
// declared rule mode as one family each, every family serially through
// "Data / Run enrollment family" (which runs it through the runner Flow
// the plan names), then one completion that installs every pair at once.
// The completion refuses until every page of every planned family is
// staged, so a family that did not run never drops its rows. No step
// names a rule mode or a runner Flow: declaring or retiring a mode
// (rule-modes.ts) changes the plan, never this graph. Pages never run in
// parallel, the claim is refreshed by every family, pair, page and plan,
// and any failure fails the claim so nothing partial is installed.
export const dispatcherFlow: FlowTemplate = {
  accountability: 'activity',
  description:
    'Counts every enrollment pair under an enrollments claim the caller holds ({claim, revision}): plans every rule mode once (plan_pages source enrollments, one family of pages per mode that has rules), runs the families serially with "Data / Run enrollment family", which hands each to the runner Flow the plan names for its mode, checks every answer, then completes the claim, which installs every pair at once and refuses while any planned page is not staged. Any failure fails the claim with its code and message. Answers {ok: true, completed, domain, installed, revision, pages, families} or {ok: false, stage, code, message}. Called by "Data / Process pending".',
  entry: automationId('11'),
  icon: 'functions',
  id: dispatcherFlowId,
  name: 'Data / Count enrollments',
  operations: [
    chainStep({
      column: 19,
      failure: branches.plan,
      key: 'plan',
      name: 'Plan every rule family',
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
      failure: branches.families,
      key: 'families',
      name: 'List the planned families',
      next: '13',
      options: { code: familiesScript },
      suffix: '12',
      type: 'exec',
    }),
    chainStep({
      column: 55,
      failure: branches.run,
      key: 'run_families',
      name: 'Run every family in turn',
      next: '14',
      options: {
        flow: familyRunnerFlowId,
        iterationMode: 'serial',
        payload: '{{ families }}',
      },
      suffix: '13',
      type: 'trigger',
    }),
    chainStep({
      column: 73,
      failure: branches.family,
      key: 'families_ok',
      name: 'Check every family answer',
      next: '15',
      options: { code: familiesCheckScript },
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
          domain: 'enrollments',
          families: '{{ families_ok.families }}',
          installed: '{{ complete.installed }}',
          ok: true,
          pages: '{{ plan.total }}',
          revision: '{{ complete.revision }}',
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
