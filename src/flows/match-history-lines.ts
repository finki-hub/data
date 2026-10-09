import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  coordinateOperation,
  flowFamilyCodes,
  type FlowTemplate,
  matchingId,
  operation,
} from './flow-template.js';
import {
  chainStep,
  type ReleaseBranch,
  releaseSteps,
} from './release-steps.js';
import { pagePlanScript, planQuery } from './shared.js';
import { flowDescription } from './text-fragments.js';

// The Run Script body as a plain file; the template installs its text.
export const matchScriptPath = join(
  import.meta.dirname,
  '..',
  '..',
  'directus',
  'flows',
  'match-history-lines.cjs',
);

const matchScript = await readFile(matchScriptPath, 'utf8');
const family = flowFamilyCodes.matching;
export const matchFlowId = matchingId('01');

// The code a page fails its claim with.
export const matchFailureCode = 'MATCH_FAILED';

const readStep = (collection: string, query: object) => ({
  collection,
  emitEvents: false,
  permissions: '$full',
  query,
});

// The history lines of the checked page: id and label only.
export const pageEntriesQuery = {
  fields: ['id', 'label'],
  filter: {
    id: { _between: ['{{ check_page.from }}', '{{ check_page.to }}'] },
  },
  limit: -1,
  sort: ['id'],
} as const;

// Every pattern mapping, as Studio edits it.
export const mappingsQuery = {
  fields: ['id', 'pattern', 'year_pattern', 'only_in_year'],
  limit: -1,
  sort: ['id'],
} as const;

// Their number, so the matcher refuses a read QUERY_LIMIT_MAX cut short.
export const mappingCountQuery = { aggregate: { count: ['id'] } } as const;

type Failure = Pick<ReleaseBranch, 'recordCode' | 'stage' | 'suffixes'> & {
  readonly column: number;
  readonly source: string;
};

// A failure fails the claim at once (MATCH_FAILED), so every later page of
// the serial run refuses in check_page before it compiles a pattern; a
// claim failed or replaced already answers claim_mismatch there. The record
// answers the failed step's own code (a script's fixed one), its message
// and the page.
const release = ({ column, source, ...failure }: Failure): ReleaseBranch => ({
  ...failure,
  code: matchFailureCode,
  context: { page: '{{ $trigger.token }}' },
  family,
  message: `{{ ${source}.message }}`,
  position: [column, 19],
  recordCode: failure.recordCode ?? `{{ ${source}.code }}`,
  token: '{{ $trigger.claim }}',
});

const branches = {
  entries: release({
    column: 55,
    source: 'read_entries',
    stage: 'entries',
    suffixes: ['2d', '2e'],
  }),
  mapping_count: release({
    column: 73,
    source: 'count_mappings',
    stage: 'mapping_count',
    suffixes: ['2f', '30'],
  }),
  mappings: release({
    column: 91,
    source: 'read_mappings',
    stage: 'mappings',
    suffixes: ['31', '32'],
  }),
  match: release({
    column: 109,
    recordCode: matchFailureCode,
    source: 'match_lines',
    stage: 'match',
    suffixes: ['33', '34'],
  }),
  page: release({
    column: 37,
    recordCode: 'PAGE_PLAN_MISMATCH',
    source: 'check_page',
    stage: 'page',
    suffixes: ['2b', '2c'],
  }),
  plan: release({
    column: 19,
    source: 'read_plan',
    stage: 'plan',
    suffixes: ['29', '2a'],
  }),
  stage: release({
    column: 127,
    source: 'stage_matches',
    stage: 'stage',
    suffixes: ['35', '36'],
  }),
} as const;

// One planned page of history lines under an enrollments claim ({claim,
// token, from, to, rows, revision}), checked against the claim's stored
// plan; its lines, the number of pattern mappings and every mapping read,
// each line matched against each mapping, and the matches staged in one
// stage_page call, which replaces whatever the page staged before.
export const matchFlow: FlowTemplate = {
  accountability: 'activity',
  description: flowDescription({
    answers: ['ok: true', 'page', 'entries', 'mappings', 'staged'],
    caller: 'Data / Count enrollments',
    does: 'Matches one planned page of history lines (at most 250) against every pattern mapping and stages the matches',
    failure: { codes: [matchFailureCode], context: ['page'] },
    input: ['claim', 'token', 'from', 'to', 'rows', 'revision'],
  }),
  entry: matchingId('21'),
  icon: 'manage_search',
  id: matchFlowId,
  name: 'Data / Match history lines',
  operations: [
    chainStep({
      column: 19,
      failure: branches.plan,
      key: 'read_plan',
      name: 'Read the plan of the claim',
      next: '22',
      options: readStep('data_operations', planQuery),
      suffix: '21',
      type: 'item-read',
    }),
    chainStep({
      column: 37,
      failure: branches.page,
      key: 'check_page',
      name: 'Check the page against the plan',
      next: '23',
      options: { code: pagePlanScript },
      suffix: '22',
      type: 'exec',
    }),
    chainStep({
      column: 55,
      failure: branches.entries,
      key: 'read_entries',
      name: 'Read the history lines of the page',
      next: '24',
      options: readStep('moodle_course_entries', pageEntriesQuery),
      suffix: '23',
      type: 'item-read',
    }),
    chainStep({
      column: 73,
      failure: branches.mapping_count,
      key: 'count_mappings',
      name: 'Count the pattern mappings',
      next: '25',
      options: readStep('moodle_pattern_mappings', mappingCountQuery),
      suffix: '24',
      type: 'item-read',
    }),
    chainStep({
      column: 91,
      failure: branches.mappings,
      key: 'read_mappings',
      name: 'Read every pattern mapping',
      next: '26',
      options: readStep('moodle_pattern_mappings', mappingsQuery),
      suffix: '25',
      type: 'item-read',
    }),
    chainStep({
      column: 109,
      failure: branches.match,
      key: 'match_lines',
      name: 'Match every line against every mapping',
      next: '27',
      options: { code: matchScript },
      suffix: '26',
      type: 'exec',
    }),
    chainStep({
      column: 127,
      failure: branches.stage,
      key: 'stage_matches',
      name: 'Stage the matches of the page',
      next: '28',
      options: {
        action: 'stage_page',
        page: '{{ check_page.token }}',
        rows: '{{ match_lines.rows }}',
        token: '{{ check_page.claim }}',
      },
      suffix: '27',
      type: coordinateOperation,
    }),
    operation({
      family,
      key: 'answer',
      name: 'Answer the page summary',
      options: {
        json: {
          entries: '{{ match_lines.entries }}',
          mappings: '{{ match_lines.mappings }}',
          ok: true,
          page: '{{ stage_matches.page }}',
          staged: '{{ stage_matches.staged }}',
        },
      },
      position: [145, 1],
      suffix: '28',
      type: 'transform',
    }),
    ...Object.values(branches).flatMap((branch) => releaseSteps(branch)),
  ],
  options: { return: '$last' },
  trigger: 'operation',
};

// The history line matching family: the one page Flow.
export const matchingFlows: readonly FlowTemplate[] = [matchFlow];
