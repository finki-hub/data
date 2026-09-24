import {
  mappedCheckScript,
  mappedPagesScript,
} from './count-enrollments-scripts.js';
import { type FlowTemplate } from './flow-template.js';
import {
  chainStep,
  type ReleaseBranch,
  releaseSteps,
} from './release-steps.js';
import {
  enrollmentFamily,
  enrollmentId,
  mappedEnrollmentFlowIds,
  mappedRuleMode,
  enrollmentStep as step,
} from './shared.js';

// The code a failed mapped family fails its claim with.
const mappedFailureCode = 'MAPPED_COUNT_FAILED';

type Failure = Omit<ReleaseBranch, 'code' | 'family' | 'position' | 'token'> & {
  readonly column: number;
};

const release = ({ column, ...failure }: Failure): ReleaseBranch => ({
  ...failure,
  code: mappedFailureCode,
  family: enrollmentFamily,
  position: [column, 19],
  token: '{{ $trigger.claim }}',
});

// Every step that can fail: the claim is failed at once (its candidates
// are discarded, the installed counts stay, the status keeps the code and
// the step's message), then a failure record answers the dispatcher.
const branches = {
  check: release({
    column: 55,
    message: '{{ check_pages.message }}',
    stage: 'check',
    suffixes: ['39', '3a'],
  }),
  count: release({
    column: 37,
    message: '{{ count_pages.message }}',
    recordCode: '{{ count_pages.code }}',
    stage: 'count',
    suffixes: ['37', '38'],
  }),
  pages: release({
    column: 19,
    message: '{{ mapped_pages.message }}',
    stage: 'pages',
    suffixes: ['35', '36'],
  }),
} as const;

// The runner of the mapped_entries family (rule-modes.ts names it): every
// mapped page of the enrollments plan, serially through the Task 11 page
// Flow, then a check that each staged every planned pair. The dispatcher's
// "Data / Run enrollment family" calls it with the family; the caller
// completes the claim, this Flow never plans or completes.
export const mappedPagesFlow: FlowTemplate = {
  accountability: 'activity',
  description: `Counts the ${mappedRuleMode.mode} family of an enrollments claim. Input {claim, kind, pages, revision, runner} (the family as plan_pages with source "enrollments" planned it): runs "Data / Count mapped enrollment page" for every mapped page in turn and checks that each staged one row per planned rule, zeros included. Answers {ok: true, pages, staged}; the caller completes the claim. Any failure fails the claim (${mappedFailureCode}) so nothing partial is installed, and answers {ok: false, stage, code, message}. Called by "Data / Run enrollment family".`,
  entry: enrollmentId('31'),
  icon: 'functions',
  id: mappedEnrollmentFlowIds.pages,
  name: 'Data / Count mapped enrollment pages',
  operations: [
    chainStep({
      column: 19,
      failure: branches.pages,
      key: 'mapped_pages',
      name: 'List the mapped pages of the family',
      next: '32',
      options: { code: mappedPagesScript },
      suffix: '31',
      type: 'exec',
    }),
    chainStep({
      column: 37,
      failure: branches.count,
      key: 'count_pages',
      name: 'Count every mapped page in turn',
      next: '33',
      options: {
        flow: mappedEnrollmentFlowIds.page,
        iterationMode: 'serial',
        payload: '{{ mapped_pages }}',
      },
      suffix: '32',
      type: 'trigger',
    }),
    chainStep({
      column: 55,
      failure: branches.check,
      key: 'check_pages',
      name: 'Check every mapped page answer',
      next: '34',
      options: { code: mappedCheckScript },
      suffix: '33',
      type: 'exec',
    }),
    step({
      key: 'answer',
      name: 'Answer the mapped summary',
      options: {
        json: {
          ok: true,
          pages: '{{ check_pages.pages }}',
          staged: '{{ check_pages.staged }}',
        },
      },
      position: [73, 1],
      suffix: '34',
      type: 'transform',
    }),
    ...Object.values(branches).flatMap((branch) => releaseSteps(branch)),
  ],
  options: { return: '$last' },
  trigger: 'operation',
};
