import { legacyPageFlow } from './count-legacy-rule-page.js';
import { legacyZerosFlow } from './fill-legacy-zeros.js';
import { type FlowTemplate } from './flow-template.js';
import {
  legacyPagesCheckScript,
  legacyPagesScript,
  legacyPlanQuery,
  zeroPagesCheckScript,
} from './legacy-scripts.js';
import { failureSteps } from './legacy-steps.js';
import {
  legacyEnrollmentFlowIds,
  legacyFailureCode,
  legacyId,
  legacyRuleMode,
  legacyStep as step,
} from './shared.js';
import { flowDescription } from './text-fragments.js';

type Stage = {
  // The failure record's code: the step's own code or a fixed one.
  readonly code: string;
  readonly key: string;
  readonly stage: string;
  // Suffixes of the fail step and of the record after it.
  readonly suffixes: readonly [string, string];
};

// The main steps whose rejection fails the claim, in flow order.
const stages: readonly Stage[] = [
  {
    code: '{{ read_plan.code }}',
    key: 'read_plan',
    stage: 'plan',
    suffixes: ['41', '42'],
  },
  {
    code: 'LEGACY_PLAN_MISMATCH',
    key: 'legacy_pages',
    stage: 'pages',
    suffixes: ['43', '44'],
  },
  {
    code: '{{ count_pages.code }}',
    key: 'count_pages',
    stage: 'count',
    suffixes: ['45', '46'],
  },
  {
    code: legacyFailureCode,
    key: 'check_pages',
    stage: 'legacy',
    suffixes: ['47', '48'],
  },
  {
    code: '{{ fill_zeros.code }}',
    key: 'fill_zeros',
    stage: 'zeros',
    suffixes: ['49', '4a'],
  },
  {
    code: 'LEGACY_ZEROS_FAILED',
    key: 'check_fills',
    stage: 'fills',
    suffixes: ['4b', '4c'],
  },
];

// A rejected step fails the claim (the coordinator discards its staged
// candidates, the installed counts stay, status shows the code) and then
// answers a failure record carrying the step's own message.
const failures = failureSteps(
  19,
  stages.map(({ code, key, stage, suffixes }) => ({
    code,
    fail: suffixes[0],
    key: `${stage}_failed`,
    record: suffixes[1],
    source: key,
    stage,
  })),
  {},
);

const rejectOf = (key: string): string =>
  legacyId(stages.find((entry) => entry.key === key)?.suffixes[0] ?? '');

// The runner of the legacy_regex family (rule-modes.ts names it) of an
// enrollments claim whose plan (plan_pages with source enrollments) the
// caller made: every legacy page serially, then every zero page serially,
// both listed from the stored plan. The staged rows of both, with the
// other families', are installed by the claim's completion, which the
// caller runs; this Flow never plans (a new plan would discard the other
// families' pages).
export const legacyParentFlow: FlowTemplate = {
  accountability: 'activity',
  description: flowDescription({
    answers: [
      'ok: true',
      'legacyPages',
      'staged',
      'zeroPages',
      'pairs',
      'counted',
      'zeros',
    ],
    caller: 'Data / Run enrollment family',
    does: `Counts the ${legacyRuleMode.mode} family of an enrollments claim: every legacy page through "${legacyPageFlow.name}", then every zero page through "${legacyZerosFlow.name}", serially`,
    failure: { codes: [legacyFailureCode] },
    input: ['claim', 'kind', 'pages', 'revision', 'runner'],
  }),
  entry: legacyId('11'),
  icon: 'rule_settings',
  id: legacyEnrollmentFlowIds.parent,
  name: 'Data / Count legacy enrollments',
  operations: [
    step({
      edges: { reject: rejectOf('read_plan'), resolve: legacyId('12') },
      key: 'read_plan',
      name: 'Read the enrollments plan',
      options: {
        collection: 'data_operations',
        emitEvents: false,
        permissions: '$full',
        query: legacyPlanQuery,
      },
      position: [19, 1],
      suffix: '11',
      type: 'item-read',
    }),
    step({
      edges: { reject: rejectOf('legacy_pages'), resolve: legacyId('13') },
      key: 'legacy_pages',
      name: 'List the legacy and zero pages',
      options: { code: legacyPagesScript },
      position: [37, 1],
      suffix: '12',
      type: 'exec',
    }),
    step({
      edges: { reject: rejectOf('count_pages'), resolve: legacyId('14') },
      key: 'count_pages',
      name: 'Count every legacy page in turn',
      options: {
        flow: legacyEnrollmentFlowIds.page,
        iterationMode: 'serial',
        payload: '{{ legacy_pages.cells }}',
      },
      position: [55, 1],
      suffix: '13',
      type: 'trigger',
    }),
    step({
      edges: { reject: rejectOf('check_pages'), resolve: legacyId('15') },
      key: 'check_pages',
      name: 'Check every legacy page answer',
      options: { code: legacyPagesCheckScript },
      position: [73, 1],
      suffix: '14',
      type: 'exec',
    }),
    step({
      edges: { reject: rejectOf('fill_zeros'), resolve: legacyId('16') },
      key: 'fill_zeros',
      name: 'Fill the zeros of every rule page in turn',
      options: {
        flow: legacyEnrollmentFlowIds.zeros,
        iterationMode: 'serial',
        payload: '{{ legacy_pages.zeros }}',
      },
      position: [91, 1],
      suffix: '15',
      type: 'trigger',
    }),
    step({
      edges: { reject: rejectOf('check_fills'), resolve: legacyId('17') },
      key: 'check_fills',
      name: 'Check every zero page answer',
      options: { code: zeroPagesCheckScript },
      position: [109, 1],
      suffix: '16',
      type: 'exec',
    }),
    step({
      key: 'answer',
      name: 'Answer the legacy summary',
      options: {
        json: {
          counted: '{{ check_fills.counted }}',
          legacyPages: '{{ check_pages.pages }}',
          ok: true,
          pairs: '{{ check_fills.pairs }}',
          staged: '{{ check_pages.staged }}',
          zeroPages: '{{ check_fills.pages }}',
          zeros: '{{ check_fills.zeros }}',
        },
      },
      position: [127, 1],
      suffix: '17',
      type: 'transform',
    }),
    ...failures,
  ],
  options: { return: '$last' },
  trigger: 'operation',
};

// The children before the parent that calls them.
export const legacyEnrollmentFlows: readonly FlowTemplate[] = [
  legacyPageFlow,
  legacyZerosFlow,
  legacyParentFlow,
];
