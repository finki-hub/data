import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { coordinateOperation, type FlowTemplate } from './flow-template.js';
import { legacyPlanQuery, zeroPageCheckScript } from './legacy-scripts.js';
import { failureSteps, readStep } from './legacy-steps.js';
import {
  legacyEnrollmentFlowIds,
  legacyId,
  legacyRuleMode,
  legacyStep as step,
} from './shared.js';

// The Run Script body, kept as a plain file so it can be read and edited
// as JavaScript; the template installs its exact text.
export const sumCountsPath = join(
  import.meta.dirname,
  '..',
  '..',
  'directus',
  'flows',
  'sum-counts.cjs',
);

const sumCounts = await readFile(sumCountsPath, 'utf8');

const zeroRulesQuery = {
  fields: ['id', 'course', 'academic_year'],
  filter: {
    id: { _between: ['{{ check_zeros.from }}', '{{ check_zeros.to }}'] },
    mode: { _eq: legacyRuleMode.mode },
  },
  limit: -1,
  sort: ['id'],
} as const;

// The native aggregate of the partial counts: this claim's candidates of
// the legacy pages of this rule page only, so another claim's rows, a
// mapped page, another rule page and this zero page's own earlier rows
// never enter a sum. A plain single-table query: no join inflates it.
export const legacySumsQuery = {
  aggregate: { sum: ['count'] },
  filter: {
    claim_token: { _eq: '{{ check_zeros.claim }}' },
    page_token: { _in: '{{ check_zeros.cells }}' },
  },
  groupBy: ['course', 'academic_year'],
  limit: -1,
} as const;

// One zero page: after every legacy page of one legacy rule page staged,
// the native sum of exactly those pages names the counted pairs, and every
// other legacy pair of the rule page is staged as an explicit zero.
export const legacyZerosFlow: FlowTemplate = {
  accountability: 'activity',
  description:
    "Fills the explicit zeros of one planned legacy rule page of an enrollments claim. Input {claim, token, from, to, rows, revision}: checks the page against the stored plan and that all of its legacy pages are staged, reads its legacy_regex rules and the native sum(count) grouped by course and academic year over this claim's candidates of those pages only, validates it, and stages a zero row for every rule pair no page counted. Answers {page, rules, counted, zeros, staged}; on any failure it fails the claim at once (LEGACY_COUNT_FAILED) and answers {ok: false, page, stage, code, message}. The completion installs the sums of the staged rows.",
  entry: legacyId('31'),
  icon: 'exposure_zero',
  id: legacyEnrollmentFlowIds.zeros,
  name: 'Data / Fill legacy rule zeros',
  operations: [
    step({
      edges: { reject: legacyId('61'), resolve: legacyId('32') },
      key: 'read_plan',
      name: 'Read the plan of the claim',
      options: readStep('data_operations', legacyPlanQuery),
      position: [19, 1],
      suffix: '31',
      type: 'item-read',
    }),
    step({
      edges: { reject: legacyId('62'), resolve: legacyId('33') },
      key: 'check_zeros',
      name: 'Check the zero page against the plan',
      options: { code: zeroPageCheckScript },
      position: [37, 1],
      suffix: '32',
      type: 'exec',
    }),
    step({
      edges: { reject: legacyId('63'), resolve: legacyId('34') },
      key: 'read_rules',
      name: 'Read the legacy rules of the page',
      options: readStep('course_enrollment_rules', zeroRulesQuery),
      position: [55, 1],
      suffix: '33',
      type: 'item-read',
    }),
    step({
      edges: { reject: legacyId('64'), resolve: legacyId('35') },
      key: 'read_sums',
      name: 'Sum the staged partial counts',
      options: readStep('data_operation_results', legacySumsQuery),
      position: [73, 1],
      suffix: '34',
      type: 'item-read',
    }),
    step({
      edges: { reject: legacyId('65'), resolve: legacyId('36') },
      key: 'sum_counts',
      name: 'Validate the sums and list the zeros',
      options: { code: sumCounts },
      position: [91, 1],
      suffix: '35',
      type: 'exec',
    }),
    step({
      edges: { reject: legacyId('66'), resolve: legacyId('37') },
      key: 'stage_zeros',
      name: 'Stage the explicit zeros',
      options: {
        action: 'stage_page',
        page: '{{ check_zeros.token }}',
        rows: '{{ sum_counts.rows }}',
        token: '{{ check_zeros.claim }}',
      },
      position: [109, 1],
      suffix: '36',
      type: coordinateOperation,
    }),
    step({
      key: 'answer',
      name: 'Answer the zero page summary',
      options: {
        json: {
          counted: '{{ sum_counts.counted }}',
          page: '{{ check_zeros.token }}',
          rules: '{{ sum_counts.rules }}',
          staged: '{{ stage_zeros.staged }}',
          zeros: '{{ sum_counts.zeros }}',
        },
      },
      position: [127, 1],
      suffix: '37',
      type: 'transform',
    }),
    ...failureSteps(19, [
      {
        fail: '61',
        key: 'plan_failed',
        record: '38',
        source: 'read_plan',
        stage: 'plan',
      },
      {
        code: 'PAGE_PLAN_MISMATCH',
        fail: '62',
        key: 'page_failed',
        record: '39',
        source: 'check_zeros',
        stage: 'page',
      },
      {
        fail: '63',
        key: 'rules_failed',
        record: '3a',
        source: 'read_rules',
        stage: 'rules',
      },
      {
        fail: '64',
        key: 'sums_failed',
        record: '3b',
        source: 'read_sums',
        stage: 'sums',
      },
      {
        code: 'ZERO_FILL_FAILED',
        fail: '65',
        key: 'zeros_failed',
        record: '3c',
        source: 'sum_counts',
        stage: 'zeros',
      },
      {
        fail: '66',
        key: 'stage_failed',
        record: '3d',
        source: 'stage_zeros',
        stage: 'stage',
      },
    ]),
  ],
  options: { return: '$last' },
  trigger: 'operation',
};
