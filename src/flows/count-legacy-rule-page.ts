import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { coordinateOperation, type FlowTemplate } from './flow-template.js';
import { legacyPageCheckScript, legacyPlanQuery } from './legacy-scripts.js';
import { failureSteps, readStep } from './legacy-steps.js';
import {
  legacyEnrollmentFlowIds,
  legacyFailureCode,
  legacyId,
  legacyRuleMode,
  legacyStep as step,
} from './shared.js';

// The Run Script body, kept as a plain file so it can be read and edited
// as JavaScript; the template installs its exact text.
export const countHistoryPagePath = join(
  import.meta.dirname,
  '..',
  '..',
  'directus',
  'flows',
  'count-history-page.cjs',
);

const countHistoryPage = await readFile(countHistoryPagePath, 'utf8');

// The legacy_regex rules of the checked rule range: the pattern text as
// Studio edits it, nothing the coordinator interprets.
export const legacyRulesQuery = {
  fields: ['id', 'course', 'academic_year', 'pattern'],
  filter: {
    id: {
      _between: ['{{ check_page.rules.from }}', '{{ check_page.rules.to }}'],
    },
    mode: { _eq: legacyRuleMode.mode },
  },
  limit: -1,
  sort: ['id'],
} as const;

// The id and raw history of every Moodle user of the checked history
// range; no name, address or profile is read.
export const legacyUsersQuery = {
  fields: ['id', 'Courses'],
  filter: {
    id: {
      _between: ['{{ check_page.users.from }}', '{{ check_page.users.to }}'],
    },
  },
  limit: -1,
  sort: ['id'],
} as const;

// One legacy page: a planned history page crossed with a planned legacy
// rule page. Checked against the stored plan, then the bounded rule page
// and user page are read, counted in one Run Script and staged at once.
export const legacyPageFlow: FlowTemplate = {
  accountability: 'activity',
  description:
    'Counts one planned legacy page of an enrollments claim: at most 250 Moodle users (id and raw Courses, at most 800,000 UTF-8 bytes) against at most 500 legacy_regex rules (at most 1,000,000 UTF-8 bytes of pattern). Input {claim, token, from, to, rows, bytes, rules, revision}: checks the page against the stored plan, reads the rules and users of its ranges, compiles each pattern with the u flag, tests each user once per rule, and stages the nonzero partial counts with stage_page. Answers {page, users, rules, staged}. On any failure it fails the claim at once (LEGACY_COUNT_FAILED), so the later pages of the run refuse without counting, and answers {ok: false, page, stage, code, message} with nothing staged. Called serially by "Data / Count legacy enrollments".',
  entry: legacyId('21'),
  icon: 'rule',
  id: legacyEnrollmentFlowIds.page,
  name: 'Data / Count legacy rules page',
  operations: [
    step({
      edges: { reject: legacyId('51'), resolve: legacyId('22') },
      key: 'read_plan',
      name: 'Read the plan of the claim',
      options: readStep('data_operations', legacyPlanQuery),
      position: [19, 1],
      suffix: '21',
      type: 'item-read',
    }),
    step({
      edges: { reject: legacyId('52'), resolve: legacyId('23') },
      key: 'check_page',
      name: 'Check the page against the plan',
      options: { code: legacyPageCheckScript },
      position: [37, 1],
      suffix: '22',
      type: 'exec',
    }),
    step({
      edges: { reject: legacyId('53'), resolve: legacyId('24') },
      key: 'read_rules',
      name: 'Read the legacy rules of the page',
      options: readStep('course_enrollment_rules', legacyRulesQuery),
      position: [55, 1],
      suffix: '23',
      type: 'item-read',
    }),
    step({
      edges: { reject: legacyId('54'), resolve: legacyId('25') },
      key: 'read_users',
      name: 'Read the histories of the page',
      options: readStep('moodle_users', legacyUsersQuery),
      position: [73, 1],
      suffix: '24',
      type: 'item-read',
    }),
    step({
      edges: { reject: legacyId('55'), resolve: legacyId('26') },
      key: 'count_page',
      name: 'Count every rule once per user',
      options: { code: countHistoryPage },
      position: [91, 1],
      suffix: '25',
      type: 'exec',
    }),
    step({
      edges: { reject: legacyId('56'), resolve: legacyId('27') },
      key: 'stage_counts',
      name: 'Stage the partial counts of the page',
      options: {
        action: 'stage_page',
        page: '{{ check_page.token }}',
        rows: '{{ count_page.rows }}',
        token: '{{ check_page.claim }}',
      },
      position: [109, 1],
      suffix: '26',
      type: coordinateOperation,
    }),
    step({
      key: 'answer',
      name: 'Answer the page summary',
      options: {
        json: {
          page: '{{ check_page.token }}',
          rules: '{{ count_page.rules }}',
          staged: '{{ stage_counts.staged }}',
          users: '{{ count_page.users }}',
        },
      },
      position: [127, 1],
      suffix: '27',
      type: 'transform',
    }),
    ...failureSteps(19, [
      {
        fail: '51',
        key: 'plan_failed',
        record: '28',
        source: 'read_plan',
        stage: 'plan',
      },
      {
        code: 'PAGE_PLAN_MISMATCH',
        fail: '52',
        key: 'page_failed',
        record: '29',
        source: 'check_page',
        stage: 'page',
      },
      {
        fail: '53',
        key: 'rules_failed',
        record: '2a',
        source: 'read_rules',
        stage: 'rules',
      },
      {
        fail: '54',
        key: 'users_failed',
        record: '2b',
        source: 'read_users',
        stage: 'users',
      },
      {
        code: legacyFailureCode,
        fail: '55',
        key: 'count_failed',
        record: '2c',
        source: 'count_page',
        stage: 'count',
      },
      {
        fail: '56',
        key: 'stage_failed',
        record: '2d',
        source: 'stage_counts',
        stage: 'stage',
      },
    ]),
  ],
  options: { return: '$last' },
  trigger: 'operation',
};
